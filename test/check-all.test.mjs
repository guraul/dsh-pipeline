import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/cli.mjs', import.meta.url))

const STUB = `#!/bin/sh
printf '%s :: %s\\n' "$(pwd)" "$*" >> "$STUB_LOG"
echo "stub 输出: 期望 1 实际 2"
code="\${RESULT:-0}"
if [ -f .stub-exit ]; then
  code=$(cat .stub-exit)
fi
exit "$code"
`

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-check-all-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const pkg = (name, scripts, deps) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, scripts }))
    if (deps) mkdirSync(join(dir, 'node_modules'))
    return dir
  }

  const ok = pkg('pkg-ok', { test: 'true', check: 'true' }, true)
  const bad = pkg('pkg-bad', { test: 'true' }, true)
  writeFileSync(join(bad, '.stub-exit'), '1\n')
  pkg('pkg-nodeps', { test: 'true', check: 'true', typecheck: 'true' }, false)

  mkdirSync(join(root, 'node_modules'))
  writeFileSync(join(root, 'node_modules', 'package.json'), '{}')
  mkdirSync(join(root, '.hidden'))
  writeFileSync(join(root, '.hidden', 'package.json'), '{}')
  mkdirSync(join(root, 'no-pkg'))

  const bin = join(root, '.bin')
  mkdirSync(bin)
  const pnpm = join(bin, 'pnpm')
  writeFileSync(pnpm, STUB)
  chmodSync(pnpm, 0o755)

  const log = join(root, 'stub.log')
  writeFileSync(log, '')

  return { root, bin, log, ok, bad }
}

function run(fx, args, { result = '0', path } = {}) {
  const env = {
    ...process.env,
    PATH: path === undefined ? `${fx.bin}${delimiter}${process.env.PATH}` : path,
    RESULT: result,
    STUB_LOG: fx.log,
  }
  const spawned = spawnSync(process.execPath, [CLI, 'check-all', ...args], {
    cwd: fx.root,
    env,
    encoding: 'utf8',
  })
  return { status: spawned.status, stdout: spawned.stdout ?? '', stderr: spawned.stderr ?? '' }
}

test('check-all：全部通过（含跳过）→ 0，缺 node_modules 的包不算失败', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages', 'pkg-ok,pkg-nodeps'])
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'pkg-ok | test | 通过',
    'pkg-ok | check | 通过',
    'pkg-nodeps | test | 跳过（未安装依赖）',
    'pkg-nodeps | check | 跳过（未安装依赖）',
    'pkg-nodeps | typecheck | 跳过（未安装依赖）',
    'check-all: 2 个包，1 通过 / 0 失败 / 1 跳过',
  ])
})

test('check-all：有失败 → 1，汇总数字正确，后面的包继续跑', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages', 'pkg-bad,pkg-ok,pkg-nodeps'])
  assert.equal(r.status, 1)
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'pkg-bad | test | 失败（退出码 1）',
    // 失败项附带命令输出（缩进两格），见「失败项要带出命令输出」用例
    '  stub 输出: 期望 1 实际 2',
    'pkg-ok | test | 通过',
    'pkg-ok | check | 通过',
    'pkg-nodeps | test | 跳过（未安装依赖）',
    'pkg-nodeps | check | 跳过（未安装依赖）',
    'pkg-nodeps | typecheck | 跳过（未安装依赖）',
    'check-all: 3 个包，1 通过 / 1 失败 / 1 跳过',
  ])
})

test('check-all：缺省自动发现，跳过 node_modules、. 开头与无 package.json 的目录', (t) => {
  const fx = fixture(t)
  const r = run(fx, [])
  assert.equal(r.status, 1)
  assert.ok(r.stdout.endsWith('check-all: 3 个包，1 通过 / 1 失败 / 1 跳过\n'), r.stdout)
})

test('check-all：stub 记录 argv，只在装了依赖的包上执行 pnpm', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages', 'pkg-ok,pkg-nodeps'])
  assert.equal(r.status, 0)
  const lines = readFileSync(fx.log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2, lines.join('\n'))
  assert.ok(lines[0].endsWith('pkg-ok :: test'), lines[0])
  assert.ok(lines[1].endsWith('pkg-ok :: run check'), lines[1])
})

test('check-all：--json 结构与退出码一致', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--json'])
  assert.equal(r.status, 1)
  assert.equal(r.stderr, '')
  assert.equal(r.stdout.trim().split('\n').length, 1)
  const payload = JSON.parse(r.stdout)
  assert.equal(payload.ok, false)
  assert.deepEqual(
    payload.packages.map((entry) => entry.dir),
    ['pkg-bad', 'pkg-nodeps', 'pkg-ok'],
  )
  const byDir = Object.fromEntries(payload.packages.map((entry) => [entry.dir, entry]))
  assert.deepEqual(byDir['pkg-bad'].checks, [{ name: 'test', ok: false, skipped: false, code: 1 }])
  assert.deepEqual(byDir['pkg-nodeps'].checks, [
    { name: 'test', ok: true, skipped: true, code: null },
    { name: 'check', ok: true, skipped: true, code: null },
    { name: 'typecheck', ok: true, skipped: true, code: null },
  ])
  assert.deepEqual(byDir['pkg-ok'].checks, [
    { name: 'test', ok: true, skipped: false, code: 0 },
    { name: 'check', ok: true, skipped: false, code: 0 },
  ])
})

