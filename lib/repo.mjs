/**
 * 仓库定位：把「在哪（root）」与「对谁（owner/name）」这两件事收敛成两条纯规则。
 *
 * root 缺省时用 `git rev-parse --show-toplevel`，而不是 process.cwd()：
 * 在子目录里跑同样要落到仓库根，否则 worktree 路径会跟着运行目录漂。
 *
 * repo 缺省时读 .dsh/pipeline.json；没配就从 origin 的远端地址反推。
 * 两条都拿不到就明确失败——绝不猜一个仓库去开 PR。
 */
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
 * 解析仓库根：显式 root 优先，否则问 git。
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
 * 解析仓库标识：配置里的 repo 优先，其次从 origin 反推。
 * @returns {{ ok: true, repo: string } | { ok: false, error: string }}
 */
export function resolveRepo({ root, git } = {}) {
  let configured = null
  try {
    configured = loadConfig(root).config.repo
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (typeof configured === 'string' && REPO_PATTERN.test(configured)) {
    return { ok: true, repo: configured }
  }

  const remote = git.remoteUrl(root)
  if (!remote.ok) {
    return { ok: false, error: `未配置仓库标识，且读取 origin 失败: ${remote.error}` }
  }
  const repo = repoFromRemote(remote.data)
  if (repo === null) {
    return { ok: false, error: `无法从 origin 识别 owner/name: ${String(remote.data)}` }
  }
  return { ok: true, repo }
}
