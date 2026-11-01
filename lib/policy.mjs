/**
 * 高风险策略：把「哪些变更必须升级审核」收敛成纯函数。
 *
 * 不改任何状态、不读盘：同一组输入永远得到同一组理由，
 * 这样策略才能被单测和审计同时信任。
 */

export const MAX_CHANGED_LINES = 400

/** 与参考实现 dsh-subagents/lib/contract.js 对齐的默认规则。 */
export const DEFAULT_HIGH_RISK = Object.freeze([
  Object.freeze({ glob: '.github/**', reason: '改 CI 本身' }),
  Object.freeze({ glob: 'scripts/pipeline/**', reason: '改交付流程本身' }),
  Object.freeze({ glob: 'AGENTS.md', reason: '改规则与流程文档' }),
  Object.freeze({ glob: 'docs/pipeline/**', reason: '改规则与流程文档' }),
  Object.freeze({ glob: '**/.gitignore', reason: '改白名单会让文件静默不入库' }),
  Object.freeze({ glob: '.dsh/profiles/**', reason: '改 agent 配置档' }),
  Object.freeze({
    glob: '**/package.json',
    reason: '依赖变更（供应链风险）',
    requires: 'dependencyChange',
  }),
])

export class PolicyError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 统一分隔符并去掉开头的 ./，否则同一路径会因写法不同而绕过规则。 */
export function normalizePath(path) {
  return String(path)
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
}

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g

/**
 * 只实现策略需要的 glob 子集：`**`（跨目录）、`*`（单层）、`?`（单字符）。
 * 不引 minimatch：多一个依赖，每次改 package.json 都会自己触发高风险闸门。
 */
export function globToRegExp(glob) {
  if (typeof glob !== 'string' || glob.length === 0) {
    throw new PolicyError('E_POLICY', `glob 必须是非空字符串: ${String(glob)}`)
  }
  let source = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1
        if (glob[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(REGEX_SPECIALS, '\\$&')
    }
  }
  return new RegExp(`^${source}$`)
}

/** package.json 的依赖段被改动 = 供应链风险（语义与参考实现一致）。 */
export function dependencyChange(diff) {
  return /^[+-][ \t]*"(dependencies|devDependencies|optionalDependencies)"/m.test(
    String(diff ?? ''),
  )
}

function normalizeEntry(raw, index) {
  if (typeof raw === 'string') {
    if (raw.length === 0) {
      throw new PolicyError('E_POLICY', `highRiskAppend[${index}] 不能是空字符串`)
    }
    return { glob: raw, reason: `自定义高风险路径: ${raw}` }
  }
  if (!isPlainObject(raw)) {
    throw new PolicyError('E_POLICY', `highRiskAppend[${index}] 必须是字符串或对象`)
  }
  if (typeof raw.glob !== 'string' || raw.glob.length === 0) {
    throw new PolicyError('E_POLICY', `highRiskAppend[${index}].glob 必须是非空字符串`)
  }
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length === 0)) {
    throw new PolicyError('E_POLICY', `highRiskAppend[${index}].reason 必须是非空字符串`)
  }
  if (raw.requires !== undefined && raw.requires !== 'dependencyChange') {
    throw new PolicyError('E_POLICY', `highRiskAppend[${index}].requires 只支持 dependencyChange`)
  }
  const entry = { glob: raw.glob, reason: raw.reason ?? `自定义高风险路径: ${raw.glob}` }
  if (raw.requires) entry.requires = raw.requires
  return entry
}

/**
 * 合并默认规则与追加规则（同 glob 时以追加的 reason 为准）。
 * @param {{ highRiskAppend?: Array<string|{glob:string,reason?:string,requires?:string}> }} [options]
 * @returns {{ patterns: ReadonlyArray<{glob:string,reason:string,requires?:string}>, hit: Function }}
 */
export function mergePolicy({ highRiskAppend = [] } = {}) {
  if (!Array.isArray(highRiskAppend)) {
    throw new PolicyError('E_POLICY', 'highRiskAppend 必须是数组')
  }

  const overrides = new Map()
  highRiskAppend.forEach((raw, index) => {
    const entry = normalizeEntry(raw, index)
    overrides.set(entry.glob, entry)
  })

  const patterns = []
  const seen = new Set()
  const push = (entry) => {
    if (seen.has(entry.glob)) return
    seen.add(entry.glob)
    patterns.push(Object.freeze({ ...entry }))
  }

  for (const entry of DEFAULT_HIGH_RISK) push(overrides.get(entry.glob) ?? entry)
  for (const [glob, entry] of overrides) {
    if (!seen.has(glob)) push(entry)
  }

  const compiled = patterns.map((pattern) => ({
    ...pattern,
    matcher: globToRegExp(pattern.glob),
  }))

  /**
   * @param {Array<string|{path:string,diff?:string}>} files 变更文件
   * @param {number} changedLines 变更行数（增删合计）
   * @param {{ diff?: string }} [options] 全局 diff，用于判定依赖变更
   * @returns {{ hit: boolean, reasons: string[] }}
   */
  function hit(files = [], changedLines = 0, options = {}) {
    if (!Array.isArray(files)) {
      throw new PolicyError('E_POLICY', 'files 必须是数组')
    }
    if (!Number.isInteger(changedLines) || changedLines < 0) {
      throw new PolicyError('E_POLICY', `changedLines 必须是非负整数: ${String(changedLines)}`)
    }
    const globalDiff = String(options?.diff ?? '')
    const reasons = []

    for (const item of files) {
      const path = typeof item === 'string' ? item : item?.path
      if (typeof path !== 'string' || path.trim().length === 0) {
        throw new PolicyError('E_POLICY', 'files 的每一项必须是非空路径字符串或 { path } 对象')
      }
      const normalized = normalizePath(path)
      const diff = isPlainObject(item) ? String(item.diff ?? globalDiff) : globalDiff

      for (const pattern of compiled) {
        if (!pattern.matcher.test(normalized)) continue
        if (pattern.requires === 'dependencyChange' && !dependencyChange(diff)) continue
        reasons.push(`${normalized}: ${pattern.reason}`)
      }
    }

    if (changedLines > MAX_CHANGED_LINES) {
      reasons.push(`变更 ${changedLines} 行，超过 ${MAX_CHANGED_LINES} 行上限`)
    }

    return { hit: reasons.length > 0, reasons }
  }

  return { patterns: Object.freeze(patterns), hit }
}
