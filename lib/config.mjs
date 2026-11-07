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
import { MAX_ROUND } from './record.mjs'

/** 配置文件的相对位置（相对仓库根）。 */
export const CONFIG_PATH = ['.dsh', 'pipeline.json']

/** repo 只接受 owner/name 两段，避免把 URL、SSH 地址或空串写进配置。 */
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 顶层允许的字段；其余一律 E_CONFIG。 */
export const CONFIG_FIELDS = Object.freeze([
  'repo',
  'ci',
  'highRisk',
  'roles',
  'worktreesDir',
  'checks',
  'review',
  'deploy',
])

/** checks 内允许的键；其余一律 E_CONFIG。 */
export const CHECKS_FIELDS = Object.freeze(['packages', 'exclude'])

/** deploy 内允许的键；其余一律 E_CONFIG。 */
export const DEPLOY_FIELDS = Object.freeze([
  'artifact',
  'service',
  'remoteDir',
  'workDir',
  'artifactDir',
  'sshHost',
  'qualityCmd',
  'buildCmd',
  'paths',
  'linkPaths',
  'health',
  'keepReleases',
])

/**
 * 产物类型。static-dir / node-standalone 可生成骨架；oci-image 先只接受（schema 层合法），
 * 生成骨架时明确报「尚未实现」退 2——提前拒配置比「配置过了、生成时才炸」更早暴露，
 * 但生成必须显式失败，不许静默降级。
 */
export const DEPLOY_ARTIFACTS = Object.freeze(['static-dir', 'node-standalone', 'oci-image'])

/** review 内允许的键；其余一律 E_CONFIG。 */
export const REVIEW_FIELDS = Object.freeze(['tier', 'postReview', 'identity', 'rounds'])

/** review.identity 内允许的键；其余一律 E_CONFIG。 */
export const REVIEW_IDENTITY_FIELDS = Object.freeze(['ghConfigDir', 'account'])

/** 审核轮次上限的允许区间：只能把默认上限往下收，不能超过记录层能写的 `MAX_ROUND`。 */
export const REVIEW_ROUNDS_MIN = 1
export const REVIEW_ROUNDS_MAX = MAX_ROUND

/**
 * 审核档位：inline = 审核方没有工具权限，只看控制面内联的材料；
 * tools = 审核方可读仓库、跑只读命令核验断言。缺省 tools（与加入档位前的行为一致）。
 */
export const REVIEW_TIERS = Object.freeze(['inline', 'tools'])

/** deploy.health 内允许的键；其余一律 E_CONFIG。 */
export const DEPLOY_HEALTH_FIELDS = Object.freeze(['url', 'check', 'publicUrl', 'insecure'])

/** 健康检查方式：http 在 runner 上探，ssh 上服务器探本地端口（与 deploy.yml 的 input 对齐）。 */
export const DEPLOY_HEALTH_CHECKS = Object.freeze(['http', 'ssh'])

