/**
 * 知识库三件套（`kb check` / `kb init` / `kb refresh`）与影响分析（`kb impact`），契约 §3.2。
 *
 * 设计边界（issue #154 §4.0）：
 *   - 只读仓库：除 `--out` 指定的文件外不写任何东西，不改 KB 正文、不改 AGENTS.md；
 *   - 不猜：页眉解析不出来就报错，不替调用方补 stamp / 补覆盖路径；
 *   - 只用 `git ls-files` 展开 glob（`fs` 递归会把 node_modules 与未跟踪文件算进去）；
 *   - 所有 git 动作走 `lib/git.mjs` 的具名封装，`runner` 可注入，测试不碰真实远端。
 *
 * 本文件只返回结构化结果；打印与退出码由 `bin/cli.mjs` 决定。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  commitExists,
  diffNameOnly,
  diffShortstat,
  isAncestor,
  logOnelineRange,
  lsFiles,
} from './git.mjs'
import { globToRegExp, normalizePath } from './policy.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE_DIR = join(PACKAGE_ROOT, 'templates')

/** 知识库缺省目录（相对仓库根）。 */
export const KB_DIR = 'docs/knowledge-base'

/** 写作指令：新名优先，旧名只作过渡期回退。 */
export const PROMPT_PATH = 'docs/kb-prompt.md'
export const PROMPT_LEGACY_PATH = 'docs/promptA.md'

/** 包内模板（init 的写作指令回退、AGENTS.md 草稿）。 */
export const TEMPLATE_PROMPT = 'kb-prompt.md'
export const TEMPLATE_AGENTS = 'agents.md'

/** 页眉只在前 10 行内找：越靠前越不会被正文里的同名词误命中。 */
export const HEADER_SCAN_LINES = 10

/** 覆盖路径硬上限（issue §4.0 B2）。 */
export const MAX_GLOB_FILES = 30
export const MAX_DOC_FILES = 200
export const MAX_TOP_LEVEL_COVERAGE = 10

/** 顶层文档只列结构锚点（issue §4.0 B6）。 */
export const TOP_LEVEL_DOCS = Object.freeze([
  'INDEX.md',
  'ARCHITECTURE.md',
  'API.md',
  'DATA.md',
  'OPERATIONS.md',
  'CONVENTIONS.md',
])

/** 文档级错误码（7 类）。 */
export const DOC_ERROR_CODES = Object.freeze([
  'E_NO_STAMP',
  'E_BAD_DATE',
  'E_STAMP_ORPHAN',
  'E_NO_COVERAGE',
  'E_DEAD_GLOB',
  'E_BROAD_GLOB',
  'E_FORBIDDEN_PATH',
])

/** 入口级错误码（5 类）。 */
export const ENTRY_ERROR_CODES = Object.freeze([
  'E_NO_AGENTS',
  'E_NO_KB_ROUTE',
  'E_ROUTE_DEAD',
  'E_ROUTE_MISMATCH',
  'E_NAV_MISMATCH',
])

/** 不失败但要在报告里提示的警告码。 */
export const WARNING_CODES = Object.freeze(['W_LEGACY_HEADER'])

/** 枚举时跳过的目录（历史归档与草稿不算知识库正文）。 */
export const SKIP_DIRS = Object.freeze(['archive', '_draft'])

const CANONICAL_HEADER =
  /^>\s*最后更新[:：]\s*\d{4}-\d{2}-\d{2}\s*\|\s*commit[:：]\s*`?[0-9a-fA-F]{7,40}`?\s*$/
const DATE_TOKEN = /(\d{4}-\d{2}-\d{2})/
const COMMIT_TOKEN = /(?:commit|对应提交)[:：]?\s*`?([0-9a-fA-F]{7,40})`?/

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 本地日期（不用 toISOString：UTC 在午夜前后会差一天）。 */
export function localDate(now = new Date()) {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

/** 严格校验 `YYYY-MM-DD`：2 月 30 日这类不存在的日期也要拒。 */
export function isValidDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text))
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const date = new Date(Date.UTC(year, month - 1, day))
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

