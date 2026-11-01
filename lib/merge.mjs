/**
 * 合并编排：闸门 → squash 合并 → 现场清理。
 *
 * 本文件只做编排，不含任何执行细节：
 *   - 判定走 lib/gate.mjs + lib/record.mjs（与 gate 子命令同一套规则）；
 *   - 所有外部动作走注入的 deps.gh / deps.git（默认真实模块），因此单测可以用
 *     假依赖断言「按什么顺序做了什么」，不触网、不动真实仓库；
 *   - 时间走 deps.now，审计与时效判定可复现。
 *
 * 失败语义：任一步失败即停在该步，返回 { ok:false, step, code, error }，
 * 但 steps 里保留此前成功的每一步——调用方能看出流程停在哪里、前面做成了什么。
 * 不做「失败后回滚」：合并已在服务端发生，回滚比如实报告更危险。
 *
 * 远端分支的删除交给 `gh pr merge` 的默认行为（仓库设置 auto-delete-branch）：
 * 本包对 git 的允许清单里没有 `push origin --delete`，也不打算为它开后门。
 */
import { join } from 'node:path'

import { loadConfig } from './config.mjs'
import { evaluateGate } from './gate.mjs'
import * as realGh from './gh.mjs'
import * as realGit from './git.mjs'
import { PACKAGE_VERSION, SHA_PATTERN, readRecord, reviewsDir, writeSkipAudit } from './record.mjs'

/** repo 只接受 owner/name 两段（与 config.mjs 同一条规则）。 */
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/** 主工作区快进时显式命名的 merge head：不读 FETCH_HEAD，绝不非快进合并。 */
export const FF_REF = 'origin/main'

/** 主工作区分支名。 */
export const MAIN_BRANCH = 'main'

/** 本地分支其实已经不存在（幂等重跑时会遇到），按「无需删除」处理。 */
const BRANCH_GONE = /not found|no branch named|did not match|unknown revision/i

/** 强删仍被拒绝时的兜底识别：这已不该发生，出现即如实报错而非当作成功。 */
const BRANCH_UNMERGED = /not fully merged/i

/** 步骤名的固定顺序，供调用方与测试断言。 */
export const STEP_ORDER = Object.freeze([
  'repo',
  'head',
  'gate',
  'pr',
  'merge',
  'worktree',
  'fetch',
  'ff',
  'branch',
])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

/**
 * 闸门判定：跳过审计、fail-closed、记录校验、时效与策略。
 * 与 gate 子命令同一套顺序，区别只在这里把结果折成一步的 detail。
 */
function decideGate({ pr, root, recordPath, noReview, reason, headSha, now }) {
  if (noReview) {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      return { ok: false, code: 'E_INPUT', detail: '审核闸门: --no-review 必须提供跳过原因' }
    }
    try {
      const file = writeSkipAudit(reviewsDir(root), { pr, headSha, reason, now: now() })
      return { ok: true, detail: `跳过审核（原因: ${reason}）；审计记录: ${file}` }
    } catch (error) {
      return { ok: false, code: 'E_AUDIT', detail: `跳过审核失败: ${messageOf(error)}` }
    }
  }

  if (recordPath === undefined) {
    return {
      ok: false,
      code: 'E_RECORD',
      detail: '审核闸门: 未提供审核记录，且未声明 --no-review，按失败关闭处理',
    }
  }

  let candidate
  try {
    candidate = readRecord(recordPath)
  } catch (error) {
    return { ok: false, code: error?.code ?? 'E_RECORD', detail: `审核闸门: ${messageOf(error)}` }
  }

  if (candidate.pr !== pr) {
    return {
      ok: false,
      code: 'E_PR_MISMATCH',
      detail: `审核闸门: 记录属于 PR #${String(candidate.pr)}，与 --pr #${pr} 不符`,
    }
  }

  const verdict = evaluateGate({
    record: candidate,
    headSha,
    currentPolicyVersion: PACKAGE_VERSION,
    now: now(),
  })
  if (!verdict.ok) {
    return { ok: false, code: verdict.code, detail: `审核闸门: ${verdict.reason}` }
  }

  return { ok: true, detail: `审核闸门: PR #${pr} 通过（提交 ${headSha}）` }
}

/**
 * 完整合并流程。
 *
 * @param {{
 *   pr: number,
 *   root: string,
 *   recordPath?: string,
 *   noReview?: boolean,
 *   reason?: string,
 *   headSha?: string,
 *   deps?: { gh?: object, git?: object, now?: () => Date },
 * }} input
 * @returns {{ ok: boolean, steps: {name: string, ok: boolean, detail: string}[], step?: string, code?: string, error?: string }}
 */