/** 默认配置：没有 .dsh/pipeline.json 时使用。 */
export const DEFAULT_CONFIG = Object.freeze({
  repo: null,
  ci: Object.freeze([]),
  highRisk: Object.freeze([]),
  roles: Object.freeze({}),
  worktreesDir: null,
  checks: null,
  review: Object.freeze({ tier: 'tools', postReview: false, identity: null, rounds: 3 }),
  deploy: null,
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

/** 非空字符串（只用于配置字段的形态校验，不做路径展开）。 */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
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
 * 校验 deploy 段（结构层面；默认值由 lib/deploy.mjs 的 resolveDeploy 补齐）。
 * 必填：artifact / service / remoteDir / workDir / health.url。
 * 可选字段（artifactDir / sshHost / qualityCmd / buildCmd / paths / linkPaths / health.publicUrl / health.insecure）
 * 接受「缺省或 null = 未设置」，给值就必须是对应类型。
 * @throws {ConfigError} E_CONFIG
 */
function validateDeploy(value) {
  if (!isPlainObject(value)) {
    throw new ConfigError('E_CONFIG', `deploy 必须是对象或 null: ${String(value)}`)
  }
  for (const key of Object.keys(value)) {
    if (!DEPLOY_FIELDS.includes(key)) {
      throw new ConfigError('E_CONFIG', `deploy 未知字段: ${key}`)
    }
  }

  if (value.artifact === undefined) {
    throw new ConfigError('E_CONFIG', `deploy.artifact 必填（${DEPLOY_ARTIFACTS.join(' | ')}）`)
  }
  if (!DEPLOY_ARTIFACTS.includes(value.artifact)) {
    throw new ConfigError('E_CONFIG', `deploy.artifact 只能是 ${DEPLOY_ARTIFACTS.join(' | ')}: ${String(value.artifact)}`)
  }
  if (typeof value.service !== 'string' || value.service.trim().length === 0) {
    throw new ConfigError('E_CONFIG', `deploy.service 必须是非空字符串: ${String(value.service)}`)
  }
  if (typeof value.remoteDir !== 'string' || value.remoteDir.trim().length === 0) {
    throw new ConfigError('E_CONFIG', `deploy.remoteDir 必须是非空字符串: ${String(value.remoteDir)}`)
  }
  if (!value.remoteDir.startsWith('/')) {
    throw new ConfigError('E_CONFIG', `deploy.remoteDir 必须是绝对路径: ${value.remoteDir}`)
  }

  if (typeof value.workDir !== 'string' || value.workDir.trim().length === 0) {
    throw new ConfigError('E_CONFIG', `deploy.workDir 必须是非空字符串（deploy.yml 的 work_dir 是必填）: ${String(value.workDir)}`)
  }
  for (const key of ['artifactDir', 'sshHost']) {
    const item = value[key]
    if (item !== undefined && item !== null && typeof item !== 'string') {
      throw new ConfigError('E_CONFIG', `deploy.${key} 必须是字符串: ${String(item)}`)
    }
  }

  // qualityCmd / buildCmd 是 deploy.yml 的构建步骤参数（契约 §10）：
  // 可选，缺省或 null = 未设置（不渲染该行）；给了就必须是非空字符串。
  for (const key of ['qualityCmd', 'buildCmd']) {
    const item = value[key]
    if (item === undefined || item === null) continue
    if (typeof item !== 'string' || item.trim().length === 0) {
      throw new ConfigError('E_CONFIG', `deploy.${key} 必须是非空字符串: ${String(item)}`)
    }
  }

  // paths 是 on.push 的路径过滤：可选，缺省或 null = 未设置（不渲染，保持「任何 push 到 main 都部署」）；
  // 给了就必须是非空字符串数组——空数组不渲染等于悄悄丢掉过滤，直接按配置错误拒绝。
  const paths = value.paths
  if (paths !== undefined && paths !== null) {
    assertStringArray(paths, 'deploy.paths')
    if (paths.length === 0) {
      throw new ConfigError('E_CONFIG', 'deploy.paths 必须是非空数组（不配就整个省略）')
    }
  }

  // linkPaths 是 deploy.yml 的 link_paths（release 内持久化路径软链）：可选，缺省或 null = 未设置
  // （不渲染，workflow 里该步骤整步跳过）；给了就必须是非空字符串数组（空数组不渲染等于悄悄丢掉软链，
  // 同 paths 一律拒绝），且每项必须含 '='（相对路径=目标），否则 workflow 侧配不出来。
  const linkPaths = value.linkPaths
  if (linkPaths !== undefined && linkPaths !== null) {
    assertStringArray(linkPaths, 'deploy.linkPaths')
    if (linkPaths.length === 0) {
      throw new ConfigError('E_CONFIG', 'deploy.linkPaths 必须是非空数组（不配就整个省略）')
    }
    linkPaths.forEach((item, index) => {
      if (!item.includes('=')) {
        throw new ConfigError('E_CONFIG', `deploy.linkPaths[${index}] 必须是「相对路径=目标」（含 '='）: ${item}`)
      }
      // rel 会拼成远端 `releases/<id>/<rel>` 这个链接位置（随后 rm -f + ln -s），任其含 ..
      // 链接就会建到 release 之外（rel=../../data 正好落在要保护的持久化库位置上）。
      // 绝对路径同理；',' 是 link_paths 的分隔符，含逗号会被拆碎。
      const rel = item.slice(0, item.indexOf('=')).trim()
      if (rel.startsWith('/')) {
        throw new ConfigError('E_CONFIG', `deploy.linkPaths[${index}] 的路径必须是相对路径: ${rel}`)
      }
      if (rel.split('/').includes('..')) {
        throw new ConfigError('E_CONFIG', `deploy.linkPaths[${index}] 的路径不许含 '..'（会逃出 release 目录）: ${rel}`)
      }
      if (rel.includes(',')) {
        throw new ConfigError('E_CONFIG', `deploy.linkPaths[${index}] 的路径不许含 ','（分隔符）: ${rel}`)
      }
    })
  }

  if (value.health === undefined || value.health === null || !isPlainObject(value.health)) {
    throw new ConfigError('E_CONFIG', `deploy.health 必填对象: ${String(value.health)}`)
  }
  for (const key of Object.keys(value.health)) {
    if (!DEPLOY_HEALTH_FIELDS.includes(key)) {
      throw new ConfigError('E_CONFIG', `deploy.health 未知字段: ${key}`)
    }
  }
  if (typeof value.health.url !== 'string') {
    throw new ConfigError('E_CONFIG', `deploy.health.url 必填字符串: ${String(value.health.url)}`)
  }
  if (value.health.check !== undefined && value.health.check !== null) {
    if (!DEPLOY_HEALTH_CHECKS.includes(value.health.check)) {
      throw new ConfigError(
        'E_CONFIG',
        `deploy.health.check 只能是 ${DEPLOY_HEALTH_CHECKS.join(' | ')}: ${String(value.health.check)}`,
      )
    }
  }
  if (value.health.publicUrl !== undefined && value.health.publicUrl !== null && typeof value.health.publicUrl !== 'string') {
    throw new ConfigError('E_CONFIG', `deploy.health.publicUrl 必须是字符串: ${String(value.health.publicUrl)}`)
  }
  if (value.health.insecure !== undefined && value.health.insecure !== null && typeof value.health.insecure !== 'boolean') {
    throw new ConfigError('E_CONFIG', `deploy.health.insecure 必须是布尔: ${String(value.health.insecure)}`)
  }

  const keep = value.keepReleases
  if (keep !== undefined && keep !== null) {
    if (!Number.isInteger(keep)) {
      throw new ConfigError('E_CONFIG', `deploy.keepReleases 必须是整数: ${String(keep)}`)
    }
    if (keep < 1 || keep > 50) {
      throw new ConfigError('E_CONFIG', `deploy.keepReleases 必须在 1..50: ${keep}`)
    }
  }
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
  // checks 只接受 null 或对象；对象里只认 packages / exclude 两个字符串数组键
  // （由 check-all 消费：packages 是显式包清单、exclude 过滤自动发现）。
  if (value.checks !== undefined && value.checks !== null) {
    if (!isPlainObject(value.checks)) {
      throw new ConfigError('E_CONFIG', `checks 必须是对象或 null: ${String(value.checks)}`)
    }
    for (const key of Object.keys(value.checks)) {
      if (!CHECKS_FIELDS.includes(key)) {
        throw new ConfigError('E_CONFIG', `checks 未知字段: ${key}`)
      }
    }
    if (value.checks.packages !== undefined) assertStringArray(value.checks.packages, 'checks.packages')
    if (value.checks.exclude !== undefined) assertStringArray(value.checks.exclude, 'checks.exclude')
  }

  // review 只接受对象（契约 §7.3 的审核档位）；tier 缺省 tools，给了就必须是枚举值
  if (value.review !== undefined) {
    if (!isPlainObject(value.review)) {
      throw new ConfigError('E_CONFIG', `review 必须是对象: ${String(value.review)}`)
    }
    for (const key of Object.keys(value.review)) {
      if (!REVIEW_FIELDS.includes(key)) {
        throw new ConfigError('E_CONFIG', `review 未知字段: ${key}`)
      }
    }
    if (value.review.tier !== undefined && !REVIEW_TIERS.includes(value.review.tier)) {
      throw new ConfigError(
        'E_CONFIG',
        `review.tier 只能是 ${REVIEW_TIERS.join(' | ')}: ${String(value.review.tier)}`,
      )
    }
    // postReview：配置层默认发送 review（等价于每次带 --post-review）
    if (value.review.postReview !== undefined && typeof value.review.postReview !== 'boolean') {
      throw new ConfigError('E_CONFIG', `review.postReview 必须是布尔值: ${String(value.review.postReview)}`)
    }
    // identity：发 review 用的身份（GH_CONFIG_DIR 与账号校验）
    if (value.review.identity !== undefined && value.review.identity !== null) {
      if (!isPlainObject(value.review.identity)) {
        throw new ConfigError('E_CONFIG', `review.identity 必须是对象: ${String(value.review.identity)}`)
      }
      for (const key of Object.keys(value.review.identity)) {
        if (!REVIEW_IDENTITY_FIELDS.includes(key)) {
          throw new ConfigError('E_CONFIG', `review.identity 未知字段: ${key}`)
        }
      }
      if (value.review.identity.ghConfigDir !== undefined && !nonEmptyString(value.review.identity.ghConfigDir)) {
        throw new ConfigError('E_CONFIG', `review.identity.ghConfigDir 必须是非空字符串: ${String(value.review.identity.ghConfigDir)}`)
      }
      if (value.review.identity.account !== undefined && !nonEmptyString(value.review.identity.account)) {
        throw new ConfigError('E_CONFIG', `review.identity.account 必须是非空字符串: ${String(value.review.identity.account)}`)
      }
    }
    // rounds：审核轮次上限，超限即「人在环」
    if (value.review.rounds !== undefined) {
      const rounds = value.review.rounds
      if (!Number.isInteger(rounds) || rounds < REVIEW_ROUNDS_MIN || rounds > REVIEW_ROUNDS_MAX) {
        throw new ConfigError(
          'E_CONFIG',
          `review.rounds 必须是 ${REVIEW_ROUNDS_MIN}..${REVIEW_ROUNDS_MAX} 的整数: ${String(rounds)}`,
        )
      }
    }
  }

  // deploy 只接受 null 或对象（契约 §10 的部署配置）；对象内逐键校验，未知键 E_CONFIG
  if (value.deploy !== undefined && value.deploy !== null) {
    validateDeploy(value.deploy)
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