/** 从 `> 覆盖路径: `a`, `b`` 这样的行里取出路径；没有反引号时按逗号拆。 */
function parseCoverageLine(line) {
  const ticked = [...String(line).matchAll(/`([^`]+)`/g)]
    .map((match) => match[1].trim())
    .filter((item) => item.length > 0)
  if (ticked.length > 0) return ticked
  const colon = String(line).search(/[:：]/)
  if (colon === -1) return []
  return String(line)
    .slice(colon + 1)
    .split(/[,，]/)
    .map((item) => item.trim().replace(/^`|`$/g, ''))
    .filter((item) => item.length > 0)
}

/**
 * 解析文档页眉（前 10 行）。
 *
 * 返回结构化结果，不抛异常：`errors` 里的码就是 issue §4.0 A 的判定顺序。
 * `W_LEGACY_HEADER` 只在「能解析出日期与 sha、但不是 canonical 两行格式」时给。
 *
 * @returns {{
 *   date: string|null,
 *   commit: string|null,
 *   coverage: string[],
 *   canonical: boolean,
 *   header: string|null,
 *   errors: {code: string, detail: string}[],
 *   warnings: string[],
 * }}
 */
export function parseHeader(text, { today = localDate() } = {}) {
  const lines = String(text).split(/\r?\n/).slice(0, HEADER_SCAN_LINES)
  const result = {
    date: null,
    commit: null,
    coverage: [],
    canonical: false,
    header: null,
    errors: [],
    warnings: [],
  }

  const headerIndex = lines.findIndex((line) => line.includes('最后更新'))
  if (headerIndex === -1) {
    result.errors.push({
      code: 'E_NO_STAMP',
      detail: `前 ${HEADER_SCAN_LINES} 行没有「最后更新」页眉`,
    })
  } else {
    const line = lines[headerIndex].trim()
    result.header = line
    result.canonical = CANONICAL_HEADER.test(line)

    const dateMatch = DATE_TOKEN.exec(line)
    if (dateMatch === null) {
      result.errors.push({ code: 'E_BAD_DATE', detail: '最后更新日期不是 YYYY-MM-DD' })
    } else if (!isValidDate(dateMatch[1])) {
      result.errors.push({ code: 'E_BAD_DATE', detail: `最后更新日期不合法: ${dateMatch[1]}` })
    } else if (dateMatch[1] > today) {
      result.errors.push({
        code: 'E_BAD_DATE',
        detail: `最后更新日期 ${dateMatch[1]} 晚于今天 ${today}`,
      })
    } else {
      result.date = dateMatch[1]
    }

    const commitMatch = COMMIT_TOKEN.exec(line)
    if (commitMatch === null) {
      result.errors.push({
        code: 'E_NO_STAMP',
        detail: '缺少 commit（或不是 7–40 位十六进制 sha）',
      })
    } else {
      result.commit = commitMatch[1].toLowerCase()
    }

    if (!result.canonical && result.errors.length === 0) {
      result.warnings.push('W_LEGACY_HEADER')
    }
  }

  const coverageIndex = lines.findIndex(
    (line, index) => index !== headerIndex && line.includes('覆盖路径'),
  )
  if (coverageIndex !== -1) {
    result.coverage = parseCoverageLine(lines[coverageIndex])
  }
  if (result.coverage.length === 0) {
    result.errors.push({ code: 'E_NO_COVERAGE', detail: '缺少「覆盖路径」行（或该行为空）' })
  }

  return result
}

/** 逐条校验覆盖路径：格式、禁区、存活、体量。 */
function checkCoverage(root, kbDir, docPath, entries, { runner }) {
  const errors = []
  const pathspecs = []
  const files = new Set()
  const topLevel = !docPath.includes('/')

  if (topLevel && entries.length > MAX_TOP_LEVEL_COVERAGE) {
    errors.push({
      code: 'E_BROAD_GLOB',
      detail: `顶层文档覆盖路径 ${entries.length} 条，超过 ${MAX_TOP_LEVEL_COVERAGE} 条上限（只列结构锚点）`,
    })
  }

  for (const raw of entries) {
    const entry = String(raw).trim()
    if (entry.length === 0) continue

    if (isAbsolute(entry)) {
      errors.push({ code: 'E_FORBIDDEN_PATH', detail: `覆盖路径不能是绝对路径: ${entry}` })
      continue
    }
    if (entry.startsWith('./')) {
      errors.push({ code: 'E_FORBIDDEN_PATH', detail: `覆盖路径不要带 ./ 前缀: ${entry}` })
      continue
    }

    const normalized = normalizePath(entry)
    if (normalized.split('/').includes('..')) {
      errors.push({ code: 'E_FORBIDDEN_PATH', detail: `覆盖路径不能含 ..: ${entry}` })
      continue
    }
    const bareGlob = normalized.replace(/\/+$/, '')
    if (bareGlob === '**' || bareGlob === '**/**') {
      errors.push({ code: 'E_BROAD_GLOB', detail: '禁止把 ** 单独作为一条覆盖路径' })
      continue
    }
    if (normalized === 'docs' || normalized.startsWith('docs/')) {
      errors.push({
        code: 'E_FORBIDDEN_PATH',
        detail: `覆盖路径不能指向 docs/**（文档改动会自触发 stale）: ${entry}`,
      })
      continue
    }
    if (normalized === kbDir || normalized.startsWith(`${kbDir}/`)) {
      errors.push({
        code: 'E_FORBIDDEN_PATH',
        detail: `覆盖路径不能指向知识库自身: ${entry}`,
      })
      continue
    }
    if (normalized === 'test/fixtures' || normalized.startsWith('test/fixtures/')) {
      errors.push({ code: 'E_FORBIDDEN_PATH', detail: `测试夹具不进覆盖路径: ${entry}` })
      continue
    }

    const expanded = lsFiles(root, { pathspec: [normalized], runner })
    if (!expanded.ok) {
      if (typeof expanded.code !== 'number') {
        return { errors, pathspecs, files, envError: expanded.error }
      }
      errors.push({
        code: 'E_DEAD_GLOB',
        detail: `glob 展开失败（${entry}）: ${expanded.error}`,
      })
      continue
    }
    if (expanded.data.length === 0) {
      errors.push({ code: 'E_DEAD_GLOB', detail: `glob 没有命中任何已跟踪文件: ${entry}` })
      continue
    }
    for (const file of expanded.data) files.add(file)
    if (expanded.data.length > MAX_GLOB_FILES) {
      errors.push({
        code: 'E_BROAD_GLOB',
        detail: `单条 glob 命中 ${expanded.data.length} 个文件（上限 ${MAX_GLOB_FILES}）: ${entry}`,
      })
      continue
    }
    pathspecs.push(normalized)
  }

  if (files.size > MAX_DOC_FILES) {
    errors.push({
      code: 'E_BROAD_GLOB',
      detail: `单篇覆盖 ${files.size} 个文件（上限 ${MAX_DOC_FILES}）`,
    })
  }

  return { errors, pathspecs, files, envError: null }
}

/** 单篇文档：解析页眉、校验 stamp 与覆盖路径。 */
function checkDoc(root, kbDir, docPath, { runner, today }) {
  const full = join(root, kbDir, docPath)
  let text
  try {
    text = readFileSync(full, 'utf8')
  } catch (error) {
    return { envError: `读取 ${kbDir}/${docPath} 失败: ${messageOf(error)}` }
  }

  const parsed = parseHeader(text, { today })
  const errors = [...parsed.errors]
  const warnings = [...parsed.warnings]

  if (parsed.commit !== null) {
    const exists = commitExists(root, { sha: parsed.commit, runner })
    if (!exists.ok) {
      if (typeof exists.code !== 'number') {
        return { envError: `校验提交 ${parsed.commit} 失败: ${exists.error}` }
      }
      errors.push({
        code: 'E_STAMP_ORPHAN',
        detail: `提交 ${parsed.commit} 不存在（squash 后原 sha 可能已不在历史里）`,
      })
    } else {
      const ancestor = isAncestor(root, { sha: parsed.commit, ref: 'HEAD', runner })
      if (!ancestor.ok) {
        if (ancestor.code === 1) {
          errors.push({
            code: 'E_STAMP_ORPHAN',
            detail: `提交 ${parsed.commit} 不是 HEAD 的祖先`,
          })
        } else if (typeof ancestor.code !== 'number') {
          return { envError: `校验提交 ${parsed.commit} 的祖先关系失败: ${ancestor.error}` }
        } else {
          errors.push({
            code: 'E_STAMP_ORPHAN',
            detail: `提交 ${parsed.commit} 的祖先校验失败: ${ancestor.error}`,
          })
        }
      }
    }
  }

  let coverage = { errors: [], pathspecs: [], files: new Set(), envError: null }
  if (parsed.coverage.length > 0) {
    coverage = checkCoverage(root, kbDir, docPath, parsed.coverage, { runner })
    if (coverage.envError !== null) return { envError: coverage.envError }
    errors.push(...coverage.errors)
  }

  return {
    path: docPath,
    stamp: parsed.commit,
    date: parsed.date,
    canonical: parsed.canonical,
    coverage: parsed.coverage.length,
    pathspecs: coverage.pathspecs,
    files: coverage.files,
    errors,
    warnings,
  }
}

/** 对通过结构检查的文档算 stale：stamp 之后、覆盖路径内有几个提交。 */
function computeStale(root, doc, { runner }) {
  if (doc.errors.length > 0 || doc.stamp === null || doc.pathspecs.length === 0) {
    return { stale: 0, commits: [], log: '', diffstat: '' }
  }
  const log = logOnelineRange(root, {
    from: doc.stamp,
    to: 'HEAD',
    paths: doc.pathspecs,
    runner,
  })
  if (!log.ok) {
    return { envError: `读取 ${doc.path} 的 stale 提交失败: ${log.error}` }
  }
  const commits = log.data.slice(0, 10).map((line) => line.split(/\s+/)[0])
  let diffstat = ''
  if (log.data.length > 0) {
    const stat = diffShortstat(root, {
      from: doc.stamp,
      to: 'HEAD',
      paths: doc.pathspecs,
      runner,
    })
    if (stat.ok) diffstat = stat.data
  }
  return { stale: log.data.length, commits, log: log.data.join('\n'), diffstat }
}

/** `--exclude` 同时匹配知识库内相对路径与仓库根相对路径。 */
function isExcluded(relPath, excludes, kbDir) {
  if (!Array.isArray(excludes) || excludes.length === 0) return false
  const rootRel = normalizePath(`${kbDir}/${relPath}`)
  return excludes.some((glob) => {
    const matcher = globToRegExp(normalizePath(glob))
    return matcher.test(relPath) || matcher.test(rootRel)
  })
}

/** 递归枚举知识库里的 `*.md`（跳过 archive / _draft / --exclude）。 */
function listDocs(kbPath, { kbDir, excludes }) {
  const docs = []
  const walk = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry.name)) continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const rel = relative(kbPath, full).split(sep).join('/')
      if (isExcluded(rel, excludes, kbDir)) continue
      docs.push(rel)
    }
  }
  walk(kbPath)
  return docs.sort()
}

