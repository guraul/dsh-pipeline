/**
 * `init`：新仓库一键接入交付流程（契约 §3.2）。
 *
 * 一次生成四件套：
 *   1. `.dsh/pipeline.json` 最小配置（repo 从 origin 推导、checks.packages 从 workspace 目录发现）；
 *   2. 入口 shim（复用 lib/shim.mjs 的 installShims，不复制渲染与写入逻辑）；
 *   3. pre-push 钩子（复用 lib/hooks.mjs 的 installHook）；
 *   4. `docs/pipeline/` 骨架（README + review-loop，生成区用标记包裹，标记之外可追加）。
 *
 * 幂等：已存在的配置不覆盖；生成区只替换标记之间；手写文件（无标记）拒绝覆盖，`--force` 才接管。
 * `--check` 只读：逐项报告缺失 / 不一致 / 无标记，缺任一项退出 1。
 *
 * 输出口径：本文件只返回结构化结果，打印与退出码由 bin/cli.mjs 决定。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverPackages } from './check-all.mjs'
import { CONFIG_PATH, loadConfig } from './config.mjs'
import { checkHook, installHook } from './hooks.mjs'
import { extractRegion, replaceRegion } from './region.mjs'
import { repoFromRemote } from './repo.mjs'
import { remoteUrl } from './git.mjs'
import { checkShims, installShims, SHIM_DIR } from './shim.mjs'

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const TEMPLATE_DIR = join(PACKAGE_ROOT, 'templates', 'pipeline-docs')

/** 文档骨架目录（相对仓库根）。 */
export const DOCS_DIR = 'docs/pipeline'

/** 生成的两份文档；顺序固定，输出与校验都按它来。 */
export const DOC_FILES = Object.freeze(['README.md', 'review-loop.md'])

/** 文档生成区标记（整行比对；标记之外的内容不参与校验、重跑时原样保留）。 */
export const DOC_REGION_BEGIN = '<!-- >>> dsh-pipeline 生成区（勿手改；改模板后重跑 init） -->'
export const DOC_REGION_END = '<!-- <<< dsh-pipeline 生成区结束（以下可追加本仓自己的内容） -->'

/**
 * 从一个 workspace 通配项展开出包目录（相对仓库根）。
 * 只支持两种写法：`dir/*`（一层子目录）与字面目录；其余通配（`**`、`a*`）不猜，直接跳过。
 */
function expandWorkspacePattern(root, pattern) {
  const cleaned = String(pattern).replace(/\/+$/, '')
  if (cleaned.length === 0) return []
  if (cleaned.endsWith('/*')) {
    const base = cleaned.slice(0, -2)
    const dir = join(root, base)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return []
    }
    return entries
      .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .filter((entry) => existsSync(join(dir, entry.name, 'package.json')))
      .map((entry) => `${base}/${entry.name}`)
      .sort()
  }
  return existsSync(join(root, cleaned, 'package.json')) ? [cleaned] : []
}

/**
 * 推导 `checks.packages`：优先读根 package.json 的 `workspaces`（或 `pnpm.workspaces`）展开；
 * 没有声明 workspace 时回退 check-all 的「顶层子目录」发现（兼容单层多包仓）。
 * 返回相对仓库根的目录名（如 `packages/a` 或 `dsh-subagents`），直接喂给 check-all。
 */
export function discoverWorkspacePackages(root) {
  let pkg = null
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  } catch {
    return discoverPackages(root)
  }
  const patterns = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.pnpm?.workspaces)
      ? pkg.pnpm.workspaces
      : null
  if (patterns === null) return discoverPackages(root)
  const found = []
  for (const pattern of patterns) found.push(...expandWorkspacePattern(root, pattern))
  return [...new Set(found)]
}

/** 配置里 repo 未知时用的展示名。 */
function repoLabel(repo) {
  return typeof repo === 'string' && repo.length > 0 ? repo : '本仓库'
}

/** 读模板；模板缺失是包自身损坏，直接抛给调用方按环境错误处理。 */
function readTemplate(file) {
  return readFileSync(join(TEMPLATE_DIR, file), 'utf8')
}

