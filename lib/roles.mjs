/**
 * 角色层：默认角色的权限边界，以及仓库内配置对默认值的有限覆盖。
 *
 * 安全红线：reviewer 必须只读。任何把 reviewer 提到 full 的配置都直接拒绝，
 * 而不是「先合并、再靠调用方检查」——提权一旦落进配置就迟早会被用上。
 *
 * 覆盖只能落在 ALLOWED_ROLE_FIELDS 上，其余字段（哪怕是拼写错误）一律报 E_ROLE，
 * 避免新增未知字段后静默失效。
 */

/** 角色可覆盖的字段白名单。 */
export const ROLE_FIELDS = Object.freeze([
  'permissionMode',
  'outputContract',
  'model',
  'provider',
  'instructions',
])

export const PERMISSION_MODES = Object.freeze(['full', 'readonly'])

/** 默认角色：executor 可写、reviewer 只读。 */
export const DEFAULT_ROLES = Object.freeze({
  executor: Object.freeze({ permissionMode: 'full', outputContract: 'text' }),
  reviewer: Object.freeze({ permissionMode: 'readonly', outputContract: 'verdict' }),
})

/** reviewer 唯一允许的权限模式。 */
const REVIEWER_PERMISSION = 'readonly'

export class RoleError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'RoleError'
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) deepFreeze(item)
    Object.freeze(value)
  }
  return value
}

function assertNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new RoleError('E_ROLE', `${field} 必须是非空字符串`)
  }
}

/**
 * 校验单个角色的覆盖块。
 * @throws {RoleError} E_ROLE
 */
function normalizeOverride(roleName, raw) {
  if (!isPlainObject(raw)) {
    throw new RoleError('E_ROLE', `roles.${roleName} 必须是对象`)
  }

  for (const key of Object.keys(raw)) {
    if (!ROLE_FIELDS.includes(key)) {
      throw new RoleError('E_ROLE', `roles.${roleName} 存在未知字段: ${key}`)
    }
  }

  if (raw.permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(raw.permissionMode)) {
      throw new RoleError(
        'E_ROLE',
        `roles.${roleName}.permissionMode 只能是 ${PERMISSION_MODES.join(' / ')}`,
      )
    }
    if (roleName === 'reviewer' && raw.permissionMode !== REVIEWER_PERMISSION) {
      throw new RoleError(
        'E_ROLE',
        `reviewer 必须保持 ${REVIEWER_PERMISSION}，拒绝提权为 ${raw.permissionMode}`,
      )
    }
  }
  if (raw.outputContract !== undefined) {
    assertNonEmptyString(raw.outputContract, `roles.${roleName}.outputContract`)
  }
  if (raw.model !== undefined) assertNonEmptyString(raw.model, `roles.${roleName}.model`)
  if (raw.provider !== undefined) assertNonEmptyString(raw.provider, `roles.${roleName}.provider`)
  if (raw.instructions !== undefined && typeof raw.instructions !== 'string') {
    throw new RoleError('E_ROLE', `roles.${roleName}.instructions 必须是字符串`)
  }

  return raw
}

/**
 * 默认角色 + 仓库配置覆盖。
 * @param {{ roles?: Record<string, object> }} [config]
 * @returns {Readonly<Record<string, Readonly<object>>>}
 * @throws {RoleError} E_ROLE
 */
export function resolveRoles(config = {}) {
  if (config === undefined || config === null) config = {}
  if (!isPlainObject(config)) {
    throw new RoleError('E_ROLE', '配置必须是对象')
  }

  const overrides = config.roles === undefined ? {} : config.roles
  if (!isPlainObject(overrides)) {
    throw new RoleError('E_ROLE', 'roles 必须是对象')
  }

  const resolved = {}
  for (const [roleName, defaults] of Object.entries(DEFAULT_ROLES)) {
    resolved[roleName] = { ...defaults }
  }

  for (const [roleName, raw] of Object.entries(overrides)) {
    if (!Object.hasOwn(DEFAULT_ROLES, roleName)) {
      throw new RoleError('E_ROLE', `未知角色: ${roleName}`)
    }
    const override = normalizeOverride(roleName, raw)
    resolved[roleName] = { ...resolved[roleName], ...override }
  }

  return deepFreeze(resolved)
}