/** 枚举知识库文档的对外包装：目录不存在返回 missing，枚举失败返回 error。 */
export function listKbDocs(root, { kbDir = KB_DIR, excludes = [] } = {}) {
  const kbPath = join(root, kbDir)
  if (!existsSync(kbPath)) return { ok: false, missing: true, docs: [] }
  try {
    return { ok: true, missing: false, docs: listDocs(kbPath, { kbDir, excludes }) }
  } catch (error) {
    return { ok: false, missing: false, docs: [], error: `枚举知识库失败: ${messageOf(error)}` }
  }
}

/** 从 INDEX.md 的「文档导航」小节取引用的文档（只看表格首列的第一个反引号）。 */
function navRefs(text) {
  const lines = String(text).split(/\r?\n/)
  const start = lines.findIndex((line) => /^#{1,6}\s+.*(文档导航|文档索引|导航)/.test(line))
  if (start === -1) return new Set()

  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) {
      end = index
      break
    }
  }

  const section = lines.slice(start + 1, end).join('\n')
  const refs = new Set()
  const add = (raw) => {
    const value = String(raw).trim()
    if (!value.endsWith('.md')) return
    if (value.startsWith('../') || isAbsolute(value)) return
    const normalized = normalizePath(value)
    // 只认知识库根目录与 modules/ 下的文档；docs/CONTRACT.md 这类仓内其它文档不算导航项
    if (normalized.includes('/') && !normalized.startsWith('modules/')) return
    refs.add(normalized)
  }

  const rows = section
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .filter((line) => !/^\|[\s:|-]+\|$/.test(line.trim()))
  if (rows.length > 0) {
    for (const row of rows) {
      const cell = (row.split('|')[1] ?? '').trim()
      if (cell.length === 0) continue
      const ticked = /`([^`]+)`/.exec(cell)
      add(ticked === null ? cell : ticked[1])
    }
    return refs
  }

  for (const match of section.matchAll(/((?:\.\.\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.md)/g)) {
    add(match[1])
  }
  return refs
}

/** 入口检查：AGENTS.md 路由 + INDEX.md 文档导航，双向一致。 */
function checkEntry(root, kbDir, docPaths) {
  const errors = []
  const indexPath = `${kbDir}/INDEX.md`

  let agentsText = null
  try {
    agentsText = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const agents = agentsText !== null
  if (!agents) errors.push({ code: 'E_NO_AGENTS', detail: '仓库根没有 AGENTS.md' })

  let kbRoute = false
  const routed = new Set()
  if (agents) {
    kbRoute = agentsText.includes(indexPath)
    if (!kbRoute) {
      errors.push({
        code: 'E_NO_KB_ROUTE',
        detail: `AGENTS.md 里没有指向 ${indexPath} 的路由`,
      })
    }

    const prefixed = new RegExp(`${escapeRegExp(kbDir)}/([A-Za-z0-9_./-]+\\.md)`, 'g')
    for (const match of agentsText.matchAll(prefixed)) routed.add(match[1])
    for (const match of agentsText.matchAll(/`modules\/([A-Za-z0-9_.-]+\.md)`/g)) {
      routed.add(`modules/${match[1]}`)
    }

    for (const ref of routed) {
      if (!existsSync(join(root, kbDir, ref))) {
        errors.push({
          code: 'E_ROUTE_DEAD',
          detail: `路由指向不存在的文档: ${kbDir}/${ref}`,
        })
      }
    }

    for (const doc of docPaths) {
      if (!doc.startsWith('modules/')) continue
      if (!routed.has(doc)) {
        errors.push({
          code: 'E_ROUTE_MISMATCH',
          detail: `模块文档没有出现在 AGENTS.md 路由表: ${doc}`,
        })
      }
    }
  }

  let indexText = null
  try {
    indexText = readFileSync(join(root, kbDir, 'INDEX.md'), 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (indexText === null) {
    errors.push({ code: 'E_NAV_MISMATCH', detail: `缺少 ${indexPath}` })
  } else {
    const referenced = navRefs(indexText)
    const actual = new Set(docPaths)
    const missing = [...actual].filter((doc) => !referenced.has(doc)).sort()
    const extra = [...referenced].filter((doc) => !actual.has(doc)).sort()
    if (missing.length > 0) {
      errors.push({
        code: 'E_NAV_MISMATCH',
        detail: `INDEX.md 的文档导航缺少: ${missing.join(', ')}`,
      })
    }
    if (extra.length > 0) {
      errors.push({
        code: 'E_NAV_MISMATCH',
        detail: `INDEX.md 的文档导航指向不存在的文档: ${extra.join(', ')}`,
      })
    }
  }

  return { agents, kbRoute, errors }
}

/** 只给 JSON / 人读用的文档视图：去掉 Set / 内部 pathspecs。 */
function publicDoc(doc, stale) {
  return {
    path: doc.path,
    stamp: doc.stamp,
    date: doc.date,
    coverage: doc.coverage,
    stale: stale.stale ?? 0,
    commits: stale.commits ?? [],
    errors: doc.errors,
    warnings: doc.warnings,
  }
}

/**
 * `kb check` 的采集与判定。
 *
 * @returns {{
 *   ok: boolean, code: 0|1|2|3, missing?: boolean, root?: string, kbDir?: string,
 *   entry?: {agents: boolean, kbRoute: boolean, errors: {code: string, detail: string}[]},
 *   docs?: object[], summary?: {docs: number, errors: number, stale: number},
 *   error?: string, envError?: string,
 * }}
 */
export function checkKb(
  root,
  { kbDir = KB_DIR, excludes = [], strict = false, today = localDate(), runner } = {},
) {
  const kbPath = join(root, kbDir)
  if (!existsSync(kbPath)) {
    return { ok: false, code: 2, missing: true, error: `知识库目录不存在: ${kbDir}` }
  }
  let isDir = false
  try {
    isDir = statSync(kbPath).isDirectory()
  } catch (error) {
    return { ok: false, code: 3, envError: `读取知识库目录失败: ${messageOf(error)}` }
  }
  if (!isDir) {
    return { ok: false, code: 2, missing: true, error: `--kb-dir 不是目录: ${kbDir}` }
  }

  let docPaths
  try {
    docPaths = listDocs(kbPath, { kbDir, excludes })
  } catch (error) {
    return { ok: false, code: 3, envError: `枚举知识库失败: ${messageOf(error)}` }
  }

  const docs = []
  for (const docPath of docPaths) {
    const doc = checkDoc(root, kbDir, docPath, { runner, today })
    if (doc.envError !== undefined) {
      return { ok: false, code: 3, envError: doc.envError }
    }
    const stale = computeStale(root, doc, { runner })
    if (stale.envError !== undefined) {
      return { ok: false, code: 3, envError: stale.envError }
    }
    docs.push({ ...publicDoc(doc, stale), log: stale.log, diffstat: stale.diffstat })
  }

  let entry
  try {
    entry = checkEntry(root, kbDir, docPaths)
  } catch (error) {
    return { ok: false, code: 3, envError: `读取入口文件失败: ${messageOf(error)}` }
  }

  const errorCount =
    docs.reduce((total, doc) => total + doc.errors.length, 0) + entry.errors.length
  const staleCount = docs.filter((doc) => doc.stale > 0).length
  const ok = errorCount === 0 && (!strict || staleCount === 0)

  return {
    ok,
    code: ok ? 0 : 1,
    root,
    kbDir,
    entry,
    docs,
    summary: { docs: docs.length, errors: errorCount, stale: staleCount },
  }
}

/** 读取写作指令：显式 --prompt > docs/kb-prompt.md > docs/promptA.md > 包内模板。 */
export function resolvePromptFile(root, { prompt } = {}) {
  const explicit = typeof prompt === 'string' && prompt.length > 0
  const candidates = explicit
    ? [{ path: isAbsolute(prompt) ? prompt : resolve(root, prompt), label: prompt }]
    : [
        { path: join(root, PROMPT_PATH), label: PROMPT_PATH },
        { path: join(root, PROMPT_LEGACY_PATH), label: PROMPT_LEGACY_PATH },
        { path: join(TEMPLATE_DIR, TEMPLATE_PROMPT), label: `templates/${TEMPLATE_PROMPT}` },
      ]

  for (const candidate of candidates) {
    try {
      return {
        ok: true,
        text: readFileSync(candidate.path, 'utf8'),
        source: candidate.label,
        path: candidate.path,
        explicit,
      }
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      return { ok: false, code: 3, error: `读取写作指令失败: ${messageOf(error)}`, explicit }
    }
  }
  return {
    ok: false,
    code: explicit ? 2 : 3,
    error: `找不到写作指令（${PROMPT_PATH}、${PROMPT_LEGACY_PATH}、包内 templates/${TEMPLATE_PROMPT} 都不存在）`,
    explicit,
  }
}

/** 探测仓库事实：包名、包管理器、workspace 划分。探测不到就如实写「读 package.json 确认」。 */
export function detectRepoFacts(root) {
  const facts = { root, name: null, packageManager: null, workspaces: [] }
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    pkg = null
  }
  if (pkg !== null && typeof pkg === 'object') {
    if (typeof pkg.name === 'string' && pkg.name.length > 0) facts.name = pkg.name
    const declared = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : Array.isArray(pkg.pnpm?.workspaces)
        ? pkg.pnpm.workspaces
        : []
    facts.workspaces = declared.filter((item) => typeof item === 'string')
    if (typeof pkg.packageManager === 'string' && pkg.packageManager.length > 0) {
      facts.packageManager = pkg.packageManager.split('@')[0]
    }
  }
  if (facts.packageManager === null) {
    if (existsSync(join(root, 'pnpm-lock.yaml'))) facts.packageManager = 'pnpm'
    else if (existsSync(join(root, 'yarn.lock'))) facts.packageManager = 'yarn'
    else if (existsSync(join(root, 'package-lock.json'))) facts.packageManager = 'npm'
  }
  if (facts.workspaces.length === 0) {
    try {
      const text = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
      const found = [...text.matchAll(/^\s*-\s*['"]?([^'"\n]+?)['"]?\s*$/gm)].map((m) => m[1])
      if (found.length > 0) facts.workspaces = found
    } catch {
      // 没有 pnpm-workspace.yaml 就保持空数组
    }
  }
  return facts
}

/** 仓库事实的 markdown 片段。 */
function renderFacts(facts) {
  const lines = [
    `- 仓库根: \`${facts.root}\``,
    `- 包名: ${facts.name === null ? '（读 package.json 确认）' : `\`${facts.name}\``}`,
    `- 包管理器: ${facts.packageManager === null ? '（读 package.json / lockfile 确认）' : facts.packageManager}`,
    `- workspace: ${facts.workspaces.length === 0 ? '（读 package.json / pnpm-workspace.yaml 确认）' : facts.workspaces.map((item) => `\`${item}\``).join('、')}`,
  ]
  return lines.join('\n')
}

const HEADER_CONTRACT = `> 最后更新: YYYY-MM-DD | commit: \`<7–40 位十六进制 sha>\`
> 覆盖路径: \`path/to/file.ts\`, \`path/to/dir/**\``

