/**
 * 入口 shim 的生成与校验（契约 §8）。
 *
 * 单一事实源在这里：模板渲染（{{VERSION}} / {{CMD}}）、6 个入口的文件名与
 * 目标子命令映射、install 的写入/跳过/冲突判定、check 的逐字节比对。
 * CLI 与 selftest --shims 都只调本文件，不复制比对逻辑。
 *
 * check 的判据固定为「先用当前包版本渲染模板，再与磁盘逐字节比对」——
 * 文件头内嵌版本号，直接比模板原文会永远假红（契约 §8）。
 * 输出口径：面向人的信息走 stdout，错误走 stderr，全部中文；由调用方决定打印。
 */
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PACKAGE_VERSION } from './record.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE_FILE = join(PACKAGE_ROOT, 'templates', 'shim.sh')

/** 入口目录相对仓库根的路径。 */
export const SHIM_DIR = 'scripts/pipeline'

/** 6 个入口：文件名 → 目标子命令（pipeline.sh 为空，原样透传第一个参数）。 */
export const SHIM_ENTRIES = Object.freeze([
  { file: 'pipeline.sh', cmd: '' },
  { file: 'new-task.sh', cmd: 'task' },
  { file: 'open-pr.sh', cmd: 'pr' },
  { file: 'merge-pr.sh', cmd: 'merge' },
  { file: 'review.sh', cmd: 'review' },
  { file: 'status.sh', cmd: 'status' },
])

/** 用当前包版本与目标子命令渲染模板。 */
export function renderShim(cmd) {
  const template = readFileSync(TEMPLATE_FILE, 'utf8')
  return template.replaceAll('{{VERSION}}', PACKAGE_VERSION).replaceAll('{{CMD}}', cmd)
}

/** 读磁盘文件内容；读不到（不存在 / 不可读）返回 null，不当异常抛给调用方。 */
function readIfExists(file) {
  if (!existsSync(file)) return null
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * shim install：把 6 个入口写进 <root>/scripts/pipeline/（0755）。
 *
 * 两段式：先对全部入口做「相同 / 不同 / 缺失」判定，有冲突且没给 --force 时
 * 一个文件都不写——半装状态比明确失败更难排查。
 * @returns {{ ok: true, written: string[], skipped: number } | { ok: false, conflicts: string[] }}
 */
export function installShims(root, { force = false } = {}) {
  const dir = join(root, SHIM_DIR)

  const plan = []
  const conflicts = []
  for (const entry of SHIM_ENTRIES) {
    const path = join(dir, entry.file)
    const content = renderShim(entry.cmd)
    const existing = readIfExists(path)
    if (existing === null) plan.push({ entry, path, content, action: 'write' })
    else if (existing === content) plan.push({ entry, path, content, action: 'skip' })
    else if (force) plan.push({ entry, path, content, action: 'overwrite' })
    else conflicts.push(entry.file)
  }
  if (conflicts.length > 0) return { ok: false, conflicts }

  mkdirSync(dir, { recursive: true })
  const written = []
  for (const item of plan) {
    if (item.action === 'skip') continue
    writeFileSync(item.path, item.content, { mode: 0o755 })
    // umask 会吃掉 writeFileSync 的 mode，显式 chmod 一次保证 0755
    chmodSync(item.path, 0o755)
    written.push(`${SHIM_DIR}/${item.entry.file}`)
  }
  return { ok: true, written, skipped: plan.length - written.length }
}

/**
 * shim check / selftest --shims 共用的比对：当前包版本渲染 → 与磁盘逐字节比对。
 * @returns {{ ok: boolean, missingDir: boolean, dir: string, mismatches: string[] }}
 */
export function checkShims(root) {
  const dir = join(root, SHIM_DIR)
  let isDirectory = false
  try {
    isDirectory = statSync(dir).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) return { ok: false, missingDir: true, dir, mismatches: [], extras: [] }

  const mismatches = []
  for (const entry of SHIM_ENTRIES) {
    const expected = renderShim(entry.cmd)
    if (readIfExists(join(dir, entry.file)) !== expected) mismatches.push(entry.file)
  }

  // 反向检查（契约 §11）：目录里除了这 6 个生成物，不允许有仓库私有文件。
  // 隐藏文件也算——漏判比误判贵：私有脚本躺在这里正是这条规则要拦的。
  const known = new Set(SHIM_ENTRIES.map((entry) => entry.file))
  let extras = []
  try {
    extras = readdirSync(dir)
      .filter((name) => !known.has(name))
      .sort()
  } catch {
    extras = []
  }

  return {
    ok: mismatches.length === 0 && extras.length === 0,
    missingDir: false,
    dir,
    mismatches,
    extras,
  }
}