/** 渲染整份文档（模板自带标题与成对标记）。 */
export function renderDoc(file, { repo } = {}) {
  const text = readTemplate(file).replaceAll('{{REPO}}', repoLabel(repo))
  return text.endsWith('\n') ? text : `${text}\n`
}

/** 渲染文档的生成区（只取标记之间的内容，用于逐字节比对）。 */
export function renderDocRegion(file, { repo } = {}) {
  const extracted = extractRegion(renderDoc(file, { repo }), DOC_REGION_BEGIN, DOC_REGION_END)
  if (!extracted.ok) throw new Error(`模板缺少成对生成区标记: ${file}`)
  return extracted.region
}

/** 读文件；不存在返回 null，其它读失败抛错（调用方按环境错误处理）。 */
function readIfExists(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 生成最小配置文本。
 * 字段顺序固定为 repo → checks；两个都没有时写 `{}`（schema 接受，下游按缺省处理）。
 * @returns {string} JSON 文本（2 空格缩进 + 末尾换行）
 */
export function renderConfig({ repo, packages } = {}) {
  const config = {}
  if (typeof repo === 'string' && repo.length > 0) config.repo = repo
  if (Array.isArray(packages) && packages.length > 0) config.checks = { packages }
  return `${JSON.stringify(config, null, 2)}\n`
}

/**
 * 写最小配置：已存在则不覆盖（幂等），存在但非法则报配置错误，不静默跳过。
 * @returns {{ok: true, action: 'written'|'skipped'} | {ok: false, code: 2|3, error: string}}
 */
export function installConfig(root, { repo, packages, force = false } = {}) {
  const file = join(root, ...CONFIG_PATH)
  let existing
  try {
    existing = readIfExists(file)
  } catch (error) {
    return { ok: false, code: 3, error: `读取 ${CONFIG_PATH.join('/')} 失败: ${messageOf(error)}` }
  }

  if (existing !== null && !force) {
    // 已存在就校验一遍：配置写坏了要当场报出来，不能因为「跳过」而装作没事
    try {
      loadConfig(root)
    } catch (error) {
      return { ok: false, code: 2, error: messageOf(error) }
    }
    return { ok: true, action: 'skipped' }
  }

  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, renderConfig({ repo, packages }))
  } catch (error) {
    return { ok: false, code: 3, error: `写入 ${CONFIG_PATH.join('/')} 失败: ${messageOf(error)}` }
  }
  return { ok: true, action: 'written' }
}

/**
 * 校验配置文件：不存在算缺项，存在就必须能过 schema。
 * @returns {{ok: true} | {ok: false, reason: 'missing'|'invalid'|'io', error?: string}}
 */
export function checkConfigFile(root) {
  const file = join(root, ...CONFIG_PATH)
  let existing
  try {
    existing = readIfExists(file)
  } catch (error) {
    return { ok: false, reason: 'io', error: messageOf(error) }
  }
  if (existing === null) return { ok: false, reason: 'missing' }
  try {
    loadConfig(root)
  } catch (error) {
    return { ok: false, reason: 'invalid', error: messageOf(error) }
  }
  return { ok: true }
}

/**
 * 生成 / 刷新 docs 骨架。
 *
 * 两段式：先对两份文件全部判定，有冲突且没给 --force 时一个文件都不写——
 * 半写状态比明确失败更难排查（与 shim install 同一口径）。
 * @returns {{ok: true, written: string[], skipped: string[]} | {ok: false, conflicts: string[]}}
 */