const COVERAGE_CONTRACT = `1. 只列**正文点名**的代码 / 配置 / 脚本；正文没写的路径不要列。
2. 按目录聚合；禁止 \`**\` 单独成条，禁止 \`packages/web/**\` 这类过宽 glob。机械判据：单条 glob 展开后 ≤30 个 tracked 文件，单篇合计 ≤200 个。
3. 每条 glob 必须 \`git ls-files -- <glob>\` 至少命中 1 个文件；命中 0 会报 \`E_DEAD_GLOB\`。
4. 文档自身、\`docs/**\`、测试 fixture 不进覆盖路径（除非正文专门描述它们）。
5. 路径相对仓库根，不带 \`./\` 前缀，不写绝对路径。
6. 顶层文档（INDEX / ARCHITECTURE / API / DATA / OPERATIONS / CONVENTIONS）只列结构锚点（\`package.json\`、workspace 配置、入口文件、schema、路由入口），≤10 条；不追求全量覆盖。`

/**
 * 生成 `kb init` 的提示词：写作指令全文 + 仓库事实 + 页眉/覆盖路径契约 + 收尾要求。
 * @returns {{ok: true, text: string, source: string} | {ok: false, code: 2|3, error: string}}
 */
export function renderInitPrompt(root, { kbDir = KB_DIR, prompt, today = localDate() } = {}) {
  const writing = resolvePromptFile(root, { prompt })
  if (!writing.ok) return writing

  const facts = detectRepoFacts(root)
  const modulesDir = `${kbDir}/modules`

  const text = `# 知识库初始化任务（dsh-pipeline kb init 生成）

## 角色与目标

下面是本仓的写作指令全文（来源：\`${writing.source}\`）。**直接按它执行，不要改写、不要摘要**：

---

${writing.text.trim()}

---

## 仓库事实

${renderFacts(facts)}

## 必须产出

1. 6 篇顶层文档，全部放在 \`${kbDir}/\` 下：\`INDEX.md\`、\`ARCHITECTURE.md\`、\`API.md\`、\`DATA.md\`、\`OPERATIONS.md\`、\`CONVENTIONS.md\`。
2. \`${modulesDir}/<核心模块>.md\`：数量由代码结构决定，不预设；一个核心模块一篇。
3. 每篇顶部必须有 canonical 两行页眉：

\`\`\`markdown
${HEADER_CONTRACT}
\`\`\`

- stamp 语义 = **内容对齐的代码提交**，不是写文档那天；与代码同 PR 提交时取该提交的父提交。
- stamp 必须是 \`HEAD\` 的祖先（\`git merge-base --is-ancestor <sha> HEAD\`）。
- 兼容旧格式（\`· commit\` / \`**最后更新**：\` / \`commit <sha> · 说明\`）会被解析但给 \`W_LEGACY_HEADER\`；新写的一律用 canonical。

## 覆盖路径契约（逐条执行）

${COVERAGE_CONTRACT}

## 收尾要求

生成完必须运行：

\`\`\`bash
dsh-pipeline kb check --root ${root}
\`\`\`

退出码为 0 才算完成；出现 \`E_*\` 就按错误码修（文档级 7 类：E_NO_STAMP / E_BAD_DATE / E_STAMP_ORPHAN / E_NO_COVERAGE / E_DEAD_GLOB / E_BROAD_GLOB / E_FORBIDDEN_PATH；入口级 5 类：E_NO_AGENTS / E_NO_KB_ROUTE / E_ROUTE_DEAD / E_ROUTE_MISMATCH / E_NAV_MISMATCH）。
`

  return { ok: true, text, source: writing.source }
}

