/**
 * semver 的最小子集（零依赖，供 `selftest --peer` 判断「范围是否覆盖当前 DSH 版本」）。
 *
 * 只覆盖本机插件真实用到的写法：`^` / `~` / `>=` / `>` / `<=` / `<` / `=` / 裸版本（精确）/
 * `*` 与 `x`、`X` 通配，以及 `||` 或选、空格分隔的与选。不支持 `-` 区间（`1.2.3 - 2.0.0`）、
 * `<=1.2` 这类省略补丁号的简写、以及 `1.x` / `^0.2.x` 这类带数字的通配（只认裸 `*` / `x` / `X`）——
 * 遇到就按「无法解析」返回 false，不猜。
 *
 * 三条容易写错、必须钉住的语义（都有测试）：
 *   1. 预发布按 semver §11 比较：数字段按数值、字母段按字典序、数字段小于字母段、
 *      「有预发布」小于「同版本无预发布」；
 *   2. **不施加 npm 的「同段预发布闸门」**：`node-semver` 要求版本与某个比较器
 *      的 `major.minor.patch` 相同才允许命中，于是 `0.2.2-rc.1` 不满足 `^0.2.1-rc.2`。
 *      DSH 自己常发 rc，插件的声明（`^0.2.1-rc.2 || …`）在官方兼容表里是覆盖
 *      `0.2.2-rc.1` 的；照搬闸门会让 `--peer` 对真实声明全是假警报。这里按
 *      「范围是否覆盖这个版本」的直觉语义判定，偏离写在测试里，不留给读者猜。
 *   3. `^0.0.x` 的上界是 `<0.0.(x+1)`，不是 `<1.0.0`。
 */
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

/** 比较器前缀：长的放前面，避免 `>=` 被当成 `>` + `=1.2.3`。 */
const OPERATORS = ['>=', '<=', '>', '<', '=', '^', '~']

/**
 * 解析版本串。
 * @param {string} text 形如 `1.2.3`、`1.2.3-rc.1`、`1.2.3+build`
 * @returns {{major: number, minor: number, patch: number, pre: string[]}|null}
 */
export function parseVersion(text) {
  if (typeof text !== 'string') return null
  const match = VERSION_PATTERN.exec(text.trim())
  if (match === null) return null
  const pre = match[4] === undefined ? [] : match[4].split('.')
  for (const identifier of pre) {
    if (identifier === '') return null
    // 数字标识符不允许前导零（semver §9），`1.0.0-01` 是非法版本
    if (/^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith('0')) return null
  }
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/**
 * 只有数字的标识符按数值比，其余按字典序比；数字标识符小于字母标识符。
 * 数字标识符先比长度再比字典序（解析时已拒绝前导零），因此不受 Number 精度上限影响。
 */
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) {
    if (a.length !== b.length) return a.length < b.length ? -1 : 1
    if (a === b) return 0
    return a < b ? -1 : 1
  }
  if (aNumeric) return -1
  if (bNumeric) return 1
  if (a === b) return 0
  return a < b ? -1 : 1
}

/** 把「版本串或已解析对象」归一成对象；其它类型（数字、null、缺字段）一律 null。 */
function toVersion(value) {
  if (typeof value === 'string') return parseVersion(value)
  if (value === null || typeof value !== 'object') return null
  const { major, minor, patch, pre } = value
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) return null
  if (!Array.isArray(pre)) return null
  return { major, minor, patch, pre }
}

/**
 * 比较两个版本：a < b → -1，相等 → 0，a > b → 1。build 元数据不参与比较。
 * 任一侧无法解析时抛错——调用方应先 `parseVersion`。
 */