export function installDocs(root, { force = false, repo } = {}) {
  const plan = []
  const conflicts = []
  for (const file of DOC_FILES) {
    const path = join(root, DOCS_DIR, file)
    const rendered = renderDoc(file, { repo })
    let existing
    try {
      existing = readIfExists(path)
    } catch (error) {
      return { ok: false, ioError: `读取 ${DOCS_DIR}/${file} 失败: ${messageOf(error)}` }
    }
    if (existing === null) {
      plan.push({ file, path, content: rendered, action: 'write' })
      continue
    }
    const region = `${DOC_REGION_BEGIN}\n${renderDocRegion(file, { repo })}\n${DOC_REGION_END}`
    const merged = replaceRegion(existing, DOC_REGION_BEGIN, DOC_REGION_END, region)
    if (merged === null) {
      if (!force) {
        conflicts.push(`${DOCS_DIR}/${file}（已存在且不是生成的骨架，缺标记；确认后加 --force 覆盖）`)
        continue
      }
      plan.push({ file, path, content: rendered, action: 'overwrite' })
      continue
    }
    if (merged === existing) {
      plan.push({ file, path, content: existing, action: 'skip' })
      continue
    }
    plan.push({ file, path, content: merged, action: 'update' })
  }
  if (conflicts.length > 0) return { ok: false, conflicts }

  const written = []
  const skipped = []
  try {
    for (const item of plan) {
      if (item.action === 'skip') {
        skipped.push(`${DOCS_DIR}/${item.file}`)
        continue
      }
      mkdirSync(dirname(item.path), { recursive: true })
      writeFileSync(item.path, item.content)
      written.push(`${DOCS_DIR}/${item.file}`)
    }
  } catch (error) {
    return { ok: false, ioError: `写入 ${DOCS_DIR} 失败: ${messageOf(error)}` }
  }
  return { ok: true, written, skipped }
}

/**
 * 校验 docs 骨架：缺失 / 无成对标记 / 生成区与模板不一致都算失败。
 * @returns {{ok: boolean, missing: string[], noMarker: string[], mismatched: string[], scanError: string|null}}
 */
