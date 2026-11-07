/**
 * 源码指纹 + `dist/pkg` 新鲜度校验。
 *
 * 消费方（homebase / agent-mobile）的 `tools/node_modules/dsh-pipeline` 是 link 到
 * 本包的 `dist/pkg`：改了源码却忘了 `pnpm pack`，消费方会**静默跑旧代码**。
 * 打包时把源码指纹写进 `build.json.sourceHash`，这里在 CLI 启动时重算比对，
 * 不一致就直接失败——「忘 pack」从静默变成立刻报错。
 *
 * 为什么指纹实现放在 lib 而不是 `scripts/source-hash.mjs`：
 * 打包后的包里没有 `scripts/`（`package.json` 的 `files` 未列），运行时必须能从包内 import；
 * `scripts/source-hash.mjs` 只是它的 CLI 包装。
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)

/** 参与指纹的目标：**运行时载荷**（目录递归）。 */
const TARGETS = Object.freeze(['lib', 'bin', 'templates'])

/** `package.json` 里**影响产物形状**的字段才进指纹（`version`/`scripts`/`devDependencies` 不进）。已按字典序。 */
const PKG_SHAPE_KEYS = Object.freeze(['bin', 'engines', 'exports', 'files', 'main', 'type'])

/** 打包时不带、且各机器不一致的条目不进指纹（否则同一份源码在不同机器算出不同值）。 */
function isIgnored(name) {
  return name === 'node_modules' || name.startsWith('.')
}

/** `package.json` 的字段级虚拟条目：只哈希影响产物形状的字段（键序稳定）。 */
function packageShapeEntry(root) {
  const abs = join(root, 'package.json')
  if (!existsSync(abs)) return null
  const pkg = JSON.parse(readFileSync(abs, 'utf8'))
  const shape = {}
  for (const key of PKG_SHAPE_KEYS) {
    if (Object.hasOwn(pkg, key)) shape[key] = pkg[key]
  }
  return { path: 'package.json', content: Buffer.from(JSON.stringify(shape)) }
}

/**
 * 收集目标下全部文件的「posix 相对路径 + 内容」，按路径字典序（码元序，与 locale 无关）排列。
 * @param {string} root 包根目录
 * @returns {Array<{ path: string, content: Buffer }>}
 */
function collectSourceFiles(root) {
  // 先验证 root 本身是可读目录：不存在 → ENOENT，路径中间是文件 → ENOTDIR，没权限 → EACCES。
  // 少了这步，下面逐个 existsSync(target) 会把异常全吞成「空指纹」，异常就又变回静默了。
  readdirSync(root)

  const files = []
  const walk = (absDir, relDir) => {
    for (const name of readdirSync(absDir)) {
      if (isIgnored(name)) continue
      const abs = join(absDir, name)
      const rel = relDir === '' ? name : `${relDir}/${name}`
      if (statSync(abs).isDirectory()) walk(abs, rel)
      else files.push({ path: rel, content: readFileSync(abs) })
    }
  }

  for (const target of TARGETS) {
    const abs = join(root, target)
    if (!existsSync(abs)) continue
    if (statSync(abs).isDirectory()) walk(abs, target)
    else files.push({ path: target, content: readFileSync(abs) })
  }

  const pkgEntry = packageShapeEntry(root)
  if (pkgEntry !== null) files.push(pkgEntry)

  // 空指纹 = 与「什么都对」等价（sha256(空) 是常量），守卫会被静默关掉，所以直接抛
  if (files.length === 0) {
    throw new Error('源码指纹为空：目标 lib/bin/templates 全缺')
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

/**
 * 源码指纹：路径与内容按字典序拼接后 sha256（不含 mtime，跨机器稳定）；
 * `package.json` 只取影响产物形状的字段（`version`/`scripts`/`devDependencies` 不参与）。
 * @param {string} root 包根目录
 * @returns {string} 64 位小写十六进制
 */
export function sourceHash(root) {
  const hash = createHash('sha256')
  for (const file of collectSourceFiles(root)) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(file.content)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/**
 * 校验当前包是不是「源码改过但没重新 pack」。
 *
 * 返回：
 * - 没有 `build.json`（直接跑源码）      → { ok: true,  skipped: true,  reason: 'running from source' }
 * - 记录的源码根目录不存在（`existsSync` 前置判定，唯一允许 skip 的情形）
 *                                    → { ok: true,  skipped: true,  reason: 'source checkout not found' }
 * - 根目录存在但读不动（嵌套 ENOENT/EACCES/坏链接/竞态）
 *                                    → { ok: false, skipped: false, reason: '源码目录读取失败（<code>）：<message>' }
 * - 指纹不一致（源码已改但没重新 pack）  → { ok: false, skipped: false, reason: 'dist 已过期：…（记录 <前8>，当前 <前8>）' }
 * - 指纹一致                            → { ok: true,  skipped: false }
 *
 * 放行与否由调用方判断（CLI 读 `DSH_PIPELINE_ALLOW_STALE`），本函数只报告事实。
 *
 * @param {{ buildPath?: string }} [options]
 * @returns {{ ok: boolean, skipped: boolean, reason?: string, recorded?: string, actual?: string }}
 */
export function verifyDistFreshness({ buildPath } = {}) {
  const file = buildPath ?? join(PKG_ROOT, 'build.json')

  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { ok: true, skipped: true, reason: 'running from source' }
    }
    throw error
  }

  let info
  try {
    info = JSON.parse(raw)
  } catch {
    return { ok: true, skipped: true, reason: 'build.json 不是合法 JSON，跳过新鲜度校验' }
  }

  const sourcePath = typeof info?.sourcePath === 'string' ? info.sourcePath : ''
  const recorded = typeof info?.sourceHash === 'string' ? info.sourceHash : ''
  // 本改动之前的旧包没有这两个字段：无从校验，按跳过处理（不能因此把消费方打挂）。
  if (sourcePath === '' || recorded === '') {
    return { ok: true, skipped: true, reason: 'build.json 缺 sourcePath/sourceHash（旧版打包），跳过校验' }
  }
  // 根目录存在性显式前置判定（这是唯一允许 skip 的情形）
  if (!existsSync(sourcePath)) {
    return { ok: true, skipped: true, reason: 'source checkout not found' }
  }

  let actual
  try {
    actual = sourceHash(sourcePath)
  } catch (error) {
    // 走到这里说明根目录存在但读不动（EACCES / ENOTDIR / 坏链接 / 竞态）→ 一律判不过，
    // 否则环境异常会把这道守卫悄悄关掉
    return {
      ok: false,
      skipped: false,
      reason: `源码目录读取失败（${error?.code ?? 'UNKNOWN'}）：${error?.message ?? error}`,
    }
  }

  if (actual !== recorded) {
    return {
      ok: false,
      skipped: false,
      reason: `dist 已过期：源码已改但未重新 pack（记录 ${recorded.slice(0, 8)}，当前 ${actual.slice(0, 8)}）`,
      recorded,
      actual,
    }
  }
  return { ok: true, skipped: false, recorded, actual }
}
