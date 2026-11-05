/**
 * selftest 的检查实现（契约 §9 一致性门禁）。
 *
 * 已落地 --shims / --config；--peer / --exit-codes 已识别但未实现，
 * 由 CLI 明确报「尚未实现」退 2，不静默忽略。
 *
 * 检查只读不写：没有配置文件是合法状态（跳过、退出 0），文件存在就必须合规；
 * --shims 的比对逻辑复用 lib/shim.mjs（shim check 同一份），这里只包一层检查项形态。
 * 错误信息沿用 lib/config.mjs 的原文（只带字段名与原因，不打印文件内容）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_PATH, loadConfig } from './config.mjs'
import { SHIM_DIR, checkShims as compareShims } from './shim.mjs'

/** 已实现的检查项。 */
export const DONE_CHECKS = Object.freeze(['shims', 'config'])

/** 已识别但未实现的检查项（契约 §9 的其余门禁）。 */
export const PENDING_CHECKS = Object.freeze(['peer', 'exit-codes'])

/** 配置文件相对 root 的路径（输出里用它，不拼绝对路径）。 */
const CONFIG_FILE_LABEL = CONFIG_PATH.join('/')

/**
 * --config：<root>/.dsh/pipeline.json 能否被 schema 接受、有没有未声明字段。
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkConfig(root) {
  const file = join(root, ...CONFIG_PATH)
  if (!existsSync(file)) {
    return { name: 'config', ok: true, detail: `无 ${CONFIG_FILE_LABEL}（跳过）` }
  }
  try {
    loadConfig(root)
  } catch (error) {
    return { name: 'config', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  return { name: 'config', ok: true, detail: '配置 OK' }
}

/**
 * --shims：6 个入口是否等于按当前包版本渲染后的模板。
 * 比对本体在 lib/shim.mjs（与 shim check 同一份），这里只把结果包成检查项形态。
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkShimsEntry(root) {
  const result = compareShims(root)
  if (result.missingDir) {
    return { name: 'shims', ok: false, detail: `${SHIM_DIR} 不存在，请先运行 shim install` }
  }
  if (!result.ok) {
    return { name: 'shims', ok: false, detail: `入口与模板不一致: ${result.mismatches.join(', ')}` }
  }
  return { name: 'shims', ok: true, detail: '6 个入口与模板一致' }
}

/**
 * 跑指定检查项并汇总。
 * @param {string} root
 * @param {string[]} checks 检查项名（shims / config）
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }}
 */
export function runChecks(root, checks) {
  const results = checks.map((name) => {
    if (name === 'config') return checkConfig(root)
    if (name === 'shims') return checkShimsEntry(root)
    throw new Error(`未知检查项: ${name}`)
  })
  return { ok: results.every((item) => item.ok), checks: results }
}