export function checkDocs(root, { repo } = {}) {
  const missing = []
  const noMarker = []
  const mismatched = []
  for (const file of DOC_FILES) {
    const path = join(root, DOCS_DIR, file)
    let existing
    try {
      existing = readIfExists(path)
    } catch (error) {
      return { ok: false, missing, noMarker, mismatched, scanError: messageOf(error) }
    }
    if (existing === null) {
      missing.push(`${DOCS_DIR}/${file}`)
      continue
    }
    const extracted = extractRegion(existing, DOC_REGION_BEGIN, DOC_REGION_END)
    if (!extracted.ok) {
      noMarker.push(`${DOCS_DIR}/${file}`)
      continue
    }
    if (extracted.region !== renderDocRegion(file, { repo })) mismatched.push(`${DOCS_DIR}/${file}`)
  }
  return {
    ok: missing.length === 0 && noMarker.length === 0 && mismatched.length === 0,
    missing,
    noMarker,
    mismatched,
    scanError: null,
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 推导 repo：显式 --repo 优先，否则从 origin 的远端地址还原；都拿不到返回 null（不猜）。
 * 读远端失败不报错——配置里不写 repo 也能用，下游命令需要时自己会报「无法确定仓库」。
 */
function resolveRepo(root, { repo, runner } = {}) {
  if (typeof repo === 'string' && repo.length > 0) return repo
  let url = null
  try {
    const result = remoteUrl(root, { runner })
    if (result.ok) url = result.data
  } catch {
    url = null
  }
  return repoFromRemote(url)
}

/**
 * init 的编排层：按「配置 → shim → hooks → docs」逐项生成或校验。
 * @returns {{
 *   ok: boolean,
 *   code: 0|1|2|3,
 *   rows: {name: string, status: string, detail?: string}[],
 *   errors: {code: string, text: string}[],
 * }}
 */
export function runInit(root, { check = false, force = false, repo, runner } = {}) {
  const rows = []
  const errors = []
  let code = 0

  const packages = (() => {
    try {
      return discoverWorkspacePackages(root)
    } catch (error) {
      errors.push({ code: 'E_ENV', text: `读取目录失败: ${messageOf(error)}` })
      code = 3
      return []
    }
  })()
  const resolvedRepo = resolveRepo(root, { repo, runner })

  if (check) {
    const config = checkConfigFile(root)
    if (config.ok) rows.push({ name: 'config', status: 'ok', detail: CONFIG_PATH.join('/') })
    else if (config.reason === 'io') {
      errors.push({ code: 'E_ENV', text: `读取 ${CONFIG_PATH.join('/')} 失败: ${config.error}` })
      code = 3
    } else if (config.reason === 'missing') {
      rows.push({ name: 'config', status: 'missing', detail: CONFIG_PATH.join('/') })
      code = Math.max(code, 1)
    } else {
      rows.push({ name: 'config', status: 'mismatch', detail: config.error })
      code = Math.max(code, 1)
    }

    const shims = checkShims(root)
    if (shims.scanError !== null) {
      errors.push({ code: 'E_ENV', text: `无法枚举 ${SHIM_DIR}: ${shims.scanError}` })
      code = 3
    } else if (shims.missingDir) {
      rows.push({ name: 'shim', status: 'missing', detail: shims.dir })
      code = Math.max(code, 1)
    } else if (!shims.ok) {
      const parts = [
        ...shims.mismatches.map((name) => `与模板不一致: ${name}`),
        ...shims.extras.map((name) => `不允许的私有文件: ${name}`),
      ]
      rows.push({ name: 'shim', status: 'mismatch', detail: parts.join('；') })
      code = Math.max(code, 1)
    } else {
      rows.push({ name: 'shim', status: 'ok', detail: '6 个入口与模板一致' })
    }

    const hook = checkHook(root, { runner })
    if (hook.ok) rows.push({ name: 'hooks', status: 'ok', detail: hook.path })
    else if (hook.code === 2) {
      errors.push({ code: 'E_ENV', text: hook.error })
      code = 3
    } else {
      rows.push({ name: 'hooks', status: 'mismatch', detail: hook.error })
      code = Math.max(code, 1)
    }

    const docs = checkDocs(root, { repo: resolvedRepo })
    if (docs.scanError !== null) {
      errors.push({ code: 'E_ENV', text: `读取 ${DOCS_DIR} 失败: ${docs.scanError}` })
      code = 3
    } else if (!docs.ok) {
      const parts = [
        ...docs.missing.map((file) => `缺失: ${file}`),
        ...docs.noMarker.map((file) => `缺少生成区标记: ${file}`),
        ...docs.mismatched.map((file) => `生成区与模板不一致: ${file}`),
      ]
      rows.push({ name: 'docs', status: 'mismatch', detail: parts.join('；') })
      code = Math.max(code, 1)
    } else {
      rows.push({ name: 'docs', status: 'ok', detail: `${DOCS_DIR}/ 与模板一致` })
    }

    return { ok: code === 0, code, rows, errors }
  }

  const config = installConfig(root, { repo: resolvedRepo, packages, force })
  if (!config.ok) {
    errors.push({ code: config.code === 2 ? 'E_CONFIG' : 'E_ENV', text: config.error })
    code = Math.max(code, config.code)
  } else {
    rows.push({
      name: 'config',
      status: config.action === 'written' ? 'written' : 'skipped',
      detail: CONFIG_PATH.join('/'),
    })
  }

  const shims = installShims(root, { force })
  if (!shims.ok) {
    errors.push({ code: 'E_STATE', text: `已存在且内容不同: ${shims.conflicts.join(', ')}（确认后加 --force 覆盖）` })
    code = Math.max(code, 1)
  } else {
    rows.push({
      name: 'shim',
      status: shims.written.length > 0 ? 'written' : 'skipped',
      detail: shims.written.length > 0 ? shims.written.join(', ') : '6 个入口已存在且一致',
    })
  }

  const hook = installHook(root, { force, runner })
  if (!hook.ok) {
    errors.push({ code: hook.code === 1 ? 'E_STATE' : 'E_ENV', text: hook.error })
    code = Math.max(code, hook.code === 1 ? 1 : 3)
  } else {
    rows.push({ name: 'hooks', status: hook.status === 'unchanged' ? 'skipped' : 'written', detail: hook.path })
  }

  const docs = installDocs(root, { force, repo: resolvedRepo })
  if (!docs.ok) {
    if (typeof docs.ioError === 'string') {
      errors.push({ code: 'E_ENV', text: docs.ioError })
      code = Math.max(code, 3)
    } else {
      for (const conflict of docs.conflicts) errors.push({ code: 'E_STATE', text: conflict })
      code = Math.max(code, 1)
    }
  } else {
    rows.push({
      name: 'docs',
      status: docs.written.length > 0 ? 'written' : 'skipped',
      detail: docs.written.length > 0 ? docs.written.join(', ') : `${DOCS_DIR}/ 已存在且一致`,
    })
  }

  return { ok: code === 0, code, rows, errors }
}
