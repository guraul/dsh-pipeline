/**
 * 锁文件：`.dsh/pipeline.lock.json`（契约 §7.2）。
 *
 * 为什么需要：消费仓用 `file:` 指向会变内容的本地产物，版本号常常不动，只看 SemVer
 * 分不清「装的是哪次打包」。锁文件把「这个仓应该装哪个构建」写成可入库的一行
 * （`<sha7> <builtAt>`），于是漂移既能被 CI 发现，也能在 review 里看见。
 *
 * 两半缺一不可：
 *   - 写入方 `lock write`：消费仓刷新包之后，把当前装包的 build.json 写进锁；
 *   - 读取方 `selftest --lock` / `lock check`：比对「装包」与「锁」，不一致即失败。
 *
 * 状态语义（与 `--config` 的「没有配置是合法状态」对齐）：
 *   - 锁不存在 → 跳过（退 0）：这个仓还没启用锁；
 *   - 装包目录不存在 → 跳过（退 0）：还没 install；
 *   - 装了包但没有 build.json（旧版本包）→ **失败**：无法证明与锁一致；
 *   - 锁与装包不一致 / 锁格式非法 → 失败。
 *
 * 只读硬盘、不跑外部命令：写盘只在 `writeLock`，且用临时文件 + rename，
 * 避免读到半截 JSON。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 锁文件相对仓库根的路径（契约 §7.2）。 */
export const LOCK_PATH = Object.freeze(['.dsh', 'pipeline.lock.json'])

/** 锁文件只允许这一个字段；多一个就报错，避免「随手加字段」把校验变成摆设。 */
const LOCK_FIELDS = Object.freeze(['expect'])

/** `expect` 的格式：7..40 位十六进制 sha + 一个空格 + 非空的构建时间。 */
const EXPECT_PATTERN = /^[0-9a-f]{7,40} [^\s]+$/

/** 共享包在消费仓里的安装位置（相对仓库根），与 doctor / selftest --repos 同源。 */
const PKG_SEGMENTS = Object.freeze(['tools', 'node_modules', 'dsh-pipeline'])

export class LockError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'LockError'
    this.code = code
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 输出里用的相对路径（不拼绝对路径）。 */
const LOCK_LABEL = LOCK_PATH.join('/')

/**
 * 构建标识 → 锁里的 `expect` 值：短 sha7 + 空格 + 打包时间。
 * 不写 `+dirty`：dirty 是打包时的仓库状态，不是构建身份，写进去会让「同一份代码打两次包」对不上。
 */
export function formatExpect(build) {
  if (!isPlainObject(build) || typeof build.gitSha !== 'string' || typeof build.builtAt !== 'string') {
    throw new LockError('E_LOCK', '构建标识必须含 gitSha 与 builtAt 两个字符串')
  }
  return `${build.gitSha.slice(0, 7)} ${build.builtAt}`
}

/**
 * 读并校验锁文件。
 * @returns {{ ok: true, file: string, expect: string } | { ok: true, file: string, expect: null }}
 *   文件不存在时 `expect` 为 null（合法状态：未启用锁）
 * @throws {LockError} 文件存在但格式不合规
 */
export function readLock(root) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new LockError('E_LOCK', 'root 必须是非空字符串')
  }
  const file = join(root, ...LOCK_PATH)
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: true, file, expect: null }
    throw new LockError('E_LOCK', `读取锁文件失败: ${file}`, { cause: error })
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new LockError('E_LOCK', `锁文件不是合法 JSON: ${LOCK_LABEL}`, { cause: error })
  }
  if (!isPlainObject(parsed)) {
    throw new LockError('E_LOCK', `锁文件必须是对象: ${LOCK_LABEL}`)
  }
  for (const key of Object.keys(parsed)) {
    if (!LOCK_FIELDS.includes(key)) throw new LockError('E_LOCK', `锁文件有多余字段: ${key}`)
  }
  if (typeof parsed.expect !== 'string' || !EXPECT_PATTERN.test(parsed.expect)) {
    throw new LockError(
      'E_LOCK',
      `锁文件的 expect 必须是「<7..40 位十六进制 sha> <构建时间>」: ${String(parsed.expect)}`,
    )
  }
  return { ok: true, file, expect: parsed.expect }
}

/**
 * 写锁文件（覆盖）。调用方负责先把构建标识拿到手——本模块不猜、不回退到「源码运行」。
 * @returns {string} 写出的文件绝对路径
 */
export function writeLock(root, build) {
  if (typeof root !== 'string' || root.trim().length === 0) {
    throw new LockError('E_LOCK', 'root 必须是非空字符串')
  }
  const expect = formatExpect(build)
  const file = join(root, ...LOCK_PATH)
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, `${JSON.stringify({ expect }, null, 2)}\n`, 'utf8')
  renameSync(temp, file)
  return file
}

/**
 * 读某个仓里装着的共享包的构建标识。
 * @returns {{ state: 'missing'|'legacy'|'ok', build: {gitSha: string, builtAt: string}|null }}
 *   missing = 没装包；legacy = 装了但没有 build.json（旧版本包）；ok = 读到了
 */
export function readInstalledBuild(root) {
  const pkgDir = join(root, ...PKG_SEGMENTS)
  if (!existsSync(join(pkgDir, 'package.json'))) return { state: 'missing', build: null }
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(join(pkgDir, 'build.json'), 'utf8'))
  } catch {
    return { state: 'legacy', build: null }
  }
  if (typeof parsed?.gitSha !== 'string' || typeof parsed?.builtAt !== 'string') {
    return { state: 'legacy', build: null }
  }
  if (parsed.gitSha.length === 0 || parsed.builtAt.length === 0) return { state: 'legacy', build: null }
  return { state: 'ok', build: { gitSha: parsed.gitSha, builtAt: parsed.builtAt } }
}

/**
 * `selftest --lock` 与 `lock check` 的同一份实现。
 * @param {string} root 仓库根
 * @param {{ installedBuild?: ReturnType<typeof readInstalledBuild> }} [options] 测试注入用
 * @returns {{ name: 'lock', ok: boolean, detail: string }}
 */
export function checkLock(root, { installedBuild } = {}) {
  let lock
  try {
    lock = readLock(root)
  } catch (error) {
    return { name: 'lock', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  if (lock.expect === null) {
    return { name: 'lock', ok: true, detail: `无 ${LOCK_LABEL}（跳过）` }
  }

  const installed = installedBuild ?? readInstalledBuild(root)
  if (installed.state === 'missing') {
    return { name: 'lock', ok: true, detail: `跳过（未装包，锁 ${lock.expect} 未核对）` }
  }
  if (installed.state === 'legacy') {
    return {
      name: 'lock',
      ok: false,
      detail: `已装包但没有 build.json（旧版本包），无法核对锁 ${lock.expect}；请重新打包并刷新依赖`,
    }
  }

  const actual = formatExpect(installed.build)
  if (actual !== lock.expect) {
    return { name: 'lock', ok: false, detail: `锁里是 ${lock.expect}，装的是 ${actual}` }
  }
  return { name: 'lock', ok: true, detail: `与锁一致: ${actual}` }
}