/** 常用命令：从 package.json 的 scripts 里挑；没有就写「读 package.json 的 scripts 确认」。 */
function renderCommands(root) {
  let scripts = {}
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (pkg !== null && typeof pkg === 'object' && typeof pkg.scripts === 'object') {
      scripts = pkg.scripts ?? {}
    }
  } catch {
    scripts = {}
  }
  const names = Object.keys(scripts)
  if (names.length === 0) return '读 `package.json` 的 `scripts` 确认常用命令。'
  return names.map((name) => `- \`pnpm run ${name}\``).join('\n')
}

/**
 * 渲染 `AGENTS.md` 草稿（**只打印，不落盘**：AGENTS.md 是高危文件，必须人看过再提交）。
 */
export function renderAgentsDraft(root, { kbDir = KB_DIR, today = localDate() } = {}) {
  const facts = detectRepoFacts(root)
  let template
  try {
    template = readFileSync(join(TEMPLATE_DIR, TEMPLATE_AGENTS), 'utf8')
  } catch (error) {
    return { ok: false, code: 3, error: `读取 AGENTS.md 模板失败: ${messageOf(error)}` }
  }

  let moduleRows = ''
  try {
    const entries = readdirSync(join(root, kbDir, 'modules'), { withFileTypes: true })
    moduleRows = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => `| 改 \`${entry.name.replace(/\.md$/, '')}\` 模块 | \`${kbDir}/modules/${entry.name}\` |`)
      .join('\n')
  } catch {
    moduleRows = `| 改某个核心模块 | \`${kbDir}/modules/<模块>.md\` |`
  }

  const rules = `1. **命令面变更必须同步契约**：新增 / 删除子命令、改参数、改退出码、改落盘路径、改配置字段，都要同时更新 \`docs/CONTRACT.md\` 与知识库。
2. **知识库页眉必须与代码对齐**：每篇顶部两行（最后更新 + commit / 覆盖路径），stamp 取内容对齐的代码提交；不许只改 stamp 不改内容，不许为了过 \`kb check\` 放宽 glob。
3. **交付流程与 worktree 纪律**：见 \`~/.dsh/AGENTS.md\` §7。`

  const text = template
    .replaceAll('{{REPO}}', facts.name ?? '本仓库')
    .replaceAll('{{DATE}}', today)
    .replaceAll('{{KB_DIR}}', kbDir)
    .replaceAll('{{MODULES_ROWS}}', moduleRows)
    .replaceAll('{{RULES}}', rules)
    .replaceAll('{{COMMANDS}}', renderCommands(root))

  return { ok: true, text }
}

