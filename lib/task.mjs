/**
 * task 子命令：从 GitHub issue 开一条开发分支 + worktree。
 *
 * 语义对齐 self-dsh-plugins 的 scripts/pipeline/new-task.sh：
 *   - 分支 task/<号>-<slug>，worktree <主工作区>/.worktrees/<号>-<slug>，基线恒为 origin/main；
 *     主工作区由 `git rev-parse --git-common-dir` 的父目录确定，
 *     因此从任意 linked worktree 里运行都不会再嵌套出一层 .worktrees；
 *   - 显式 --root 以传入为准；若它正好是 linked worktree 的顶层，会折回主工作区；
 *   - slug：标题小写、非 [a-z0-9] 折成 '-'、去首尾 '-'、截断 40；
 *     非 ASCII 标题会整段被清空（本仓 issue 多为中文），此时回退成标题 sha1 的前 8 位。
 *     兜底必须是确定性的：同一个 issue 重跑要得到同一个分支名，worktree 判重才可靠，
 *     所以这里不能退化成固定的 "task"；
 *   - 幂等：worktree 已存在 → 只打印路径，退出 0（不 fetch、不改动现场）；
 *     路径存在但不是本仓 worktree → 报错退出 2；
 *   - fetch 失败重试 3 次（每次间隔 3 秒）仍失败 → 退出 2。
 *
 * 所有外部动作走注入的 runner，单测用假 runner 断言 argv，不触网、不动真实仓库。
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import * as realGit from './git.mjs'
import * as realGh from './gh.mjs'
import { resolveMainRoot, resolveRepo } from './repo.mjs'

/** fetch 总尝试次数（含首次）。 */
export const FETCH_RETRY = 3

/** 两次 fetch 之间的等待（毫秒），与参考脚本一致。 */
export const FETCH_RETRY_DELAY_MS = 3000

/** 新分支的基线：远端 main，不是本机 HEAD。 */
export const BASE_REF = 'origin/main'

/** worktree 统一放在仓库根的 .worktrees 下。 */
export const WORKTREES_DIR = '.worktrees'

/** slug 最大长度，与参考脚本的 cut -c1-40 对齐。 */
export const SLUG_MAX = 40

function fail(code, error) {
  return { ok: false, code, error, lines: [] }
}

function isIssueNumber(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * 标题 → 文件名安全的短 slug。
 * 纯 ASCII 标题得到可读 slug；非 ASCII 标题得到标题 sha1 前 8 位（而非固定串）。
 */
export function slugify(title) {
  const text = typeof title === 'string' ? title : String(title ?? '')
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
  if (slug.length > 0) return slug
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, 8)
}

/** 分支名规则：task/<号>-<slug>。 */
export function taskBranchName(issue, title) {
  return `task/${issue}-${slugify(title)}`
}

/** worktree 路径规则：<root>/.worktrees/<号>-<slug>。 */
export function taskWorktreePath(root, issue, title) {
  return join(root, WORKTREES_DIR, `${issue}-${slugify(title)}`)
}

/** 同步等待：CLI 是同步实现，不能为了 3 秒重试把整条调用链改成 async。 */
function defaultSleep(ms) {
  const buffer = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(buffer, 0, 0, ms)
}

/** 路径判重：去掉尾部分隔符再比，避免 /a/b 与 /a/b/ 被当成两个 worktree。 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  return resolve(left) === resolve(right)
}

/**
 * 执行 task。
 *
 * @param {{
 *   issue: number,
 *   root?: string,
 *   cwd?: string,
 *   retry?: number,
 *   runner?: Function,
 *   sleep?: (ms: number) => void,
 *   exists?: (path: string) => boolean,
 * }} input
 * @returns {{ ok: boolean, code?: string|number, error?: string, lines: string[], branch?: string, worktree?: string, idempotent?: boolean }}
 */
