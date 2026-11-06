/**
 * selftest：契约 §9 一致性门禁（已实现 --shims / --config / --repos，--fast 等价于前两者）。
 *
 * 覆盖：合法配置 → 0、未知字段 → 1 且 stderr 带字段名、没有配置文件 → 0（跳过）、
 * --shims 安装后通过 / 目录缺失 → 1、已识别但未实现的检查项 → 2、--json 结构、
 * --fast 与 --shims --config 等价、缺省 root 解析、
 * --repos 的多仓比对（同构建 → 0、不一致 → 1 且 ::error:: 列出、缺 tools / 缺 build.json 跳过、
 * 不足 2 个仓 → 0、相对路径按 --root 解析、与 --shims/--config/--fast 互斥、用法错误 → 2、--json 结构）。
 * 只调 runCli（注入输出流），不发任何外部命令。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'

const VALID = '{"repo":"guraul/dsh-pipeline","ci":[],"highRisk":[".github/**"]}'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-selftest-'))
}

function writeConfig(root, text) {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.json'), text)
}

const SHA = '0123456789abcdef0123456789abcdef01234567'
const SHA_OTHER = '89abcdef0123456789abcdef0123456789abcdef'
const BUILT_AT = '2026-11-05T10:00:00.000Z'

/**
 * 造假仓：pkg=false 只建目录（缺 tools/node_modules）；build=false 建了 cli.mjs 但不写 build.json。
 * @returns {string} 仓路径
 */
function makeRepo(base, name, { sha = SHA, builtAt = BUILT_AT, pkg = true, build = true } = {}) {
  const dir = join(base, name)
  if (!pkg) {
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const pkgDir = join(dir, 'tools', 'node_modules', 'dsh-pipeline')
  mkdirSync(join(pkgDir, 'bin'), { recursive: true })
  writeFileSync(join(pkgDir, 'bin', 'cli.mjs'), '// stub\n')
  if (build) writeFileSync(join(pkgDir, 'build.json'), JSON.stringify({ gitSha: sha, builtAt }))
  return dir
}

function run(argv, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    ...deps,
  })
  return { code, ...state }
}

test('selftest --config：合法配置 → 0，stdout 打印 <root>: 配置 OK', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, VALID)

  const result = run(['selftest', '--config', '--root', root])
  assert.equal(result.code, 0)
  assert.equal(result.out, `${root}: 配置 OK\n`)
  assert.equal(result.err, '')
})

test('selftest --config：未知字段 → 1，stderr 含字段名', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, '{"repo":"guraul/dsh-pipeline","bogusField":1}')

  const result = run(['selftest', '--config', '--root', root])
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /bogusField/)
})

test('selftest --config：JSON 坏 → 1，stderr 带原因', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, '{"repo": ')

  const result = run(['selftest', '--config', '--root', root])
  assert.equal(result.code, 1)
  assert.match(result.err, /不是合法 JSON/)
})

test('selftest --config：没有配置文件 → 0，提示跳过', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(['selftest', '--config', '--root', root])
  assert.equal(result.code, 0)
  assert.equal(result.out, `${root}: 无 .dsh/pipeline.json（跳过）\n`)
  assert.equal(result.err, '')
})

test('selftest：已识别但未实现的检查项 → 2，报「尚未实现」', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, VALID)

  for (const name of ['peer', 'exit-codes']) {
    const result = run(['selftest', `--${name}`, '--root', root])
    assert.equal(result.code, 2, `--${name} 应退 2`)
    assert.equal(result.err, `selftest: 尚未实现: --${name}\n`)
    assert.equal(result.out, '')
  }
})

test('selftest：未指定检查项 → 2', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(['selftest', '--root', root])
  assert.equal(result.code, 2)
  assert.match(result.err, /未指定检查项/)
})