/** `kb refresh` 的升级阈值（issue §4.3）。 */
export const REFRESH_MAX_COMMITS = 30
export const REFRESH_MAX_DIFF_LINES = 2000

/**
 * 生成 `kb refresh` 的提示词：结构违规清单 + 每篇 stale 原文 + 升级/页眉规则 + 禁止项。
 * @returns {{ok: true, text: string, source: string, docs: string[]} | {ok: false, code: 1|2|3, error: string}}
 */
export function renderRefreshPrompt(
  root,
  { kbDir = KB_DIR, docs = [], excludes = [], prompt, today = localDate(), runner } = {},
) {
  const report = checkKb(root, { kbDir, excludes, today, runner })
  if (report.missing === true) {
    return { ok: false, code: 1, error: `没有知识库（${kbDir}），请先用 \`kb init\`` }
  }
  if (report.code === 3) {
    return { ok: false, code: 3, error: report.envError ?? report.error ?? '读取知识库失败' }
  }
  if (report.docs.length === 0) {
    return { ok: false, code: 1, error: `知识库里没有文档（${kbDir}），请先用 \`kb init\`` }
  }

  const wanted = (Array.isArray(docs) ? docs : []).map((item) => normalizePath(String(item).trim()))
  let selected = report.docs
  if (wanted.length > 0) {
    const known = new Set(report.docs.map((doc) => doc.path))
    const unknown = wanted.filter((doc) => !known.has(doc) && !known.has(doc.replace(new RegExp(`^${escapeRegExp(kbDir)}/`), '')))
    if (unknown.length > 0) {
      return { ok: false, code: 2, error: `--doc 指定的文档不存在: ${unknown.join(', ')}` }
    }
    const normalized = new Set(
      wanted.map((doc) => doc.replace(new RegExp(`^${escapeRegExp(kbDir)}/`), '')),
    )
    selected = report.docs.filter((doc) => normalized.has(doc.path))
  }

  const writing = resolvePromptFile(root, { prompt })
  if (!writing.ok) return writing

  const violations = []
  for (const doc of selected) {
    for (const error of doc.errors) {
      violations.push(`- \`${doc.path}\` ${error.code}: ${error.detail}`)
    }
    for (const warning of doc.warnings) {
      violations.push(`- \`${doc.path}\` ${warning}: 页眉不是 canonical 两行格式`)
    }
  }

  const staleBlocks = []
  for (const doc of selected) {
    if (doc.stale === 0 && doc.errors.length === 0) continue
    const lines = [
      `### ${kbDir}/${doc.path}`,
      '',
      `- stamp: \`${doc.stamp ?? '无'}\` | stale: ${doc.stale}${doc.diffstat ? ` | diff: ${doc.diffstat}` : ''}`,
    ]
    if (doc.stale > 0) {
      lines.push('', '```text', doc.log, '```', '')
      lines.push('只读这些提交的 diff，不要整文件重读。')
      if (doc.stale > REFRESH_MAX_COMMITS) {
        lines.push(
          '',
          `> 这篇 stale ${doc.stale} 条，超过 ${REFRESH_MAX_COMMITS} 条上限：放弃逐条 diff，按写作指令**重写该篇**，再打新 stamp。`,
        )
      }
    }
    staleBlocks.push(lines.join('\n'))
  }

  const text = `# 知识库更新任务（dsh-pipeline kb refresh 生成）

## 写作指令（全文，更新口径与生成口径一致）

下面是本仓的写作指令全文（来源：\`${writing.source}\`）。**直接按它执行，不要改写、不要摘要**：

---

${writing.text.trim()}

---

## 结构违规（先修结构，再处理 stale）

${violations.length > 0 ? violations.join('\n') : '无。'}

## 每篇的 stale 原文

${staleBlocks.length > 0 ? staleBlocks.join('\n\n') : '无（所选文档都没有 stale 提交）。'}

## 升级规则

- 单篇 stale > ${REFRESH_MAX_COMMITS} 条，或累计 diff > ${REFRESH_MAX_DIFF_LINES} 行 → 放弃逐条 diff，按写作指令**重写该篇**，再打新 stamp。
- 只读上面列出的提交的 diff；不要因为 stale 少就整文件重读。

## 页眉更新规则

- 改完内容 → 把 stamp 更新为**内容对齐的代码提交**：与代码同 PR 时取该提交的父提交，否则取当前 \`HEAD\`。
- 覆盖路径同步增删：正文新点名的代码要加，正文不再描述的代码要删。
- 页眉必须是 canonical 两行：

\`\`\`markdown
${HEADER_CONTRACT}
\`\`\`

## 禁止项

- 不许只改 stamp 不改内容。
- 不许为了过 \`kb check\` 删正文。
- 不许把 glob 放宽来「覆盖」新文件（单条 ≤30 个文件、单篇 ≤200 个、顶层 ≤10 条）。

## 收尾

\`\`\`bash
dsh-pipeline kb check --root ${root}
\`\`\`

退出码为 0 才算完成；有 \`E_*\` 就按错误码修。
`

  return { ok: true, text, source: writing.source, docs: selected.map((doc) => doc.path) }
}

