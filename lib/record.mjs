/**
 * 记录层：审核记录与跳过审计的落盘、读取与校验。
 *
 * 记录是事后追溯的唯一凭据，因此：
 *   - 必须带 schemaVersion（结构版本）与 policyVersion（产生它的策略版本）；
 *   - 缺字段、版本不认识、round 越界一律抛错，绝不猜测或补全后静默通过；
 *   - 写入先落临时文件再 rename，避免读到半截 JSON。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { isIoError } from './fs-probe.mjs'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

/** 记录里 policyVersion 的默认来源：本包版本。 */
export const PACKAGE_VERSION = pkg.version
export const SCHEMA_VERSION = 1
export const MAX_ROUND = 3
export const VERDICTS = Object.freeze(['APPROVE', 'REJECT', 'ESCALATE'])
export const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'nit'])
export const SHA_PATTERN = /^[0-9a-f]{40}$/
export const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const REQUIRED_FIELDS = Object.freeze([
  'schemaVersion',
  'policyVersion',
  'pr',
  'round',
  'verdict',
  'head_sha',
  'findings',
  'evidence',
])
// policy 是闸门判高风险的依据；早先它被当成「多余字段」拒收，导致 gate 里
// 的 record.policy?.hit 成了死代码——记录必须能携带它。
const OPTIONAL_FIELDS = Object.freeze([
  'traceId',
  'createdAt',
  'policy',
  'form',
  'provider',
  'model',
  'durationMs',
  'errorCode',
  // 判定产物自带的一次性标记与输入摘要：记录是它们的容器，不能当成多余字段
  'nonce',
  'request',
])
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, ...OPTIONAL_FIELDS])

export class RecordError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'RecordError'
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function reviewsDir(root) {
  return join(root, '.dsh-web', 'reviews')
}

export function recordFile(dir, pr, headSha) {
  return join(dir, `${pr}-${headSha}.json`)
}

