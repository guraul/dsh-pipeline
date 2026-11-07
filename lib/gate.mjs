/**
 * 审核闸门：把「这条审核记录能不能作为合并依据」收敛成纯函数。
 *
 * 判定顺序与 ADR-0003、self-dsh-plugins 的 assertGate 一致：
 * 先看记录本身是否可读（E_RECORD / E_SCHEMA），再看结论与对象（E_VERDICT / E_SHA_MISMATCH），
 * 再看时效与策略（E_EXPIRED / E_POLICY / E_POLICY_VERSION）。
 * 顺序本身就是语义：前面的项不成立时，后面的项没有意义。
 *
 * 无 IO、不直接读时钟：now 由调用方传入，缺省才取当前时间，
 * 这样同一组输入永远得到同一结论，单测与审计可以复现。
 */
import { MAX_ROUND, SCHEMA_VERSION } from './record.mjs'

/** 审核记录默认有效期：24 小时。 */
export const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000

const VERDICT_APPROVE = 'APPROVE'

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deny(code, reason) {
  return { ok: false, code, reason }
}

/** 接受 Date / ISO 字符串 / 毫秒数；不可解析返回 null。 */
function toTime(value) {
  if (value instanceof Date) {
    const time = value.getTime()
    return Number.isNaN(time) ? null : time
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.length > 0) {
    const time = Date.parse(value)
    return Number.isNaN(time) ? null : time
  }
  return null
}

/**
 * 记录入参可能是已解析对象，也可能是原始 JSON 文本。
 * 解析失败不猜测、不补全，直接按「不可解析」处理。
 */
function resolveRecord(record) {
  if (typeof record === 'string') {
    try {
      return JSON.parse(record)
    } catch {
      return undefined
    }
  }
  return record
}

function describeHits(policy) {
  const reasons = Array.isArray(policy?.reasons) ? policy.reasons : []
  const paths = reasons
    .map((item) => (typeof item === 'string' ? item.split(':')[0].trim() : ''))
    .filter((item) => item.length > 0)
  return paths.length > 0 ? paths.join('; ') : '未列出具体路径'
}

/**
 * @param {{
 *   record?: unknown,
 *   headSha?: string,
 *   currentPolicyVersion?: string,
 *   now?: Date|string|number,
 *   ttlMs?: number,
 * }} input
 * @returns {{ ok: true } | { ok: false, code: string, reason: string }}
 */
export function evaluateGate({
  record,
  headSha,
  currentPolicyVersion,
  now,
  ttlMs = DEFAULT_TTL_MS,
  maxRounds = MAX_ROUND,
} = {}) {
  const candidate = resolveRecord(record)
  if (!isPlainObject(candidate)) {
    return deny('E_RECORD', '审核记录缺失或无法解析')
  }

  if (candidate.schemaVersion !== SCHEMA_VERSION) {
    if (candidate.schemaVersion === undefined) {
      return deny('E_RECORD', '审核记录缺少 schemaVersion')
    }
    return deny(
      'E_SCHEMA',
      `结构版本不支持: ${String(candidate.schemaVersion)}（支持 ${SCHEMA_VERSION}）`,
    )
  }

  const round = candidate.round
  if (!Number.isInteger(round) || round < 1 || round > maxRounds) {
    return deny('E_RECORD', `round 必须是 1..${maxRounds} 的整数: ${String(round)}`)
  }

  if (candidate.verdict !== VERDICT_APPROVE) {
    const errorCode = candidate.errorCode ?? '无错误码'
    return deny('E_VERDICT', `判定为 ${String(candidate.verdict)}（${errorCode}），拒绝合并`)
  }

  if (candidate.head_sha !== headSha) {
    return deny(
      'E_SHA_MISMATCH',
      `判定针对 ${String(candidate.head_sha)}，当前 head 为 ${String(headSha)}，判定已作废`,
    )
  }

  const createdAt = toTime(candidate.createdAt)
  if (createdAt === null) {
    return deny('E_RECORD', `createdAt 缺失或无法解析: ${String(candidate.createdAt)}`)
  }
  const nowTime = now === undefined ? Date.now() : toTime(now)
  if (nowTime === null) {
    return deny('E_RECORD', `now 不是合法时间: ${String(now)}`)
  }
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? ttlMs : DEFAULT_TTL_MS
  if (nowTime - createdAt > ttl) {
    return deny(
      'E_EXPIRED',
      `审核记录已过期（创建于 ${new Date(createdAt).toISOString()}，有效期 ${ttl}ms）`,
    )
  }

  if (candidate.policy?.hit) {
    return deny('E_POLICY', `命中高风险路径 ${describeHits(candidate.policy)}，必须人工放行`)
  }

  if (candidate.policyVersion !== currentPolicyVersion) {
    return deny(
      'E_POLICY_VERSION',
      `记录按 ${String(candidate.policyVersion)} 审核，当前规则版本为 ${String(currentPolicyVersion)}，需按新规则复审`,
    )
  }

  return { ok: true }
}