export function runTask({
  issue,
  root,
  cwd,
  retry = FETCH_RETRY,
  runner,
  sleep,
  exists,
} = {}) {
  const git = realGit
  const gh = realGh
  const wait = typeof sleep === 'function' ? sleep : defaultSleep
  const hasPath = typeof exists === 'function' ? exists : existsSync

  if (!isIssueNumber(issue)) return fail('E_INPUT', `issue 号必须是正整数: ${String(issue)}`)
  if (!Number.isInteger(retry) || retry < 1) return fail('E_INPUT', `重试次数必须是正整数: ${String(retry)}`)

  const resolved = resolveMainRoot({
    root,
    cwd,
    git: {
      commonDir: (dir) => git.gitCommonDir(dir, { runner }),
      toplevel: (dir) => git.toplevel(dir, { runner }),
    },
  })
  if (!resolved.ok) return fail('E_ROOT', resolved.error)
  const rootPath = resolved.root

  const repo = resolveRepo({
    root: rootPath,
    git: { remoteUrl: (dir) => git.remoteUrl(dir, { runner }) },
  })
  if (!repo.ok) return fail('E_REPO', repo.error)

  const issueResult = gh.issueView(issue, { repo: repo.repo, runner })
  if (!issueResult.ok) {
    return fail('E_ISSUE', `issue #${issue} 不存在或无法访问: ${issueResult.error}`)
  }
  const title = typeof issueResult.data?.title === 'string' ? issueResult.data.title : ''
  if (title.trim().length === 0) return fail('E_ISSUE', `issue #${issue} 没有可用的标题`)

  const branch = taskBranchName(issue, title)
  const worktree = taskWorktreePath(rootPath, issue, title)

  // —— 幂等：worktree 已存在就直接收工，不 fetch、不动现场 ——
  const listed = git.worktreeList(rootPath, { runner })
  if (!listed.ok) return fail('E_GIT', `无法列出工作树: ${listed.error}`)
  const entries = Array.isArray(listed.data) ? listed.data : []
  if (entries.some((entry) => samePath(entry.path, worktree))) {
    return {
      ok: true,
      idempotent: true,
      branch,
      worktree,
      lines: [`worktree 已存在: ${worktree}`, `  cd ${worktree}`],
    }
  }

  if (hasPath(worktree)) {
    return fail('E_PATH', `路径已存在但不是本仓库的 worktree: ${worktree}（先手工处理）`)
  }

  // —— 同步 origin —— 失败重试，全失败才报错；不能拿过期基线建分支 ——
  let fetched = false
  let fetchError = ''
  for (let attempt = 1; attempt <= retry; attempt += 1) {
    const result = git.fetch(rootPath, { remote: 'origin', runner })
    if (result.ok) {
      fetched = true
      break
    }
    fetchError = result.error
    if (attempt < retry) wait(FETCH_RETRY_DELAY_MS)
  }
  if (!fetched) {
    return fail(
      'E_FETCH',
      `无法访问 GitHub（origin fetch ${retry} 次均失败）: ${fetchError}；稍后重试`,
    )
  }

  const added = git.worktreeAdd(rootPath, { branch, path: worktree, ref: BASE_REF, runner })
  if (!added.ok) return fail('E_WORKTREE', `worktree 创建失败（${worktree}）: ${added.error}`)

  // 身份兜底：worktree 共享仓库配置，通常没事；全局缺失时把当前身份写到 worktree 局部配置。
  copyIdentity({ git, from: rootPath, to: worktree, runner })

  return {
    ok: true,
    idempotent: false,
    branch,
    worktree,
    lines: [
      `issue #${issue}: ${title}`,
      `  分支:     ${branch}`,
      `  worktree: ${worktree}`,
      `  下一步:   cd ${worktree} && 开发（提交信息建议带 #${issue} ）`,
    ],
  }
}

/** 复制 git 身份到新 worktree；读不到就跳过，绝不因为身份缺失把建好的 worktree 判成失败。 */
function copyIdentity({ git, from, to, runner }) {
  for (const key of ['user.name', 'user.email']) {
    const current = git.configGet(from, key, { runner })
    if (!current.ok) continue
    const value = typeof current.data === 'string' ? current.data.trim() : ''
    if (value.length === 0) continue
    git.configSet(to, { key, value, runner })
  }
}
