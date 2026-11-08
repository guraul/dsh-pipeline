/**
 * 生成区（首尾标记之间）的通用操作：提取、整体替换、首处差异。
 *
 * 两处生成物共用同一套语义：
 *   - `deploy init` 的 `.github/workflows/*-web.yml`（标记是 `# >>>` / `# <<<`）；
 *   - `init` 的 `docs/pipeline/*.md`（标记是 `<!-- >>>` / `<!-- <<< -->`）。
 *
 * 判据固定为「标记整行比对、标记之间逐字节比对」：标记之外的追加内容不参与比对，
 * 但重生成时必须原样保留——这正是「改配置后重跑不丢追加内容」的保证。
 * 标记文案由调用方传入，本文件不认识任何具体文件。
 */

/**
 * 从整份文件里取出生成区（两个标记整行之间，不含标记行）。
 * @param {string} content 文件全文
 * @param {string} begin 起始标记（整行相等）
 * @param {string} end 结束标记（整行相等，必须在起始标记之后）
 * @returns {{ok: true, region: string} | {ok: false, reason: 'no-begin'|'no-end'}}
 */
export function extractRegion(content, begin, end) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line === begin)
  if (start === -1) return { ok: false, reason: 'no-begin' }
  const stop = lines.findIndex((line, index) => index > start && line === end)
  if (stop === -1) return { ok: false, reason: 'no-end' }
  return { ok: true, region: lines.slice(start + 1, stop).join('\n') }
}

/**
 * 逐字节判等（字符串相等即内容相等）后，给出第一处差异的行号与两侧整行。
 * 行序列的首个差异必然存在且与首个字节差异同位置（同一行序列 ⇒ 同一字符串）。
 * @returns {null | {line: number, expected: string, actual: string}}
 */
export function firstDifference(expected, actual) {
  if (expected === actual) return null
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const count = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < count; index += 1) {
    const left = index < expectedLines.length ? expectedLines[index] : null
    const right = index < actualLines.length ? actualLines[index] : null
    if (left === right) continue
    return {
      line: index + 1,
      expected: left === null ? '<文件结束>' : left,
      actual: right === null ? '<文件结束>' : right,
    }
  }
  return null
}

/**
 * 把已有文件的生成区整体替换成 region（标记之外的前缀与追加内容原样保留）。
 * `region` 必须**自带首尾标记**（调用方传的是「标记 + 内容 + 标记」整块）：
 * 这样标记文案只有一处定义，替换后不会重复或错位。
 * 文件里没有成对标记时返回 null——调用方据此拒绝覆盖手写文件。
 */
export function replaceRegion(content, begin, end, region) {
  const lines = content.split('\n')
  const start = lines.findIndex((line) => line === begin)
  if (start === -1) return null
  const stop = lines.findIndex((line, index) => index > start && line === end)
  if (stop === -1) return null
  return [...lines.slice(0, start), ...region.split('\n'), ...lines.slice(stop + 1)].join('\n')
}