/** 与参考实现一致：UTC 紧凑时间戳，供跳过审计文件名使用。 */
export function stamp(date) {
  const iso = date.toISOString()
  return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`
}

export function skipAuditFile(dir, pr, now = new Date()) {
  return join(dir, 'skips', `${stamp(now)}-${pr}.json`)
}

/**
 * 手写校验器（不引 JSON Schema 依赖）。
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRecord(value) {
  const errors = []
  if (!isPlainObject(value)) return { ok: false, errors: ['记录不是对象'] }

  for (const key of Object.keys(value)) {
    if (!ALLOWED_FIELDS.has(key)) errors.push(`多余字段: ${key}`)
  }
  for (const key of REQUIRED_FIELDS) {
    if (!(key in value)) errors.push(`缺少字段: ${key}`)
  }

  if ('schemaVersion' in value && value.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`结构版本不支持: ${String(value.schemaVersion)}`)
  }
  if (
    'policyVersion' in value &&
    (typeof value.policyVersion !== 'string' || !SEMVER_PATTERN.test(value.policyVersion))
  ) {
    errors.push(`policyVersion 必须是包版本字符串: ${String(value.policyVersion)}`)
  }
  if ('pr' in value && (!Number.isInteger(value.pr) || value.pr <= 0)) {
    errors.push(`pr 必须是正整数: ${String(value.pr)}`)
  }
  if (
    'round' in value &&
    (!Number.isInteger(value.round) || value.round < 1 || value.round > MAX_ROUND)
  ) {
    errors.push(`round 必须是 1..${MAX_ROUND} 的整数: ${String(value.round)}`)
  }
  if ('verdict' in value && !VERDICTS.includes(value.verdict)) {
    errors.push(`verdict 非法: ${String(value.verdict)}`)
  }
  if ('head_sha' in value && (typeof value.head_sha !== 'string' || !SHA_PATTERN.test(value.head_sha))) {
    errors.push('head_sha 必须是 40 位小写十六进制')
  }

  if ('findings' in value) {
    if (!Array.isArray(value.findings)) {
      errors.push('findings 必须是数组')
    } else {
      value.findings.forEach((finding, index) => {
        if (!isPlainObject(finding)) {
          errors.push(`findings[${index}] 不是对象`)
          return
        }
        const extra = Object.keys(finding).filter(
          (key) => !['severity', 'file', 'line', 'message'].includes(key),
        )
        if (extra.length > 0) errors.push(`findings[${index}] 多余字段: ${extra.join(',')}`)
        if (!SEVERITIES.includes(finding.severity)) {
          errors.push(`findings[${index}].severity 非法: ${String(finding.severity)}`)
        }
        if (typeof finding.file !== 'string' || finding.file.length === 0) {
          errors.push(`findings[${index}].file 不能为空`)
        }
        if (!Number.isInteger(finding.line) || finding.line < 0) {
          errors.push(`findings[${index}].line 必须是非负整数`)
        }
        if (typeof finding.message !== 'string' || finding.message.length === 0) {
          errors.push(`findings[${index}].message 不能为空`)
        }
      })
    }
  }

  if ('evidence' in value) {
    if (!Array.isArray(value.evidence)) {
      errors.push('evidence 必须是数组')
    } else if (value.evidence.some((item) => typeof item !== 'string' || item.length === 0)) {
      errors.push('evidence 的每一项都必须是非空字符串')
    }
  }

  if ('traceId' in value && (typeof value.traceId !== 'string' || value.traceId.length === 0)) {
    errors.push('traceId 必须是非空字符串')
  }
  if ('provider' in value && (typeof value.provider !== 'string' || value.provider.length === 0)) {
    errors.push('provider 必须是非空字符串')
  }
  if ('form' in value && (typeof value.form !== 'string' || value.form.length === 0)) {
    errors.push('form 必须是非空字符串')
  }
  if (
    'createdAt' in value &&
    (typeof value.createdAt !== 'string' || Number.isNaN(Date.parse(value.createdAt)))
  ) {
    errors.push('createdAt 必须是可解析的 ISO 时间字符串')
  }

  return { ok: errors.length === 0, errors }
}

/**
 * 校验并返回原记录；结构版本不认识时用 E_SCHEMA，其余用 E_RECORD。
 * @throws {RecordError}
 */
export function assertRecord(value) {
  const { ok, errors } = validateRecord(value)
  if (ok) return value
  if (isPlainObject(value) && 'schemaVersion' in value && value.schemaVersion !== SCHEMA_VERSION) {
    throw new RecordError(
      'E_SCHEMA',
      `结构版本不支持: ${String(value.schemaVersion)}（支持 ${SCHEMA_VERSION}）`,
    )
  }
  throw new RecordError('E_RECORD', `记录不合规: ${errors.join('; ')}`)
}

/**
 * 写 <dir>/<pr>-<sha>.json。
 * schemaVersion / policyVersion 缺失时补默认值（结构版本仍是当前版本），其余字段严格校验。
 * @returns {string} 写入的文件路径
 */
export function writeRecord(dir, record, options = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new RecordError('E_RECORD', 'dir 必须是非空字符串')
  }
  if (!isPlainObject(record)) {
    throw new RecordError('E_RECORD', '记录不是对象')
  }
  // —— 自定义文件名：分片审核需要把记录**直接**写成 <pr>-<sha>.shard-i-of-n.json，
  //    而不是先写规范名再删除（那中间有一段「单片判定冒充整份判定」的窗口）。
  const name = options.name
  if (name !== undefined) {
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name) || name.includes('..')) {
      throw new RecordError('E_RECORD', `文件名非法（只允许字母数字与 . _ -，且以 .json 结尾）: ${String(name)}`)
    }
  }

  const candidate = { ...record }
  if (candidate.schemaVersion === undefined) candidate.schemaVersion = SCHEMA_VERSION
  if (candidate.policyVersion === undefined) candidate.policyVersion = PACKAGE_VERSION
  assertRecord(candidate)

  mkdirSync(dir, { recursive: true })
  const target = name === undefined ? recordFile(dir, candidate.pr, candidate.head_sha) : join(dir, name)
  const tmp = `${target}.tmp`
  writeFileSync(tmp, `${JSON.stringify(candidate, null, 2)}\n`, 'utf8')
  renameSync(tmp, target)
  return target
}

/**
 * 读取并校验记录。
 * @throws {RecordError} E_IO / E_PARSE / E_SCHEMA / E_RECORD
 */
export function readRecord(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    // 路径不对（不存在 / 中间是文件 / 本身是目录）= 记录不可用（E_RECORD）；
    // 读不出来（权限 / IO）才是环境错误（E_IO）——与 lib/fs-probe.mjs 的 isIoError 同一口径
    const missing = ['ENOENT', 'ENOTDIR', 'EISDIR']
    const code = missing.includes(error?.code) ? 'E_RECORD' : isIoError(error) ? 'E_IO' : 'E_RECORD'
    throw new RecordError(code, `读取记录失败: ${file}`, { cause: error })
  }

  let value
  try {
    value = JSON.parse(raw)
  } catch (error) {
    throw new RecordError('E_PARSE', `记录不是合法 JSON: ${file}`, { cause: error })
  }

  return assertRecord(value)
}

/**
 * 跳过审计：审计文件也是追溯凭据，因此同样带 policyVersion。
 * @returns {string} 写入的文件路径
 */
export function writeSkipAudit(dir, { pr, headSha = null, reason, now = new Date() } = {}) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new RecordError('E_RECORD', 'dir 必须是非空字符串')
  }
  if (!Number.isInteger(pr) || pr <= 0) {
    throw new RecordError('E_RECORD', `pr 必须是正整数: ${String(pr)}`)
  }
  if (typeof reason !== 'string' || reason.length === 0) {
    throw new RecordError('E_RECORD', 'reason 必须是非空字符串')
  }
  if (headSha !== null && (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha))) {
    throw new RecordError('E_RECORD', 'headSha 必须是 40 位小写十六进制或 null')
  }
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new RecordError('E_RECORD', 'now 必须是合法 Date')
  }

  const file = skipAuditFile(dir, pr, now)
  mkdirSync(dirname(file), { recursive: true })
  const audit = {
    pr,
    head_sha: headSha,
    reason,
    at: now.toISOString(),
    policyVersion: PACKAGE_VERSION,
  }
  writeFileSync(file, `${JSON.stringify(audit, null, 2)}\n`, 'utf8')
  return file
}
