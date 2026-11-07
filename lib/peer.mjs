/**
 * `selftest --peer`：插件的 DSH 版本声明是否覆盖当前 DSH 版本（契约 §9）。
 * 声明按优先级取第一个存在的（与 dsh 插件管理器的「engines.dsh，否则 peer」一致）：
 * `engines.dsh` → `dsh.engines.dsh` → `dsh.compatibility.dsh` → `@deepseek-ai/dsh*` 的 peer 依赖。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { satisfies } from './semver.mjs'

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.tmp', '.dsh-web', '.worktrees'])

/** peerDependencies 里算作「DSH 版本声明」的包名前缀。 */
const DSH_PEER_PREFIX = '@deepseek-ai/dsh'

/** DSH 核心包在消费仓里的安装位置（相对仓库根）。 */
const DSH_PKG_SEGMENTS = ['node_modules', '@deepseek-ai', 'dsh']

/** 读 JSON，坏文件返回 null（一个坏 package.json 不该让整次检查崩掉）。 */
function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 一个包的 `package.json` → 声明列表（可能 0 条或多条 peer）。 */
function requirementsOf(file, pkg) {
  if (!isPlainObject(pkg)) return []
  const name = typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : file
  const found = []

  const engines = isPlainObject(pkg.engines) && typeof pkg.engines.dsh === 'string' ? pkg.engines.dsh : null
  if (engines !== null) return [{ file, name, source: 'engines.dsh', range: engines }]

  const dsh = isPlainObject(pkg.dsh) ? pkg.dsh : null
  const dshEngines = dsh !== null && isPlainObject(dsh.engines) && typeof dsh.engines.dsh === 'string'
    ? dsh.engines.dsh
    : null
  if (dshEngines !== null) return [{ file, name, source: 'dsh.engines.dsh', range: dshEngines }]

  const compatibility =
    dsh !== null && isPlainObject(dsh.compatibility) && typeof dsh.compatibility.dsh === 'string'
      ? dsh.compatibility.dsh
      : null
  if (compatibility !== null) return [{ file, name, source: 'dsh.compatibility.dsh', range: compatibility }]

  // 前三者都没有时，才退到 peer 依赖（与「engines.dsh，否则 peer」的语义一致）
  if (!isPlainObject(pkg.peerDependencies)) return []
  for (const [dep, range] of Object.entries(pkg.peerDependencies)) {
    if (!dep.startsWith(DSH_PEER_PREFIX) || typeof range !== 'string') continue
    found.push({ file, name, source: `peerDependencies.${dep}`, range })
  }
  return found
}

/** 递归收集 `package.json`（跳过生成物与隐藏目录；符号链接不跟随）。 */
function collectPackageFiles(root, out = []) {
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      collectPackageFiles(full, out)
      continue
    }
    if (entry.isFile() && entry.name === 'package.json') out.push(full)
  }
  return out
}

/**
 * 扫一个仓里的所有 DSH 版本声明。
 * @param {string} root 仓库根
 * @returns {{ requirements: {file: string, name: string, source: string, range: string}[], scanned: number }}
 *   `file` 是相对 root 的路径；`scanned` 是扫到的 package.json 个数
 */
export function collectRequirements(root) {
  const files = collectPackageFiles(root)
  const requirements = []
  for (const file of files) {
    const pkg = readJson(file)
    requirements.push(...requirementsOf(relative(root, file), pkg))
  }
  return { requirements, scanned: files.length }
}

/**
 * 从仓里装的 DSH 包读当前版本。
 * @returns {string|null} 读不到（没装 / 没有 version）返回 null
 */
export function resolveDshVersion(root) {
  for (const segments of [DSH_PKG_SEGMENTS, ['tools', ...DSH_PKG_SEGMENTS]]) {
    const file = join(root, ...segments, 'package.json')
    if (!existsSync(file)) continue
    const pkg = readJson(file)
    if (typeof pkg?.version === 'string' && pkg.version.length > 0) return pkg.version
  }
  return null
}

/**
 * `selftest --peer` 的判定。
 * @param {string} root 仓库根
 * @param {{ dshVersion?: string, requirements?: ReturnType<typeof collectRequirements>['requirements'] }} [options]
 * @returns {{ name: 'peer', ok: boolean, detail: string }}
 */
export function checkPeer(root, { dshVersion, requirements } = {}) {
  const collected = requirements ?? collectRequirements(root).requirements
  if (collected.length === 0) {
    return { name: 'peer', ok: true, detail: '未发现声明 DSH 版本的包（跳过）' }
  }
  if (typeof dshVersion !== 'string' || dshVersion.length === 0) {
    return { name: 'peer', ok: false, detail: '无法确定当前 DSH 版本（传 --dsh-version，或在仓里装 @deepseek-ai/dsh）' }
  }

  const failures = collected.filter((item) => !satisfies(dshVersion, item.range))
  if (failures.length === 0) {
    return { name: 'peer', ok: true, detail: `${collected.length} 条声明都覆盖 dsh ${dshVersion}` }
  }

  const shown = failures.map((item) => `${item.name}（${item.source}）声明 "${item.range}"`)
  return {
    name: 'peer',
    ok: false,
    detail: `${failures.length}/${collected.length} 条声明不覆盖 dsh ${dshVersion}: ${shown.join('；')}`,
  }
}