test('selftest --json：结构与退出码跟人读模式一致', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const good = tmp()
  t.after(() => rmSync(good, { recursive: true, force: true }))
  writeConfig(good, VALID)

  const passed = run(['selftest', '--config', '--json', '--root', good])
  assert.equal(passed.code, 0)
  assert.equal(passed.err, '')
  assert.deepEqual(JSON.parse(passed.out), {
    ok: true,
    root: good,
    checks: [{ name: 'config', ok: true, detail: '配置 OK' }],
  })

  writeConfig(root, '{"repo":"guraul/dsh-pipeline","bogusField":1}')
  const failed = run(['selftest', '--config', '--json', '--root', root])
  assert.equal(failed.code, 1)
  const payload = JSON.parse(failed.out)
  assert.equal(payload.ok, false)
  assert.equal(payload.root, root)
  assert.equal(payload.checks.length, 1)
  assert.equal(payload.checks[0].name, 'config')
  assert.equal(payload.checks[0].ok, false)
  assert.match(payload.checks[0].detail, /bogusField/)
  // --json 只改 stdout 形态，失败原文照样进 stderr
  assert.match(failed.err, /bogusField/)
})

test('selftest --fast：等价于 --shims --config（入口缺失时同样退 1）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, VALID)

  const fast = run(['selftest', '--fast', '--root', root])
  const both = run(['selftest', '--shims', '--config', '--root', root])
  assert.equal(fast.code, 1)
  assert.equal(fast.code, both.code)
  assert.equal(fast.out, both.out)
  assert.equal(fast.err, both.err)
  assert.match(fast.err, /shim install/)
})

test('selftest --shims：shim install 后通过；--fast 同时跑两项', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, VALID)
  assert.equal(run(['shim', 'install', '--root', root]).code, 0)

  const shims = run(['selftest', '--shims', '--root', root])
  assert.equal(shims.code, 0)
  assert.equal(shims.out, `${root}: 6 个入口与模板一致\n`)
  assert.equal(shims.err, '')

  const fast = run(['selftest', '--fast', '--root', root])
  assert.equal(fast.code, 0)
  assert.equal(fast.out, `${root}: 6 个入口与模板一致\n${root}: 配置 OK\n`)
  assert.equal(fast.err, '')
})

test('selftest：缺省 root 时定位主工作区，定位不到退回当前目录', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, VALID)

  const result = run(['selftest', '--config'], { cwd: root })
  assert.equal(result.code, 0)
  assert.equal(result.out, `${root}: 配置 OK\n`)
})

test('selftest --repos：三个仓同一构建 → 0，每仓一行 + 末行「构建一致：3 个仓」', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const paths = ['a', 'b', 'c'].map((name) => makeRepo(base, name))

  const result = run(['selftest', '--repos', paths.join(',')])
  assert.equal(result.code, 0)
  assert.equal(
    result.out,
    `${paths.map((path) => `${path}\t${SHA.slice(0, 7)} ${BUILT_AT}`).join('\n')}\n构建一致：3 个仓\n`,
  )
  assert.equal(result.err, '')
})

test('selftest --repos：一个仓 sha 不同 → 1，stderr 的 ::error:: 列出它', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const a = makeRepo(base, 'a')
  const b = makeRepo(base, 'b')
  const drift = makeRepo(base, 'drift', { sha: SHA_OTHER })

  const result = run(['selftest', '--repos', `${a},${b},${drift}`])
  assert.equal(result.code, 1)
  // stdout 照样每仓一行，行尾不打「构建一致」
  assert.equal(
    result.out,
    [
      `${a}\t${SHA.slice(0, 7)} ${BUILT_AT}`,
      `${b}\t${SHA.slice(0, 7)} ${BUILT_AT}`,
      `${drift}\t${SHA_OTHER.slice(0, 7)} ${BUILT_AT}`,
      '',
    ].join('\n'),
  )
  assert.equal(result.err, `::error::基准 ${SHA.slice(0, 7)}，不一致的仓：${drift}\n`)
})

test('selftest --repos：两个仓缺 tools/node_modules → 跳过并列出，不算失败', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const a = makeRepo(base, 'a')
  const b = makeRepo(base, 'b')
  const miss1 = makeRepo(base, 'miss1', { pkg: false })
  const miss2 = makeRepo(base, 'miss2', { pkg: false })

  const result = run(['selftest', '--repos', `${a},${b},${miss1},${miss2}`])
  assert.equal(result.code, 0)
  assert.equal(
    result.out,
    [
      `${a}\t${SHA.slice(0, 7)} ${BUILT_AT}`,
      `${b}\t${SHA.slice(0, 7)} ${BUILT_AT}`,
      `${miss1}\t跳过（未装包）`,
      `${miss2}\t跳过（未装包）`,
      '构建一致：2 个仓',
      '',
    ].join('\n'),
  )
  assert.equal(result.err, '')
})

