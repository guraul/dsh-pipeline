import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_ROUND,
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  readRecord,
  recordFile,
  reviewsDir,
  writeRecord,
  writeSkipAudit,
} from '../lib/record.mjs'

const SHA = 'a'.repeat(40)

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-pipeline-'))
}

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
    ...overrides,
  }
}

const code = (expected) => (error) => {
  assert.equal(error.code, expected)
  return true
}

test('reviewsDir 固定落在 <root>/.dsh-web/reviews', () => {
  assert.equal(reviewsDir('/repo'), join('/repo', '.dsh-web', 'reviews'))
  assert.equal(reviewsDir('/repo'), '/repo/.dsh-web/reviews')
})

test('writeRecord / readRecord 往返，文件名是 <pr>-<sha>.json', () => {
  const dir = reviewsDir(tmp())
  const record = base()
  const file = writeRecord(dir, record)
  assert.equal(file, recordFile(dir, 12, SHA))
  assert.ok(file.endsWith(`/12-${SHA}.json`))
  assert.deepEqual(readRecord(file), record)
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.policyVersion, PACKAGE_VERSION)
  assert.equal(onDisk.schemaVersion, SCHEMA_VERSION)
})

test('writeRecord 补齐 schemaVersion / policyVersion 默认值', () => {
  const dir = reviewsDir(tmp())
  const { schemaVersion, policyVersion, ...rest } = base()
  assert.equal(schemaVersion, SCHEMA_VERSION)
  assert.equal(policyVersion, PACKAGE_VERSION)
  const file = writeRecord(dir, rest)
  const loaded = readRecord(file)
  assert.equal(loaded.schemaVersion, SCHEMA_VERSION)
  assert.equal(loaded.policyVersion, PACKAGE_VERSION)
})

test('缺字段时 readRecord 抛 E_RECORD', () => {
  const dir = tmp()
  const file = join(dir, `12-${SHA}.json`)
  const { verdict, ...missingVerdict } = base()
  assert.equal(verdict, 'APPROVE')
  writeFileSync(file, JSON.stringify(missingVerdict), 'utf8')
  assert.throws(() => readRecord(file), code('E_RECORD'))

  const { schemaVersion, ...missingSchema } = base()
  assert.equal(schemaVersion, SCHEMA_VERSION)
  writeFileSync(file, JSON.stringify(missingSchema), 'utf8')
  assert.throws(() => readRecord(file), code('E_RECORD'))
})

test('结构版本不认识时抛 E_SCHEMA', () => {
  const dir = tmp()
  const file = join(dir, `12-${SHA}.json`)
  writeFileSync(file, JSON.stringify(base({ schemaVersion: 99 })), 'utf8')
  assert.throws(() => readRecord(file), code('E_SCHEMA'))
  assert.throws(() => writeRecord(dir, base({ schemaVersion: 2 })), code('E_SCHEMA'))
})

test('round 越界（0 / 4 / 非整数）时读写都拒绝', () => {
  const dir = reviewsDir(tmp())
  for (const round of [0, MAX_ROUND + 1, 4, 1.5, '2']) {
    assert.throws(() => writeRecord(dir, base({ round })), code('E_RECORD'), `round=${round}`)
  }
  for (const round of [1, 2, 3]) {
    assert.doesNotThrow(() => writeRecord(dir, base({ round })))
  }
})

test('verdict / head_sha / findings / evidence 结构校验', () => {
  const dir = reviewsDir(tmp())
  assert.throws(() => writeRecord(dir, base({ verdict: 'LGTM' })), code('E_RECORD'))
  assert.throws(() => writeRecord(dir, base({ head_sha: 'abc' })), code('E_RECORD'))
  assert.throws(
    () => writeRecord(dir, base({ findings: [{ severity: 'huge', file: 'a', line: 1, message: 'x' }] })),
    code('E_RECORD'),
  )
  assert.throws(() => writeRecord(dir, base({ evidence: [''] })), code('E_RECORD'))
  assert.throws(() => writeRecord(dir, base({ policyVersion: 'not-a-version' })), code('E_RECORD'))
  assert.throws(() => writeRecord(dir, base({ extra: true })), code('E_RECORD'))
})

test('坏 JSON 抛 E_PARSE，文件不存在抛 E_RECORD', () => {
  const dir = tmp()
  const file = join(dir, 'broken.json')
  writeFileSync(file, '{"pr": 12,', 'utf8')
  assert.throws(() => readRecord(file), code('E_PARSE'))
  assert.throws(() => readRecord(join(dir, 'nope.json')), code('E_RECORD'))
})

test('跳过审计落到 <dir>/skips/<stamp>-<pr>.json 并带 policyVersion', () => {
  const dir = reviewsDir(tmp())
  const now = new Date('2026-10-31T12:15:00Z')
  const file = writeSkipAudit(dir, {
    pr: 12,
    headSha: SHA,
    reason: '人工确认无需审核',
    now,
  })

  assert.ok(file.includes(`${join(dir, 'skips')}/`))
  assert.match(file, /\/skips\/20261031T121500Z-12\.json$/)
  const audit = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(audit, {
    pr: 12,
    head_sha: SHA,
    reason: '人工确认无需审核',
    at: '2026-10-31T12:15:00.000Z',
    policyVersion: PACKAGE_VERSION,
  })
  assert.equal(audit.policyVersion, PACKAGE_VERSION)
  assert.throws(() => writeSkipAudit(dir, { pr: 0, reason: 'x', now }), code('E_RECORD'))
  assert.throws(() => writeSkipAudit(dir, { pr: 12, reason: '', now }), code('E_RECORD'))
})

test('记录可携带 policy（否则 gate 的高风险判定是死代码）', async () => {
  const { validateRecord, SCHEMA_VERSION } = await import('../lib/record.mjs')
  const v = (await import('../package.json', { with: { type: 'json' } })).default.version
  const result = validateRecord({
    schemaVersion: SCHEMA_VERSION,
    policyVersion: v,
    pr: 1,
    round: 1,
    verdict: 'APPROVE',
    head_sha: 'a'.repeat(40),
    findings: [],
    evidence: ['x:1'],
    policy: { hit: true, reasons: ['scripts/pipeline/x'] },
    form: 'cli',
    model: 'codebuddy/glm-5.3-flash',
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors ?? result))
})
