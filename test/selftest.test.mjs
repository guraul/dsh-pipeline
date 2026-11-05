/**
 * selftest：契约 §9 一致性门禁（已实现 --shims / --config，--fast 等价于两者）。
 *
 * 覆盖：合法配置 → 0、未知字段 → 1 且 stderr 带字段名、没有配置文件 → 0（跳过）、
 * --shims 安装后通过 / 目录缺失 → 1、已识别但未实现的检查项 → 2、--json 结构、
 * --fast 与 --shims --config 等价、缺省 root 解析。
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
