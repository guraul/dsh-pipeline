/**
 * 探测路径是否存在、能不能读到（契约 §4 的「读盘失败退 3」靠它落地）。
 *
 * 为什么不用 `existsSync`：它对 `EACCES` / `ELOOP` / `ENAMETOOLONG` 等**一律返回 false**，
 * 于是「读不出来」被静默折成「不存在」——该报环境错误的场景变成了跳过。
 * 这里只把「路径确实不存在」判 `missing`，其余 errno 一律 `io-error`。
 */
import { statSync } from 'node:fs'

/** 「确实不存在」的 errno：只有这两种才允许当成 missing。 */
const MISSING_ERRNOS = new Set(['ENOENT', 'ENOTDIR'])

/** 读盘类 errno：这些才是「环境不可用」，业务错误码（E_CONFIG 等）不在此列。 */
const IO_ERRNOS = new Set([
  'EACCES',
  'EPERM',
  'EIO',
  'ELOOP',
  'ENAMETOOLONG',
  'ESTALE',
  'ENODEV',
  'EMFILE',
  'ENFILE',
  'ENOMEM',
  'ETIMEDOUT',
  'EBUSY',
  'EROFS',
])

/** 判断一个异常是不是「读盘失败」（而不是配置 / 校验之类的业务错误）。 */
export function isIoError(error) {
  return IO_ERRNOS.has(error?.code)
}

/**
 * @param {string} path
 * @returns {{kind: 'ok', stat: import('node:fs').Stats} | {kind: 'missing'} | {kind: 'io-error', error: string}}
 */
export function probePath(path) {
  try {
    return { kind: 'ok', stat: statSync(path) }
  } catch (error) {
    if (MISSING_ERRNOS.has(error?.code)) return { kind: 'missing' }
    return { kind: 'io-error', error: error instanceof Error ? error.message : String(error) }
  }
}

/** 只要「存在且可读」，不关心是文件还是目录。 */
export function probeExists(path) {
  const probe = probePath(path)
  return probe.kind === 'ok' ? { kind: 'ok' } : probe
}
