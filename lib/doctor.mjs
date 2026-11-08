/**
 * doctor：跨仓检查「装的共享包是不是同一个构建」。
 *
 * 为什么需要：消费方用 `file:` 指向本地 tarball，版本号常年不变而内容会变，
 * 于是「三个仓到底装的是哪次打包」无从判断（2026-11-03 实测：只能靠新参数能不能用来逐个探测）。
 * 打包时写入 build.json（见 lib/build-info.mjs），这里把各仓的 build.json 读出来对比。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isIoError, probePath } from './fs-probe.mjs'

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
  } catch (error) {
    // 读不出来（权限 / IO）不是「不是源码目录」，要报环境错误
    if (isIoError(error)) return { root, installed: false, build: null, ioError: error.message }
    // 不是包源码目录，按安装目录继续判断
  }
  const pkgDir = join(root, INSTALL)
  const probe = probePath(join(pkgDir, 'package.json'))
  if (probe.kind === 'missing') return { root, installed: false, build: null }
  if (probe.kind === 'io-error') return { root, installed: false, build: null, ioError: probe.error }
  let build = null
  try {
    const parsed = JSON.parse(readFileSync(join(pkgDir, 'build.json'), 'utf8'))
    if (typeof parsed?.gitSha === 'string' && typeof parsed?.builtAt === 'string') {
      build = { gitSha: parsed.gitSha, builtAt: parsed.builtAt, dirty: parsed.dirty === true }
    }
  } catch (error) {
    // 读不出来（权限 / IO）是环境错误；文件不在或内容坏才算「旧版本包」
    if (isIoError(error)) return { root, installed: true, build: null, ioError: error.message }
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
  // 有基准时：装了包但**没有构建标识**（旧版本包）同样算漂移——它必然不是同一个构建，
  // 只是无法证明；漏掉它会让「三仓里一个装旧包」这种情况静默通过。
  const drift = rows
    .filter((row) => {
      if (baseline === null) return false
      if (row.source === true) return false
      if (!row.installed) return false
      return row.build === null || row.build.gitSha !== baseline
    })
    .map((row) => row.root)
  return { rows, baseline, drift }
}