export function runMerge({
  pr,
  root,
  recordPath,
  noReview = false,
  reason,
  headSha,
  deps = {},
} = {}) {
  const gh = { prView: realGh.prView, prMerge: realGh.prMerge, ...deps.gh }
  const git = {
    headSha: realGit.headSha,
    worktreeList: realGit.worktreeList,
    worktreeRemove: realGit.worktreeRemove,
    fetch: realGit.fetch,
    mergeFF: realGit.mergeFF,
    deleteBranch: realGit.deleteBranch,
    ...deps.git,
  }
  const now = typeof deps.now === 'function' ? deps.now : () => new Date()

  const steps = []
  const done = (name, detail) => {
    steps.push({ name, ok: true, detail })
  }
  const stop = (name, code, detail) => {
    steps.push({ name, ok: false, detail })
    return { ok: false, step: name, code, error: detail, steps }
  }

  // —— 入参 ——
  if (!isPositiveInt(pr)) return stop('input', 'E_INPUT', `pr 必须是正整数: ${String(pr)}`)
  if (typeof root !== 'string' || root.trim().length === 0) {
    return stop('input', 'E_INPUT', `root 必须是非空字符串: ${String(root)}`)
  }

  // —— 1. 解析仓库（配置） ——
  const configFile = join(root, '.dsh', 'pipeline.json')
  let config
  try {
    config = loadConfig(root).config
  } catch (error) {
    return stop('repo', error?.code ?? 'E_CONFIG', messageOf(error))
  }
  const repo = config.repo
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
    return stop('repo', 'E_CONFIG', `未配置仓库标识（${configFile} 缺少 repo）`)
  }
  done('repo', `仓库: ${repo}`)

  // —— 2. 取 head sha ——
  let sha = headSha
  if (sha === undefined) {
    const current = git.headSha(root, {})
    if (!current.ok) return stop('head', 'E_HEAD', `无法获取当前 head 提交: ${current.error}`)
    sha = current.data
  } else if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    return stop('head', 'E_INPUT', `headSha 必须是 40 位小写十六进制: ${String(sha)}`)
  }
  done('head', `head 提交: ${sha}${headSha === undefined ? '' : '（指定）'}`)

  // —— 3. 闸门 ——
  const gate = decideGate({ pr, root, recordPath, noReview, reason, headSha: sha, now })
  if (!gate.ok) return stop('gate', gate.code, gate.detail)
  done('gate', gate.detail)

  // —— 4. 定位 PR 的分支 ——
  // 清理要按分支反查 worktree，而分支名只有 gh 知道；放在闸门之后，
  // 「闸门不通过时一条 gh 命令都不发」这条硬承诺才成立。
  const view = gh.prView(pr, { repo })
  if (!view.ok) return stop('pr', view.code ?? 'E_GH', `读取 PR 失败: ${view.error}`)
  const branch = typeof view.data?.headRefName === 'string' ? view.data.headRefName : ''
  const state = typeof view.data?.state === 'string' ? view.data.state.toUpperCase() : ''
  if (branch.length === 0) return stop('pr', 'E_PR', `PR #${pr} 缺少 headRefName，无法定位分支`)
  if (state === 'CLOSED') return stop('pr', 'E_PR', `PR #${pr} 状态为 CLOSED，无法合并`)
  done('pr', `PR #${pr}: 分支 ${branch}，状态 ${state || '未知'}`)

  // —— 5. squash 合并 ——
  if (state === 'MERGED') {
    done('merge', `PR #${pr} 已是 MERGED，跳过合并，仅清理现场`)
  } else {
    const merged = gh.prMerge(pr, { repo, squash: true })
    if (!merged.ok) return stop('merge', merged.code ?? 'E_GH', `合并失败: ${merged.error}`)
    done('merge', `已合并 PR #${pr}（--squash）`)
  }

  // —— 6. 清理现场 ——
  // 主工作区从 worktree 列表反查：从 worktree 内运行与从主工作区运行都要能收尾。
  const listed = git.worktreeList(root, {})
  if (!listed.ok) return stop('worktree', listed.code ?? 'E_GIT', `无法列出工作树: ${listed.error}`)
  const entries = Array.isArray(listed.data) ? listed.data : []
  const mainEntry = entries.find((entry) => entry.branch === MAIN_BRANCH)
  const mainWorktree = mainEntry ? mainEntry.path : root

  // 6a. 找到检出该分支的 worktree 并移除（root 自身不可能是待移除对象）
  const holder = entries.find((entry) => entry.branch === branch && entry.path !== root)
  if (holder) {
    const removed = git.worktreeRemove(mainWorktree, holder.path, {})
    if (!removed.ok) {
      return stop('worktree', removed.code ?? 'E_GIT', `worktree 移除失败: ${holder.path}: ${removed.error}`)
    }
    done('worktree', `已移除 worktree: ${holder.path}`)
  } else {
    done('worktree', `没有持有 ${branch} 的 worktree，跳过移除`)
  }

  // 6b. 主工作区 fetch + 快进 main（显式命名 origin/main，不读 FETCH_HEAD）
  const fetched = git.fetch(mainWorktree, { remote: 'origin' })
  if (!fetched.ok) return stop('fetch', fetched.code ?? 'E_GIT', `fetch origin 失败: ${fetched.error}`)
  done('fetch', `已 fetch origin（主工作区 ${mainWorktree}）`)

  const advanced = git.mergeFF(mainWorktree, { ref: FF_REF })
  if (!advanced.ok) {
    return stop('ff', advanced.code ?? 'E_GIT', `main 快进失败（${FF_REF}）: ${advanced.error}`)
  }
  done('ff', `main 已快进到 ${FF_REF}`)

  // 6c. 删除本地分支（远端分支由 gh pr merge 的默认行为处理）
  // 合并方式固定 squash，原提交永远不是 main 的祖先，-d 必然拒绝，因此显式强删。
  const deleted = git.deleteBranch(mainWorktree, branch, { force: true })
  if (deleted.ok) {
    done('branch', `已删除本地分支: ${branch}（-D）`)
  } else if (BRANCH_GONE.test(String(deleted.error))) {
    done('branch', `本地分支 ${branch} 已不存在，跳过删除`)
  } else if (BRANCH_UNMERGED.test(String(deleted.error))) {
    return stop(
      'branch',
      'E_BRANCH_UNMERGED',
      `本地分支 ${branch} 未删除: 强制删除仍被拒绝（not fully merged）: ${deleted.error}`,
    )
  } else {
    return stop('branch', deleted.code ?? 'E_GIT', `本地分支 ${branch} 删除失败: ${deleted.error}`)
  }

  return { ok: true, steps }
}
