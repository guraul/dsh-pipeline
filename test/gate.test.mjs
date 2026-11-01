import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_TTL_MS, evaluateGate } from '../lib/gate.mjs'
import { MAX_ROUND, PACKAGE_VERSION, SCHEMA_VERSION } from '../lib/record.mjs'

const SHA = 'a'.repeat(40)
const NOW = new Date('2026-11-01T12:00:00Z')

function base(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: PACKAGE_VERSION,
    pr: 12,
    round: 2,
    verdict: 'APPROVE',
    head_sha: SHA,
    findings: [],
    evidence: ['review: https://example.test/run/1'],
    policy: { hit: false, reasons: [] },
    createdAt: '2026-11-01T11:00:00.000Z',
    ...overrides,
  }
}

/** 只传必要输入，其余走默认，避免用例之间互相干扰。 */
function gate(overrides = {}, input = {}) {
  return evaluateGate({
    record: base(overrides),
    headSha: SHA,
    currentPolicyVersion: PACKAGE_VERSION,
    now: NOW,
    ...input,
  })
}

const reasonHas = (result, ...needles) => {
  for (const needle of needles) {
    assert.ok(result.reason.includes(needle), `reason 应包含 ${needle}: ${result.reason}`)
  }
}

test('记录缺失或不可解析 → E_RECORD', () => {
  for (const record of [undefined, null, 42, 'not json', '[]', []]) {
    const result = evaluateGate({ record, headSha: SHA, currentPolicyVersion: PACKAGE_VERSION, now: NOW })
    assert.equal(result.ok, false, `record=${String(record)}`)
    assert.equal(result.code, 'E_RECORD')
  }
})

test('结构版本不认识 → E_SCHEMA（缺少 schemaVersion 仍按 E_RECORD）', () => {
  assert.equal(gate({ schemaVersion: 99 }).code, 'E_SCHEMA')
  assert.equal(gate({ schemaVersion: 2 }).code, 'E_SCHEMA')
  assert.equal(gate({ schemaVersion: undefined }).code, 'E_RECORD')
})

test('round 超出 1..3 → E_RECORD', () => {
  for (const round of [0, MAX_ROUND + 1, 4, 1.5, '2', undefined]) {
    const result = gate({ round })
    assert.equal(result.ok, false, `round=${String(round)}`)
    assert.equal(result.code, 'E_RECORD')
  }
})

test('verdict 不是 APPROVE → E_VERDICT，reason 带 verdict 与 errorCode', () => {
  const result = gate({ verdict: 'REJECT', errorCode: 'E_PARSE' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_VERDICT')
  reasonHas(result, 'REJECT', 'E_PARSE')

  const noCode = gate({ verdict: 'ESCALATE' })
  assert.equal(noCode.code, 'E_VERDICT')
  reasonHas(noCode, 'ESCALATE', '无错误码')
})

test('headSha 与记录不一致 → E_SHA_MISMATCH', () => {
  const result = gate({}, { headSha: 'b'.repeat(40) })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_SHA_MISMATCH')
  reasonHas(result, SHA, 'b'.repeat(40))
})

test('超过 ttlMs → E_EXPIRED（默认 24h，可用参数覆盖）', () => {
  const stale = gate({ createdAt: '2026-10-30T12:00:00.000Z' })
  assert.equal(stale.ok, false)
  assert.equal(stale.code, 'E_EXPIRED')

  // 刚过期 1ms 也算过期。
  const justOver = gate({ createdAt: new Date(NOW.getTime() - DEFAULT_TTL_MS - 1).toISOString() })
  assert.equal(justOver.code, 'E_EXPIRED')

  // 自定义 ttl 更短时提前过期。
  const shortTtl = gate(
    { createdAt: '2026-11-01T11:30:00.000Z' },
    { ttlMs: 10 * 60 * 1000 },
  )
  assert.equal(shortTtl.code, 'E_EXPIRED')
})

test('record.policy.hit 为真 → E_POLICY，reason 列出命中路径', () => {
  const result = gate({
    policy: {
      hit: true,
      reasons: ['.github/workflows/ci.yml: 改 CI 本身', 'package.json: 依赖变更（供应链风险）'],
    },
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_POLICY')
  reasonHas(result, '.github/workflows/ci.yml', 'package.json')
})

test('policyVersion 与当前版本不一致 → E_POLICY_VERSION，reason 说明两者', () => {
  const result = gate({}, { currentPolicyVersion: '0.2.0' })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_POLICY_VERSION')
  reasonHas(result, PACKAGE_VERSION, '0.2.0')
})

test('全部通过 → { ok: true }', () => {
  assert.deepEqual(gate(), { ok: true })
})

test('判定顺序固定：结论先于 SHA，结构先于轮次，时效先于策略', () => {
  assert.equal(gate({ verdict: 'REJECT', head_sha: 'c'.repeat(40) }).code, 'E_VERDICT')
  assert.equal(gate({ schemaVersion: 99, round: 0 }).code, 'E_SCHEMA')
  assert.equal(
    gate({ createdAt: '2026-10-30T12:00:00.000Z', policy: { hit: true, reasons: ['x: y'] } }).code,
    'E_EXPIRED',
  )
})

test('纯函数：同一输入重复调用结果一致，不依赖真实时钟', () => {
  const input = {
    record: base(),
    headSha: SHA,
    currentPolicyVersion: PACKAGE_VERSION,
    now: NOW,
  }
  assert.deepEqual(evaluateGate(input), evaluateGate(input))
  // createdAt 在未来也不应被「当前时间」干扰：now 由参数决定。
  const future = gate({ createdAt: '2026-11-01T11:59:59.000Z' }, { now: NOW })
  assert.deepEqual(future, { ok: true })
})