/**
 * `kb impact`：把「这次改动影响哪几篇文档」算出来。
 * 只读；`--staged` 与 `--range` 二选一，缺省 `--range origin/main..HEAD`。
 */
export function computeImpact(
  root,
  { kbDir = KB_DIR, staged = false, range = 'origin/main..HEAD', runner } = {},
) {
  const kbPath = join(root, kbDir)
  if (!existsSync(kbPath)) {
    return { ok: false, code: 2, error: `知识库目录不存在: ${kbDir}` }
  }

  let docPaths
  try {
    docPaths = listDocs(kbPath, { kbDir, excludes: [] })
  } catch (error) {
    return { ok: false, code: 3, error: `枚举知识库失败: ${messageOf(error)}` }
  }

  const changed = diffNameOnly(root, { staged, range, runner })
  if (!changed.ok) {
    return { ok: false, code: 3, error: `读取改动文件失败: ${changed.error}` }
  }
  const changedSet = new Set(changed.data.map((file) => normalizePath(file)))

  const affected = []
  for (const docPath of docPaths) {
    let text
    try {
      text = readFileSync(join(kbPath, docPath), 'utf8')
    } catch (error) {
      return { ok: false, code: 3, error: `读取 ${kbDir}/${docPath} 失败: ${messageOf(error)}` }
    }
    const parsed = parseHeader(text)
    const matched = new Set()
    for (const entry of parsed.coverage) {
      const expanded = lsFiles(root, { pathspec: [normalizePath(entry)], runner })
      if (!expanded.ok) {
        if (typeof expanded.code !== 'number') {
          return { ok: false, code: 3, error: `展开覆盖路径失败: ${expanded.error}` }
        }
        continue
      }
      for (const file of expanded.data) {
        if (changedSet.has(normalizePath(file))) matched.add(normalizePath(file))
      }
    }
    if (matched.size > 0) {
      affected.push({ doc: docPath, files: [...matched].sort() })
    }
  }

  return {
    ok: true,
    code: 0,
    mode: staged === true ? 'staged' : 'range',
    range: staged === true ? null : range,
    changed: changed.data.map((file) => normalizePath(file)).sort(),
    affected,
    summary: { changed: changedSet.size, docs: docPaths.length, affected: affected.length },
  }
}
