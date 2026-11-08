/**
 * 仓库定位：把「在哪（root）」与「对谁（owner/name）」这两件事收敛成两条纯规则。
 *
 * 有两套 root 语义，不能混用：
 *   - resolveRoot：当前工作树，用 `git rev-parse --show-toplevel`。
 *     pr 需要它——在 task worktree 里运行时就该读该 worktree 的分支；
 *   - resolveMainRoot：主工作区，用 `git rev-parse --git-common-dir` 的父目录。
 *     task 需要它——worktree 容器必须永远相对主工作区，否则在 worktree 里
 *     再跑 task 会得到 .worktrees/xxx/.worktrees/yyy 这种嵌套路径。
 *
 * repo 缺省时读 .dsh/pipeline.json；没配就从 origin 的远端地址反推。
 * 两条都拿不到就明确失败——绝不猜一个仓库去开 PR。
 */
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'

import { loadConfig } from './config.mjs'

/** owner/name 只允许两段，与 config.mjs 同一条规则。 */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/

/**
 * 从远端地址还原 owner/name，覆盖三种常见写法：
 *   git@github.com:owner/name.git
 *   https://github.com/owner/name.git
 *   ssh://git@github.com/owner/name
 * 认不出来返回 null（调用方报错，不兜底）。
 */
export function repoFromRemote(url) {
  const text = typeof url === 'string' ? url.trim() : ''
  if (text.length === 0) return null
  const match = /^(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(
    text,
  )
  if (!match) return null
  const repo = `${match[1]}/${match[2]}`
  return REPO_PATTERN.test(repo) ? repo : null
}

/**
 * 解析仓库根：显式 root 优先，否则问 git 当前工作树。
 * @returns {{ ok: true, root: string } | { ok: false, error: string }}
 */
export function resolveRoot({ root, cwd, git } = {}) {
  if (typeof root === 'string' && root.trim().length > 0) return { ok: true, root }
  const result = git.toplevel(cwd)
  if (!result.ok) return { ok: false, error: `无法定位仓库根目录: ${result.error}` }
  const top = typeof result.data === 'string' ? result.data.trim() : ''
  if (top.length === 0) return { ok: false, error: '无法定位仓库根目录（git 未返回路径）' }
  return { ok: true, root: top }
}

/**
 * 公共 git 目录 → 主工作区。
 * git 返回的可能是相对路径（相对 -C 传入的 cwd，如 `.git` / `../.git`），
 * 所以先按 cwd 归一成绝对路径，再取父目录。
 * @returns {string | null} 归一失败（空路径 / 根目录）返回 null
 */
export function mainRootFromCommonDir(commonDir, cwd) {
  const text = typeof commonDir === 'string' ? commonDir.trim() : ''
  if (text.length === 0) return null
  const base = typeof cwd === 'string' && cwd.trim().length > 0 ? cwd : process.cwd()
  const absolute = isAbsolute(text) ? text : resolve(base, text)
  const parent = dirname(absolute)
  if (parent === absolute) return null
  return parent
}

/** 比较用路径：解析符号链接（macOS 的 /var → /private/var 很常见），不存在时退回字面归一。 */
function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/**
 * 显式 root 落在某个 linked worktree 顶层时折回主工作区。
 * 读不到 git（非仓库、git 失败）或 root 是子目录时保持原样——
 * 前者沿用「显式 root 直接用」的旧语义，后者不经手，避免悄悄改变基准。
 */
function foldWorktreeRoot(root, git) {
  const common = git.commonDir(root)
  if (!common.ok) return root
  const main = mainRootFromCommonDir(common.data, root)
  const canonicalRoot = canonicalPath(root)
  if (main === null || canonicalPath(main) === canonicalRoot) return root

  const top = git.toplevel(root)
  if (!top.ok) return root
  const topPath = typeof top.data === 'string' ? top.data.trim() : ''
  if (topPath.length === 0) return root
  return canonicalPath(topPath) === canonicalRoot ? main : root
}

/**
 * 解析主工作区根（task 专用）：worktree 容器永远相对主工作区。
 *
 * 显式 root 以传入为准，但如果它正好是某个 linked worktree 的顶层，
 * 会折回主工作区（文档与测试都覆盖这一条），而不是在 worktree 里再嵌套。
 * @returns {{ ok: true, root: string } | { ok: false, error: string }}
 */
export function resolveMainRoot({ root, cwd, git } = {}) {
  if (typeof root === 'string' && root.trim().length > 0) {
    return { ok: true, root: foldWorktreeRoot(root, git) }
  }
  const result = git.commonDir(cwd)
  if (!result.ok) return { ok: false, error: `无法定位主工作区: ${result.error}` }
  const main = mainRootFromCommonDir(result.data, cwd)
  if (main === null) return { ok: false, error: '无法定位主工作区（git 未返回公共 git 目录）' }
  return { ok: true, root: main }
}

/**
 * 解析仓库标识：配置里的 repo 优先，其次从 origin 反推。
 * @returns {{ ok: true, repo: string } | { ok: false, error: string }}
 */
export function resolveRepo({ root, git } = {}) {
  let configured = null
  try {
    configured = loadConfig(root).config.repo
  } catch (error) {
    // 配置读不出来是配置问题（退 2），不是环境问题
    return { ok: false, code: 'E_CONFIG', error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof configured === 'string' && REPO_PATTERN.test(configured)) {
    return { ok: true, repo: configured }
  }

  const remote = git.remoteUrl(root)
  if (!remote.ok) {
    return { ok: false, code: 'E_ENV', error: `未配置仓库标识，且读取 origin 失败: ${remote.error}` }
  }
  const repo = repoFromRemote(remote.data)
  if (repo === null) {
    return { ok: false, code: 'E_ENV', error: `无法从 origin 识别 owner/name: ${String(remote.data)}` }
  }
  return { ok: true, repo }
}