test('check-all：未知参数 → 2', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--bogus'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /未知选项: --bogus/)
})

test('check-all：--packages 空值 → 2', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages=,'])
  assert.equal(r.status, 2)
  assert.match(r.stderr, /--packages 至少需要一个包名/)
})

test('check-all：找不到 pnpm → 3', (t) => {
  const fx = fixture(t)
  const empty = join(fx.root, 'empty-path')
  mkdirSync(empty)
  const r = run(fx, ['--packages', 'pkg-ok'], { path: empty })
  assert.equal(r.status, 3)
  assert.match(r.stderr, /找不到 pnpm/)
})

test('check-all：显式指定的包不存在 → 失败退 1', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages', 'pkg-ok,不存在的包'])
  assert.equal(r.status, 1)
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'pkg-ok | test | 通过',
    'pkg-ok | check | 通过',
    '不存在的包 | - | 失败（包目录不存在）',
    'check-all: 2 个包，1 通过 / 1 失败 / 0 跳过',
  ])
})

test('check-all：失败项要带出命令输出（否则只看到退出码，排查还得重跑）', (t) => {
  const fx = fixture(t)
  const r = run(fx, ['--packages', 'pkg-bad'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /失败（退出码 1）/)
  assert.match(r.stdout, /stub 输出: 期望 1 实际 2/, '失败项必须把命令输出打出来')
})

/** 写 .dsh/pipeline.json（check-all 缺省读它取包清单）。 */
function writeChecksConfig(fx, checks) {
  const dir = join(fx.root, '.dsh')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'pipeline.json'), JSON.stringify({ checks }))
}

test('check-all：配置 checks.packages 生效且按给定顺序，不跑自动发现', (t) => {
  const fx = fixture(t)
  writeChecksConfig(fx, { packages: ['pkg-nodeps', 'pkg-ok'] })
  const r = run(fx, [])
  assert.equal(r.status, 0)
  // 顺序跟配置走（不是字母序），自动发现的 pkg-bad / .hidden / node_modules 都不出现
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'pkg-nodeps | test | 跳过（未安装依赖）',
    'pkg-nodeps | check | 跳过（未安装依赖）',
    'pkg-nodeps | typecheck | 跳过（未安装依赖）',
    'pkg-ok | test | 通过',
    'pkg-ok | check | 通过',
    'check-all: 2 个包，1 通过 / 0 失败 / 1 跳过',
  ])
})

test('check-all：--packages flag 覆盖配置 checks.packages', (t) => {
  const fx = fixture(t)
  writeChecksConfig(fx, { packages: ['pkg-nodeps'] })
  const r = run(fx, ['--packages', 'pkg-ok'])
  assert.equal(r.status, 0)
  assert.deepEqual(r.stdout.trim().split('\n'), [
    'pkg-ok | test | 通过',
    'pkg-ok | check | 通过',
    'check-all: 1 个包，1 通过 / 0 失败 / 0 跳过',
  ])
})

test('check-all：checks.exclude 过滤自动发现的目录（tools 这类「无可跑检查」不再出现）', (t) => {
  const fx = fixture(t)
  // tools 只有 package.json、没有 scripts，但装了 node_modules：自动发现会记「无可跑检查」失败
  const tools = join(fx.root, 'tools')
  mkdirSync(join(tools, 'node_modules'), { recursive: true })
  writeFileSync(join(tools, 'package.json'), JSON.stringify({ name: 'tools' }))

  const before = run(fx, [])
  assert.equal(before.status, 1)
  assert.ok(before.stdout.includes('tools | - | 失败（无可跑检查）\n'), before.stdout)
  assert.ok(before.stdout.endsWith('check-all: 4 个包，1 通过 / 2 失败 / 1 跳过\n'), before.stdout)

  writeChecksConfig(fx, { exclude: ['tools'] })
  const after = run(fx, [])
  assert.equal(after.status, 1)
  assert.ok(!after.stdout.includes('tools'), after.stdout)
  assert.ok(after.stdout.endsWith('check-all: 3 个包，1 通过 / 1 失败 / 1 跳过\n'), after.stdout)
})

test('check-all：配置 checks 形状非法 → 读取配置失败退 2（E_CONFIG）', (t) => {
  const fx = fixture(t)
  writeChecksConfig(fx, { packages: 'x' })
  const r = run(fx, [])
  assert.equal(r.status, 2)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /dsh-pipeline: check-all: E_CONFIG: 读取配置失败/)
  assert.match(r.stderr, /checks\.packages/)
})
