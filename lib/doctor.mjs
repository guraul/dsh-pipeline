/**
 * doctor：跨仓检查「装的共享包是不是同一个构建」。
 *
 * 为什么需要：消费方用 `file:` 指向本地 tarball，版本号常年不变而内容会变，
 * 于是「三个仓到底装的是哪次打包」无从判断（2026-11-03 实测：只能靠新参数能不能用来逐个探测）。
 * 打包时写入 build.json（见 lib/build-info.mjs），这里把各仓的 build.json 读出来对比。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 相对一个仓库根，包安装位置。 */
const INSTALL = join('tools', 'node_modules', 'dsh-pipeline')

/**
 * 读某个仓里装着的包的构建信息。
 * @returns {{root: string, installed: boolean, build: object|null}}
 */
export function inspectRepo(root) {
  // 直接指向包源码目录时，报告「源码」而不是「未安装」
  try {
    const own = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (typeof own?.name === 'string' && own.name.endsWith('/dsh-pipeline')) {
      return { root, installed: true, source: true, build: null }
    }
    if (own?.name === 'dsh-pipeline') return { root, installed: true, source: true, build: null }
  } catch {
    // 不是包源码目录，按安装目录继续判断
  }
  const pkgDir = join(root, INSTALL)
  if (!existsSync(join(pkgDir, 'package.json'))) return { root, installed: false, build: null }
  let build = null
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, 'build.json'), 'utf8'))
    if (typeof parsed?.gitSha === 'string' && typeof parsed?.builtAt === 'string') {
      build = { gitSha: parsed.gitSha, builtAt: parsed.builtAt, dirty: parsed.dirty === true }
    }
  } catch {
    // 老版本包没有 build.json：能区分「没装」与「装了但没有标识」，所以不报错
    build = null
  }
  return { root, installed: true, build }
}

/** 给一行结果做人类可读描述。 */
export function describeRow(row) {
  if (row.source === true) return '源码目录（未打包）'
  if (!row.installed) return '未安装'
  if (row.build === null) return '已安装（无构建标识：旧版本包，需重新打包并刷新）'
  return `${row.build.gitSha.slice(0, 7)}${row.build.dirty ? '+dirty' : ''} ${row.build.builtAt}`
}

/**
 * 汇总：以第一个带构建标识的仓为基准，其余与之比较。
 * @returns {{rows: object[], baseline: string|null, drift: string[]}}
 */
export function diagnose(roots) {
  const rows = roots.map((root) => inspectRepo(root))
  const withBuild = rows.filter((row) => row.build !== null)
  const baseline = withBuild.length > 0 ? withBuild[0].build.gitSha : null
  const drift = rows
    .filter((row) => row.build !== null && baseline !== null && row.build.gitSha !== baseline)
    .map((row) => row.root)
  return { rows, baseline, drift }
}
