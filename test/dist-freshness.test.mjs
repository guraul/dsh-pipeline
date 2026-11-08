import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

test('package.json 仅重排键序不改指纹（稳定序列化）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pkg-order-'))
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib', 'a.mjs'), 'export const a = 1\n')
  const pkgA = '{"name":"x","type":"module","bin":{"dsh":"bin/cli.mjs"},"exports":{".":"./lib/a.mjs"}}'
  const pkgB = '{"exports":{".":"./lib/a.mjs"},"bin":{"dsh":"bin/cli.mjs"},"type":"module","name":"x"}'
  writeFileSync(join(root, 'package.json'), pkgA)
  const first = sourceHash(root)
  writeFileSync(join(root, 'package.json'), pkgB)
  assert.equal(sourceHash(root), first)
  rmSync(root, { recursive: true, force: true })
})

test('空指纹给出专属文案（不伪装成读取失败）', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-empty-'))
  const buildPath = join(root, 'build.json')
  // 源码根存在但 lib/bin/templates 全缺
  const src = join(root, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(buildPath, JSON.stringify({ gitSha: 'x', builtAt: 'y', sourcePath: src, sourceHash: 'deadbeef' }))
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.match(result.reason, /源码指纹为空/)
  // 正向 + 负向双断言：旧实现会包装成「源码目录读取失败（UNKNOWN）」，换别的错误文案也不许通过
  assert.match(result.reason, /源码指纹为空/)
  assert.doesNotMatch(result.reason, /UNKNOWN|读取失败|无法读取/)
  rmSync(root, { recursive: true, force: true })
})

test('源码根存在但不可访问（ELOOP 自指链接）→ 判不过，不静默 skip', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-eloop-'))
  const buildPath = join(root, 'build.json')
  const src = join(root, 'src')
  // 自指符号链接：statSync 抛 ELOOP，root 用户也无法绕过（与 chmod 000 不同，root 下仍生效）
  symlinkSync(src, src)
  writeFileSync(buildPath, JSON.stringify({ gitSha: 'x', builtAt: 'y', sourcePath: src, sourceHash: 'deadbeef' }))
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.match(result.reason, /不可访问|读取失败/)
  rmSync(root, { recursive: true, force: true })
})

test('记录的源码路径是文件而非目录 → 明确报「不是目录」', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-notdir-'))
  const buildPath = join(root, 'build.json')
  const notDir = join(root, 'not-a-dir.txt')
  writeFileSync(notDir, 'x')
  writeFileSync(buildPath, JSON.stringify({ gitSha: 'x', builtAt: 'y', sourcePath: notDir, sourceHash: 'deadbeef' }))
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.match(result.reason, /不是目录/)
  rmSync(root, { recursive: true, force: true })
})
