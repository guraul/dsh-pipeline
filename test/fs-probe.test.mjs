/**
 * 「读盘失败不能当成不存在」这一整类的回归。
 * 覆盖：probePath 本身、selftest --config、doctor、check-all。
 * （hooks / shim / peer 的同一改动由各自的既有测试覆盖，这里不重复造夹具。）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { probeExists, probePath } from '../lib/fs-probe.mjs'

const skipAsRoot = (t) => {
  if (process.getuid?.() === 0) {
    t.skip('root 不受权限位限制')
    return true
  }
  return false
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-fs-probe-'))
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

test('probePath：存在 → ok；不存在 → missing；不可读 → io-error', (t) => {
  const root = tmp()
  const file = join(root, 'a.json')
  writeFileSync(file, '{}', 'utf8')
  // 单个 after：先恢复权限（否则删不掉）再删目录
  t.after(() => {
    try {
      chmodSync(root, 0o755)
    } catch {
      // 已恢复
    }
    rmSync(root, { recursive: true, force: true })
  })

  assert.equal(probePath(file).kind, 'ok')
  assert.equal(probePath(join(root, 'nope.json')).kind, 'missing')
  assert.equal(probeExists(join(root, 'nope.json')).kind, 'missing')

  if (skipAsRoot(t)) return
  chmodSync(root, 0o000)
  assert.equal(probePath(join(root, 'a.json')).kind, 'io-error')
})

test('selftest --config：配置文件读不出来 → 退 3（不当「无配置」跳过）', (t) => {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  const file = join(root, '.dsh', 'pipeline.json')
  writeFileSync(file, '{"repo":"owner/repo"}', 'utf8')
  // 先注册清理，再决定是否 skip：root 下也要把临时目录删掉
  t.after(() => {
    try {
      chmodSync(file, 0o644)
    } catch {
      // 已清理
    }
    rmSync(root, { recursive: true, force: true })
  })
  if (skipAsRoot(t)) return
  chmodSync(file, 0o000)

  const result = run(['selftest', '--config', '--root', root])
  assert.equal(result.code, 3)
  assert.match(result.err, /dsh-pipeline: selftest: E_ENV: /)
})

test('doctor：装包的 package.json 读不出来 → 退 3（不当「没装」）', (t) => {
  const root = tmp()
  const pkgDir = join(root, 'tools', 'node_modules', 'dsh-pipeline')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), '{"name":"@guraul/dsh-pipeline"}', 'utf8')
  t.after(() => {
    try {
      chmodSync(pkgDir, 0o755)
    } catch {
      // 已清理
    }
    rmSync(root, { recursive: true, force: true })
  })
  if (skipAsRoot(t)) return
  chmodSync(pkgDir, 0o000)

  const result = run(['doctor', '--repo', root])
  assert.equal(result.code, 3)
  assert.match(result.err, /dsh-pipeline: doctor: E_ENV: /)
})

test('check-all：包目录的 package.json 读不出来 → 退 3（不静默少查一个包）', (t) => {
  const root = tmp()
  const dir = join(root, 'pkg-a')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"a"}', 'utf8')
  t.after(() => {
    try {
      chmodSync(dir, 0o755)
    } catch {
      // 已清理
    }
    rmSync(root, { recursive: true, force: true })
  })
  if (skipAsRoot(t)) return
  chmodSync(dir, 0o000)

  const result = run(['check-all', '--root', root])
  assert.equal(result.code, 3)
  assert.match(result.err, /dsh-pipeline: check-all: E_ENV: /)
})
