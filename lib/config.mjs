/**
 * 配置层：读取并校验仓库内的 .dsh/pipeline.json，并把「默认 + 覆盖」收敛成纯函数。
 *
 * 配置是流程的入口，写错一个字段就等于闸门失效，因此：
 *   - 未知字段一律报错，不做静默忽略；
 *   - 没有配置文件是合法状态（返回默认值），但文件存在就必须合规；
 *   - 数组合并采用「追加」语义（默认在前、覆盖在后），避免覆盖把内置规则整段吃掉。
 *
 * 不读环境变量、不打印任何文件内容：错误信息只带字段名与原因。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 配置文件的相对位置（相对仓库根）。 */
export const CONFIG_PATH = ['.dsh', 'pipeline.json']

/** repo 只接受 owner/name 两段，避免把 URL、SSH 地址或空串写进配置。 */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 顶层允许的字段；其余一律 E_CONFIG。 */
export const CONFIG_FIELDS = Object.freeze(['repo', 'ci', 'highRisk', 'roles', 'worktreesDir'])

/** 默认配置：没有 .dsh/pipeline.json 时使用。 */
export const DEFAULT_CONFIG = Object.freeze({
  repo: null,
  ci: Object.freeze([]),
  highRisk: Object.freeze([]),
  roles: Object.freeze({}),
  worktreesDir: null,
})

export class ConfigError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'ConfigError'
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlainObject(value)) {
    const output = {}
    for (const [key, item] of Object.entries(value)) output[key] = clone(item)
    return output
  }
  return value
}

function assertStringArray(value, field) {
  if (!Array.isArray(value)) {
    throw new ConfigError('E_CONFIG', `${field} 必须是字符串数组`)
  }
  value.forEach((item, index) => {
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ConfigError('E_CONFIG', `${field}[${index}] 必须是非空字符串`)
    }
  })
}

/**
 * 校验配置对象（结构层面；角色语义由 roles.mjs 负责）。
 * @throws {ConfigError} E_CONFIG
 */
export function validateConfig(value) {
  if (!isPlainObject(value)) {
    throw new ConfigError('E_CONFIG', '配置必须是对象')
  }

  for (const key of Object.keys(value)) {
    if (!CONFIG_FIELDS.includes(key)) {
      throw new ConfigError('E_CONFIG', `未知字段: ${key}`)
    }
  }

  if (value.repo !== undefined && value.repo !== null) {
    if (typeof value.repo !== 'string' || !REPO_PATTERN.test(value.repo)) {
      throw new ConfigError('E_CONFIG', `repo 必须是 owner/name: ${String(value.repo)}`)
    }
  }
  if (value.ci !== undefined) assertStringArray(value.ci, 'ci')
  if (value.highRisk !== undefined) assertStringArray(value.highRisk, 'highRisk')
  if (value.roles !== undefined && !isPlainObject(value.roles)) {
    throw new ConfigError('E_CONFIG', 'roles 必须是对象')
  }
  // worktreesDir 只接受字符串或 null：非字符串非 null 一律 E_CONFIG，
  // 空字符串放行到 task 层按「非空目录路径」拒绝，避免 schema 与 CLI 两套口径。
  if (value.worktreesDir !== undefined && value.worktreesDir !== null && typeof value.worktreesDir !== 'string') {
    throw new ConfigError('E_CONFIG', `worktreesDir 必须是字符串或 null: ${String(value.worktreesDir)}`)
  }

  return value
}

/**
 * 深合并：对象递归、数组追加（base 在前）、标量以后者为准。
 * @returns {object} 新对象，不修改入参
 */
export function mergeConfig(base = {}, override = {}) {
  if (!isPlainObject(base)) throw new ConfigError('E_CONFIG', 'base 必须是对象')
  if (!isPlainObject(override)) throw new ConfigError('E_CONFIG', 'override 必须是对象')

  const output = clone(base)
  for (const [key, value] of Object.entries(override)) {
    const current = output[key]
    if (Array.isArray(current) && Array.isArray(value)) {
      output[key] = [...clone(current), ...clone(value)]
    } else if (isPlainObject(current) && isPlainObject(value)) {
      output[key] = mergeConfig(current, value)
    } else {
      output[key] = clone(value)
    }
  }
  return output
}

/** 默认配置的新副本（避免调用方改到共享常量）。 */
export function defaultConfig() {
  return clone(DEFAULT_CONFIG)
}

/**
 * 读取 <root>/.dsh/pipeline.json。
 * 文件不存在返回 { ok: true, config: 默认值 }；存在则校验后与默认值合并。
 * @throws {ConfigError} E_CONFIG（JSON 非法、字段不合规）
 */
export function loadConfig(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new ConfigError('E_CONFIG', 'root 必须是非空字符串')
  }

  const file = join(root, ...CONFIG_PATH)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, config: defaultConfig() }
    throw new ConfigError('E_CONFIG', `读取配置失败: ${file}`, { cause: error })
  }

  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new ConfigError('E_CONFIG', `配置不是合法 JSON: ${file}`, { cause: error })
  }

  validateConfig(value)
  return { ok: true, config: mergeConfig(defaultConfig(), value) }
}
