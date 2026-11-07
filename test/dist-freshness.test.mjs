import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sourceHash, verifyDistFreshness } from '../lib/dist-freshness.mjs'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-dist-freshness-'))
}

/** 伪造一个「源码 checkout」：校验时会重算它的指纹。 */
function makeSource() {
  const root = tmp()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"x"}\n')
  writeFileSync(join(root, 'lib', 'index.mjs'), 'export const ok = true\n')
  return root
}

/** 伪造装包目录里的 build.json。 */
function writeBuild(dir, info) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'build.json'), `${JSON.stringify(info)}\n`)
  return join(dir, 'build.json')
}

test('没有 build.json → 跳过（running from source）', () => {
  const result = verifyDistFreshness({ buildPath: join(tmp(), 'build.json') })
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'running from source' })
})

test('记录的源码目录不存在 → 跳过（source checkout not found）', () => {
  const buildPath = writeBuild(tmp(), {
    sourcePath: join(tmp(), 'does-not-exist'),
    sourceHash: 'a'.repeat(64),
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'source checkout not found')
})

test('指纹一致 → ok', () => {
  const source = makeSource()
  const buildPath = writeBuild(tmp(), {
    gitSha: 'a'.repeat(40),
    builtAt: '2026-11-07T00:00:00Z',
    dirty: false,
    sourcePath: source,
    sourceHash: sourceHash(source),
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.recorded, result.actual)
})

test('指纹不一致 → not ok，reason 含「已过期」并给出前 8 位', () => {
  const source = makeSource()
  const recorded = 'b'.repeat(64)
  const buildPath = writeBuild(tmp(), { sourcePath: source, sourceHash: recorded })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.match(result.reason, /dist 已过期：源码已改但未重新 pack/)
  assert.ok(result.reason.includes(recorded.slice(0, 8)), 'reason 要带记录指纹前 8 位')
  assert.ok(result.reason.includes(result.actual.slice(0, 8)), 'reason 要带当前指纹前 8 位')
})

test('根目录存在但读不动（嵌套 ENOENT：坏符号链接）→ not ok 且 reason 含「读取失败」', () => {
  // 只有「根目录不存在」才许 skip；根在、里面读不动（坏链接 / 权限 / 竞态）一律判不过，
  // 否则环境异常会把守卫悄悄关掉。
  const source = makeSource()
  symlinkSync(join(source, 'gone-target'), join(source, 'lib', 'dangling'))
  const buildPath = writeBuild(tmp(), { sourcePath: source, sourceHash: 'e'.repeat(64) })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.match(result.reason, /源码目录读取失败（.+）：/)
})

test('旧版打包（缺 sourcePath/sourceHash）→ 跳过，不打挂消费方', () => {
  const buildPath = writeBuild(tmp(), {
    gitSha: 'a'.repeat(40),
    builtAt: '2026-11-07T00:00:00Z',
    dirty: false,
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /旧版打包/)
})

// ---- CLI 级：起真实子进程，包根是临时副本（避免污染本仓的 build.json 影响并行用例）----

/** 造一个「装坏了的包」：独立包根 + 过期 build.json，可直接 node <root>/bin/cli.mjs。 */
function makeStalePkg() {
  const pkgRoot = tmp()
  cpSync(join(REPO_ROOT, 'bin'), join(pkgRoot, 'bin'), { recursive: true })
  cpSync(join(REPO_ROOT, 'lib'), join(pkgRoot, 'lib'), { recursive: true })
  copyFileSync(join(REPO_ROOT, 'package.json'), join(pkgRoot, 'package.json'))
  writeFileSync(
    join(pkgRoot, 'build.json'),
    `${JSON.stringify({
      gitSha: 'a'.repeat(40),
      builtAt: '2026-11-07T00:00:00Z',
      dirty: false,
      sourcePath: makeSource(),
      sourceHash: 'f'.repeat(64),
    })}\n`,
  )
  return pkgRoot
}

function runPkg(pkgRoot, args, env = {}) {
  const { DSH_PIPELINE_ALLOW_STALE: _inherited, ...base } = process.env
  return spawnSync(process.execPath, [join(pkgRoot, 'bin/cli.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...base, ...env },
  })
}

test('CLI: dist 过期时普通命令退 1 并打印原因', () => {
  const pkgRoot = makeStalePkg()
  const result = runPkg(pkgRoot, ['status', '--root', tmp()])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /dist 已过期：源码已改但未重新 pack/)
  assert.match(result.stderr, /DSH_PIPELINE_ALLOW_STALE=1/)
})

test('CLI: DSH_PIPELINE_ALLOW_STALE=1 时过期也退 0', () => {
  const pkgRoot = makeStalePkg()
  const result = runPkg(pkgRoot, ['status', '--root', tmp()], { DSH_PIPELINE_ALLOW_STALE: '1' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
})

test('CLI: dist 过期时 --help 仍退 0，只在 stderr 警告', () => {
  const pkgRoot = makeStalePkg()
  const result = runPkg(pkgRoot, ['--help'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /用法: dsh-pipeline/)
  assert.match(result.stderr, /^警告：dist 已过期/m)
})

test('CLI: dist 过期时无参与 -v 同样不拦（只警告 + 正常输出）', () => {
  const pkgRoot = makeStalePkg()
  const bare = runPkg(pkgRoot, [])
  assert.equal(bare.status, 0, bare.stderr)
  assert.match(bare.stdout, /用法: dsh-pipeline/)
  assert.match(bare.stderr, /^警告：/m)

  const version = runPkg(pkgRoot, ['-v'])
  assert.equal(version.status, 0, version.stderr)
  assert.match(version.stdout, /^\d+\.\d+\.\d+/)
  assert.match(version.stderr, /^警告：/m)
})

test('CLI: 过期时 `-- --help` 不算信息命令，仍然退 1', () => {
  const pkgRoot = makeStalePkg()
  const result = runPkg(pkgRoot, ['--', '--help'])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /dist 已过期/)
})

test('CLI: 过期时子命令参数里的 -v 不算信息命令，仍然退 1', () => {
  const pkgRoot = makeStalePkg()
  const root = tmp()
  const result = runPkg(pkgRoot, ['status', '--root', root, '-v'])
  assert.equal(result.status, 1, result.stderr)
  assert.match(result.stderr, /dist 已过期/)
})
