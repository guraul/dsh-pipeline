import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_HIGH_RISK,
  MAX_CHANGED_LINES,
  mergePolicy,
} from '../lib/policy.mjs'

const code = (expected) => (error) => {
  assert.equal(error.code, expected)
  return true
}

test('DEFAULT_HIGH_RISK 覆盖参考实现的全部高风险 glob', () => {
  const globs = DEFAULT_HIGH_RISK.map((entry) => entry.glob)
  for (const expected of [
    '.github/**',
    'scripts/pipeline/**',
    'AGENTS.md',
    'docs/pipeline/**',
    '.dsh/profiles/**',
    '**/.gitignore',
    '**/package.json',
  ]) {
    assert.ok(globs.includes(expected), `缺少默认规则: ${expected}`)
  }
  assert.equal(MAX_CHANGED_LINES, 400)
})

test('命中高风险路径时给出理由', () => {
  const { hit } = mergePolicy()
  for (const file of [
    '.github/workflows/ci.yml',
    'scripts/pipeline/merge.sh',
    'AGENTS.md',
    'docs/pipeline/adr-0003.md',
    'sub/.gitignore',
    '.dsh/profiles/reviewer.yml',
  ]) {
    const result = hit([file], 0)
    assert.equal(result.hit, true, `${file} 应判为高风险`)
    assert.ok(result.reasons.length > 0)
  }
})

test('普通源码与文档不命中高风险', () => {
  const { hit } = mergePolicy()
  const result = hit(['src/index.mjs', 'docs/guide.md', 'lib/policy.mjs', 'AGENTS.md.bak'], 12)
  assert.deepEqual(result, { hit: false, reasons: [] })
})

test('400 行边界：等于上限不命中，超过才命中', () => {
  const { hit } = mergePolicy()
  assert.equal(hit([], MAX_CHANGED_LINES).hit, false)
  assert.equal(hit([], MAX_CHANGED_LINES - 1).hit, false)
  const over = hit([], MAX_CHANGED_LINES + 1)
  assert.equal(over.hit, true)
  assert.match(over.reasons[0], /超过 400 行上限/)
})

test('package.json 只有依赖段变更才算高风险', () => {
  const { hit } = mergePolicy()
  const dependencyDiff = [
    '@@ -10,2 +10,4 @@',
    '-  "dependencies": {},',
    '+  "dependencies": {',
    '+    "left-pad": "^1.3.0"',
    '+  },',
  ].join('\n')
  const nameOnlyDiff = ['@@ -2,2 +2,2 @@', '-  "name": "old"', '+  "name": "new"'].join('\n')

  assert.equal(hit([{ path: 'package.json', diff: dependencyDiff }], 3).hit, true)
  assert.equal(hit([{ path: 'package.json', diff: nameOnlyDiff }], 3).hit, false)
  assert.equal(hit(['package.json'], 3).hit, false, '没有 diff 时不能凭空判定依赖变更')
  assert.equal(hit(['package.json'], 3, { diff: dependencyDiff }).hit, true, '支持全局 diff')
})

test('highRiskAppend 可追加 glob 且不覆盖默认规则', () => {
  const policy = mergePolicy({
    highRiskAppend: ['release/**', { glob: 'infra/terraform/**', reason: '基础设施变更' }],
  })
  const globs = policy.patterns.map((entry) => entry.glob)
  assert.ok(globs.includes('release/**'))
  assert.ok(globs.includes('infra/terraform/**'))
  assert.ok(globs.includes('.github/**'), '追加规则不应丢掉默认规则')

  assert.equal(policy.hit(['release/v1.json'], 1).hit, true)
  const infra = policy.hit(['infra/terraform/main.tf'], 1)
  assert.equal(infra.hit, true)
  assert.ok(infra.reasons.some((reason) => reason.includes('基础设施变更')))
  assert.equal(policy.hit(['src/app.mjs'], 1).hit, false)
})

test('glob 语义：* 不跨目录，** 跨目录', () => {
  const policy = mergePolicy({ highRiskAppend: ['docs/*.md'] })
  assert.equal(policy.hit(['docs/a.md'], 0).hit, true)
  assert.equal(policy.hit(['docs/sub/a.md'], 0).hit, false)
  assert.equal(policy.hit(['./.github/workflows/x.yml'], 0).hit, true, './ 前缀不应绕过规则')
})

test('非法输入抛 E_POLICY', () => {
  const { hit } = mergePolicy()
  assert.throws(() => hit('src/a.mjs', 0), code('E_POLICY'))
  assert.throws(() => hit([], -1), code('E_POLICY'))
  assert.throws(() => hit([], 1.5), code('E_POLICY'))
  assert.throws(() => hit([{ path: '' }], 0), code('E_POLICY'))
  assert.throws(() => mergePolicy({ highRiskAppend: 'release/**' }), code('E_POLICY'))
  assert.throws(() => mergePolicy({ highRiskAppend: [''] }), code('E_POLICY'))
  assert.throws(() => mergePolicy({ highRiskAppend: [{ reason: 'x' }] }), code('E_POLICY'))
})

test('纯函数：重复调用一致且不改动输入', () => {
  const { hit, patterns } = mergePolicy()
  const files = ['AGENTS.md']
  const snapshot = [...files]
  const first = hit(files, 401)
  const second = hit(files, 401)
  assert.deepEqual(first, second)
  assert.deepEqual(files, snapshot)
  assert.ok(Object.isFrozen(patterns))
  assert.ok(Object.isFrozen(DEFAULT_HIGH_RISK))
})

test('默认清单含密钥与自指保护（reviewer 指出的闸门削弱）', async () => {
  const { mergePolicy } = await import('../lib/policy.mjs')
  const p = mergePolicy()
  for (const file of ['.env.local', 'certs/a.pem', 'certs/a.key', 'certs/a.p12', 'scripts/deploy.sh', 'scripts/rollback.sh', '.dsh/pipeline.json']) {
    const result = p.hit([file], 1)
    assert.equal(result.hit, true, `${file} 应命中高风险`)
  }
})
