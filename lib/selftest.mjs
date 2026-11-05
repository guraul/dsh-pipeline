/**
 * selftest 的检查实现（契约 §9 一致性门禁）。
 *
 * 本单只落地 --config 一项；--shims / --peer / --exit-codes 已识别但未实现，
 * 由 CLI 明确报「尚未实现」退 2，不静默忽略。
 *
 * 检查只读不写：没有配置文件是合法状态（跳过、退出 0），文件存在就必须合规。
 * 错误信息沿用 lib/config.mjs 的原文（只带字段名与原因，不打印文件内容）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { CONFIG_PATH, loadConfig } from './config.mjs'

/** 已实现的检查项。 */
export const DONE_CHECKS = Object.freeze(['config'])

/** 已识别但未实现的检查项（契约 §9 的其余门禁）。 */
export const PENDING_CHECKS = Object.freeze(['shims', 'peer', 'exit-codes'])

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
 * 跑指定检查项并汇总。
 * @param {string} root
 * @param {string[]} checks 检查项名（当前只有 'config'）
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }}
 */
export function runChecks(root, checks) {
  const results = checks.map((name) => {
    if (name === 'config') return checkConfig(root)
    throw new Error(`未知检查项: ${name}`)
  })
  return { ok: results.every((item) => item.ok), checks: results }
}