export function compare(a, b) {
  const left = toVersion(a)
  const right = toVersion(b)
  if (left === null || right === null) {
    throw new Error(`无法比较的版本: ${String(a)} / ${String(b)}`)
  }
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  // 无预发布 > 有预发布
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const length = Math.max(left.pre.length, right.pre.length)
  for (let index = 0; index < length; index += 1) {
    if (left.pre[index] === undefined) return -1
    if (right.pre[index] === undefined) return 1
    const result = compareIdentifier(left.pre[index], right.pre[index])
    if (result !== 0) return result
  }
  return 0
}

/** 造一个带 `-0` 预发布的上界版本（排除该版本自身的预发布，npm 的写法）。 */
function upperBound(major, minor, patch) {
  return { major, minor, patch, pre: ['0'] }
}

/**
 * 把一个比较器展开成一个边界对象（或 `{ any: true }`）。
 * @param {string} text 例如 `^0.2.1-rc.2`、`>=1.0.0`、`*`
 * @returns {{any: true} | {lower?: {version, inclusive}, upper?: {version, inclusive}} | null}
 *   `{ any: true }` = 通配（任意版本都命中）；`null` = 无法解析（该与选作废）
 */
function expandComparator(text) {
  const trimmed = text.trim()
  if (trimmed === '*' || /^[xX]$/.test(trimmed)) return { any: true }

  const operator = OPERATORS.find((item) => trimmed.startsWith(item)) ?? ''
  const body = operator === '' ? trimmed : trimmed.slice(operator.length)
  const version = parseVersion(body)
  if (version === null) return null

  switch (operator) {
    case '^': {
      let upper
      if (version.major > 0) upper = upperBound(version.major + 1, 0, 0)
      else if (version.minor > 0) upper = upperBound(0, version.minor + 1, 0)
      else upper = upperBound(0, 0, version.patch + 1)
      return { lower: { version, inclusive: true }, upper: { version: upper, inclusive: false } }
    }
    case '~':
      return {
        lower: { version, inclusive: true },
        upper: { version: upperBound(version.major, version.minor + 1, 0), inclusive: false },
      }
    case '>=':
      return { lower: { version, inclusive: true } }
    case '>':
      return { lower: { version, inclusive: false } }
    case '<=':
      return { upper: { version, inclusive: true } }
    case '<':
      return { upper: { version, inclusive: false } }
    case '=':
    case '':
    default:
      return { lower: { version, inclusive: true }, upper: { version, inclusive: true } }
  }
}

/** 判断单个比较器是否命中。 */
function comparatorMatches(version, comparator) {
  if (comparator.any === true) return true
  const { lower, upper } = comparator
  if (lower !== undefined) {
    const result = compare(version, lower.version)
    if (result < 0 || (result === 0 && lower.inclusive === false)) return false
  }
  if (upper !== undefined) {
    const result = compare(version, upper.version)
    if (result > 0 || (result === 0 && upper.inclusive === false)) return false
  }
  return true
}

/**
 * 判断版本是否落在范围内。
 *
 * 与同名的 `node-semver` 有一处有意偏离：**不施加「同段预发布闸门」**，所以
 * `satisfies('0.2.2-rc.1', '^0.2.1-rc.2')` 为 true（npm 会返回 false）。理由见文件头，
 * 调用方只应把它用于 `selftest --peer` 那种「声明是否覆盖当前版本」的判断，不要当通用 semver。
 * @param {string|object} version 版本串或 `parseVersion` 的结果
 * @param {string} range 范围串（`||` 或选、空格分隔与选）
 * @returns {boolean} 版本或范围无法解析时返回 false（不抛错：门禁不该因为一条坏声明崩掉）
 */
export function satisfies(version, range) {
  const target = toVersion(version)
  if (target === null || typeof range !== 'string') return false

  for (const alternative of range.split('||')) {
    const trimmed = alternative.trim()
    if (trimmed === '') continue
    const comparators = trimmed.split(/\s+/).map(expandComparator)
    if (comparators.some((item) => item === null)) continue
    if (!comparators.every((item) => comparatorMatches(target, item))) continue
    return true
  }
  return false
}