test('selftest --repos：取不到 build.json 的仓按「未装包」跳过', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const a = makeRepo(base, 'a')
  const noBuild = makeRepo(base, 'no-build', { build: false })

  const result = run(['selftest', '--repos', `${a},${noBuild}`])
  assert.equal(result.code, 0)
  assert.equal(
    result.out,
    [`${a}\t${SHA.slice(0, 7)} ${BUILT_AT}`, `${noBuild}\t跳过（未装包）`, '跳过（可比对的仓不足 2 个）', ''].join(
      '\n',
    ),
  )
  assert.equal(result.err, '')
})

test('selftest --repos：只有 1 个有效仓 → 0，且说「不足 2 个」', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const only = makeRepo(base, 'only')

  const result = run(['selftest', '--repos', only])
  assert.equal(result.code, 0)
  assert.equal(result.out, `${only}\t${SHA.slice(0, 7)} ${BUILT_AT}\n跳过（可比对的仓不足 2 个）\n`)
  assert.equal(result.err, '')
})

test('selftest --repos：相对路径按 --root 解析，缺省按当前目录', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  makeRepo(base, 'a')
  makeRepo(base, 'b')
  const expected = `${join(base, 'a')}\t${SHA.slice(0, 7)} ${BUILT_AT}\n${join(base, 'b')}\t${SHA.slice(0, 7)} ${BUILT_AT}\n构建一致：2 个仓\n`

  const byRoot = run(['selftest', '--repos', 'a,b', '--root', base])
  assert.equal(byRoot.code, 0)
  assert.equal(byRoot.out, expected)

  const byCwd = run(['selftest', '--repos', 'a,b'], { cwd: base })
  assert.equal(byCwd.code, 0)
  assert.equal(byCwd.out, expected)
})

test('selftest --repos：与 --shims / --config / --fast 互斥 → 2', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  makeRepo(base, 'a')
  makeRepo(base, 'b')

  for (const flag of ['--shims', '--config', '--fast']) {
    const result = run(['selftest', '--repos', 'a,b', flag, '--root', base])
    assert.equal(result.code, 2, `${flag} 应退 2`)
    assert.match(result.err, /--repos 不能与 --shims \/ --config \/ --fast 同时使用/)
    assert.equal(result.out, '')
  }
})

test('selftest --repos：空值 / 全是逗号 → 2', (t) => {
  const empty = run(['selftest', '--repos='])
  assert.equal(empty.code, 2)
  assert.match(empty.err, /--repos 必须是非空的逗号分隔路径/)

  const blank = run(['selftest', '--repos', ',,'])
  assert.equal(blank.code, 2)
  assert.match(blank.err, /--repos 至少需要一个仓路径/)
})

test('selftest --repos --json：结构与退出码跟人读模式一致', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const a = makeRepo(base, 'a')
  const b = makeRepo(base, 'b')
  const missing = join(base, 'no-such-repo')

  const passed = run(['selftest', '--repos', `${a},${b},${missing}`, '--json'])
  assert.equal(passed.code, 0)
  assert.equal(passed.err, '')
  assert.deepEqual(JSON.parse(passed.out), {
    ok: true,
    baseline: SHA,
    repos: [
      { path: a, sha: SHA, builtAt: BUILT_AT, ok: true },
      { path: b, sha: SHA, builtAt: BUILT_AT, ok: true },
    ],
    skipped: [{ path: missing, reason: '目录不存在' }],
  })

  const drift = makeRepo(base, 'drift', { sha: SHA_OTHER })
  const failed = run(['selftest', '--repos', `${a},${drift}`, '--json'])
  assert.equal(failed.code, 1)
  const payload = JSON.parse(failed.out)
  assert.deepEqual(payload, {
    ok: false,
    baseline: SHA,
    repos: [
      { path: a, sha: SHA, builtAt: BUILT_AT, ok: true },
      { path: drift, sha: SHA_OTHER, builtAt: BUILT_AT, ok: false },
    ],
    skipped: [],
  })
  // --json 只改 stdout 形态，失败原文照样进 stderr
  assert.equal(failed.err, `::error::基准 ${SHA.slice(0, 7)}，不一致的仓：${drift}\n`)
})
