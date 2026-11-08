/**
 * 合并编排：闸门 → CI → squash 合并 → 现场清理。
 *
 * 本文件只做编排，不含任何执行细节：
 *   - 判定走 lib/gate.mjs + lib/record.mjs（与 gate 子命令同一套规则）；
 *   - CI 判定走 deps.gh.prChecks，或用 checksFile 读一份本地 JSON 替代（自测用）；
 *   - 所有外部动作走注入的 deps.gh / deps.git（默认真实模块），因此单测可以用
 *     假依赖断言「按什么顺序做了什么」，不触网、不动真实仓库；
 *   - 时间走 deps.now，审计与时效判定可复现。
 *
 * 三个开关（对齐参考脚本 merge-pr.sh 的语义）：
 *   - checkOnly：只跑到 CI 门槛为止，不合并、不清理，返回 ok 供 CLI 打印演练结论；
 *   - checksFile：用文件内容代替 gh pr checks（文件形如 {"state":"success"}）；
 *   - force：CI 未过仍继续合并，但**闸门不受影响**——闸门在 CI 之前，顺序本身就是
 *     这条保证；force 只影响 ci 这一步，且会在步骤里标成「跳过」而非「通过」。
 *
 * 失败语义：任一步失败即停在该步，返回 { ok:false, step, code, error }，
 * 但 steps 里保留此前成功的每一步——调用方能看出流程停在哪里、前面做成了什么。
 * 不做「失败后回滚」：合并已在服务端发生，回滚比如实报告更危险。
 *
 * 远端分支的删除交给 `gh pr merge` 的默认行为（仓库设置 auto-delete-branch）：
 * 本包对 git 的允许清单里没有 `push origin --delete`，也不打算为它开后门。
 */
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

/** 分支仍被某个工作区检出（git 拒绝删除当前分支）：只跳过删除，不中断收尾。 */
const BRANCH_CHECKED_OUT = /checked out|used by worktree|currently checked out/i

/** 步骤名的固定顺序，供调用方与测试断言。 */
export const STEP_ORDER = Object.freeze([
  'repo',
  'head',
  'gate',
  'pr',
  'ci',
  'merge',
  'worktree',
  'fetch',
  'ff',
  'branch',
])

/** CI 判定的三种归一结果：通过 / 未通过 / 根本没有 checks。 */
const CI_SUCCESS = 'success'
const CI_FAILURE = 'failure'
const CI_NONE = 'none'

/** 视为阻塞的 check 状态（含 gh 的 pending 一族）。 */
const CHECK_BLOCKING = new Set([
  'fail',
  'failure',
  'failing',
  'cancel',
  'canceled',
  'cancelled',
  'pending',
  'queued',
  'in_progress',
  'timed_out',
  'action_required',
  'startup_failure',
  'error',
])

/** 视为放行的 check 状态：skipping 是主动跳过，不算失败。 */
const CHECK_PASSING = new Set(['pass', 'passing', 'skipping', 'skipped', 'success', 'successful'])

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * 把 checks 数据折成 success / failure / none。
 * 未知状态按阻塞处理：判定不出来时不静默放行。
 */
function judgeChecksValue(value) {
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: CI_NONE, detail: '没有 CI checks' }
    const blocked = []
    for (const item of value) {
      const name = typeof item?.name === 'string' && item.name.length > 0 ? item.name : '未命名 check'
      const raw =
        typeof item?.bucket === 'string' ? item.bucket : typeof item?.state === 'string' ? item.state : ''
      const status = raw.toLowerCase()
      if (CHECK_PASSING.has(status)) continue
      blocked.push(CHECK_BLOCKING.has(status) ? name : `${name}（状态无法判定: ${status || '空'}）`)
    }
    if (blocked.length > 0) return { kind: CI_FAILURE, detail: blocked.join(', ') }
    return { kind: CI_SUCCESS, detail: `${value.length} 项全部通过` }
  }

  if (isPlainObject(value) && typeof value.state === 'string') {
    const state = value.state.trim().toLowerCase()
    if (state === 'success') return { kind: CI_SUCCESS, detail: 'state=success' }
    if (CHECK_PASSING.has(state)) return { kind: CI_SUCCESS, detail: `state=${state}` }
    return { kind: CI_FAILURE, detail: `state=${state.length > 0 ? state : '空'}` }
  }

  return { kind: CI_FAILURE, detail: 'checks 数据无法判定' }
}

/** 读 checksFile：不可读 / 非 JSON 一律算 CI 无法判定（E_CI），不静默放行。 */
function readChecksFile(checksFile, pr) {
  let text
  try {
    text = readFileSync(checksFile, 'utf8')
  } catch (error) {
    return { ok: false, code: 'E_CI', detail: `CI 检查: 无法读取 --checks-file: ${checksFile}: ${messageOf(error)}` }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { ok: false, code: 'E_CI', detail: `CI 检查: --checks-file 不是合法 JSON: ${checksFile}` }
  }
  const verdict = judgeChecksValue(data)
  if (verdict.kind === CI_FAILURE) {
    return { ok: false, code: 'E_CI', detail: `CI 检查: PR #${pr} 未通过（--checks-file）: ${verdict.detail}` }
  }
  const label = verdict.kind === CI_NONE ? '没有 CI checks，跳过门槛' : `通过（--checks-file）: ${verdict.detail}`
  return { ok: true, kind: verdict.kind, detail: `CI 检查: PR #${pr} ${label}` }
}

/** 判 gh.prChecks 的结果：gh 真的失败（非零退出）算 E_CI，取不到 checks 则跳过门槛。 */
function judgeGhChecks(result, pr) {
  if (result?.ok) {
    const verdict = judgeChecksValue(result.data)
    if (verdict.kind === CI_FAILURE) {
      return { ok: false, code: 'E_CI', detail: `CI 检查: PR #${pr} 存在未通过/进行中的 checks: ${verdict.detail}` }
    }
    const label = verdict.kind === CI_NONE ? '没有 CI checks，跳过门槛' : `CI 全部通过: ${verdict.detail}`
    return { ok: true, kind: verdict.kind, detail: `CI 检查: PR #${pr} ${label}` }
  }
  // gh 退出码 0 却没有可解析输出：该 PR 没有配置 checks（与参考脚本「无 checks 跳过门槛」一致）
  if (result?.code === 0) {
    return { ok: true, kind: CI_NONE, detail: `CI 检查: PR #${pr} 没有 CI checks（gh 无输出），跳过门槛` }
  }
  return {
    ok: false,
    code: 'E_CI',
    detail: `CI 检查: 无法获取 PR #${pr} 的 checks: ${result?.error ?? '未知错误'}`,
  }
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

/** 路径比较按绝对路径归一：调用方给的 root 可能带尾斜杠或走符号链接。 */
function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false
  if (left.length === 0 || right.length === 0) return false
  return resolve(left) === resolve(right)
}

/**
 * 闸门判定：跳过审计、fail-closed、记录校验、时效与策略。
 * 与 gate 子命令同一套顺序，区别只在这里把结果折成一步的 detail。
 */
function decideGate({ pr, root, recordPath, noReview, reason, headSha, now, maxRounds }) {
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
    maxRounds,
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
 *   checkOnly?: boolean,
 *   checksFile?: string,
 *   force?: boolean,
 *   deps?: { gh?: object, git?: object, now?: () => Date },
 * }} input
 * @returns {{ ok: boolean, steps: {name: string, ok: boolean, detail: string, skipped?: boolean}[], step?: string, code?: string, error?: string, checkOnly?: boolean }}
 */
export function runMerge({
  pr,
  root,
  recordPath,
  noReview = false,
  reason,
  headSha,
  checkOnly = false,
  checksFile,
  force = false,
  deps = {},
} = {}) {
  const gh = { prView: realGh.prView, prMerge: realGh.prMerge, prChecks: realGh.prChecks, ...deps.gh }
  const git = {
    headSha: realGit.headSha,
    worktreeList: realGit.worktreeList,
    worktreeRemove: realGit.worktreeRemove,
    currentBranch: realGit.currentBranch,
    statusPorcelain: realGit.statusPorcelain,
    checkout: realGit.checkout,
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
  // 必须取 **PR 的 head**，不是本机 HEAD：合并通常从主工作区发起，
  // 本机 HEAD 是 main 的提交，拿它比对判定记录会永远对不上。
  let sha = headSha
  if (sha === undefined) {
    const prHead = gh.prView(pr, { repo })
    if (!prHead.ok) return stop('head', 'E_HEAD', `读取 PR head 失败: ${prHead.error}`)
    const candidate = prHead.data?.headRefOid
    if (typeof candidate !== 'string' || !SHA_PATTERN.test(candidate)) {
      return stop('head', 'E_STATE', `PR #${pr} 没有可用的 headRefOid`)
    }
    sha = candidate
  } else if (typeof sha !== 'string' || !SHA_PATTERN.test(sha)) {
    return stop('head', 'E_INPUT', `headSha 必须是 40 位小写十六进制: ${String(sha)}`)
  }
  done('head', `head 提交: ${sha}${headSha === undefined ? '' : '（指定）'}`)

  // —— 3. 闸门 ——
  const gate = decideGate({
    pr,
    root,
    recordPath,
    noReview,
    reason,
    headSha: sha,
    now,
    maxRounds: config.review.rounds,
  })
  if (!gate.ok) return stop('gate', gate.code, gate.detail)
  done('gate', gate.detail)

  // —— 4. 定位 PR 的分支 ——
  // 清理要按分支反查 worktree，而分支名只有 gh 知道；这一步是只读的，
  // 放在闸门之后：闸门不通过时一条 gh 命令都不发（既有契约，见 contract 测试）。
  const view = gh.prView(pr, { repo })
  if (!view.ok) return stop('pr', view.code ?? 'E_GH', `读取 PR 失败: ${view.error}`)
  const branch = typeof view.data?.headRefName === 'string' ? view.data.headRefName : ''
  const state = typeof view.data?.state === 'string' ? view.data.state.toUpperCase() : ''
  if (branch.length === 0) return stop('pr', 'E_PR', `PR #${pr} 缺少 headRefName，无法定位分支`)
  if (state === 'CLOSED') return stop('pr', 'E_PR', `PR #${pr} 状态为 CLOSED，无法合并`)
  done('pr', `PR #${pr}: 分支 ${branch}，状态 ${state || '未知'}`)

  // —— 5. CI 检查 ——
  // 闸门排在 CI 之前：--force 只跳过 CI，绕不过闸门（顺序即保证，无需额外分支）。
  // force 时连 gh 都不发，与参考脚本「--force 跳过 CI 门槛」一致。
  if (force) {
    steps.push({
      name: 'ci',
      ok: true,
      skipped: true,
      detail: 'CI 检查: 已按 --force 跳过（未调用 gh pr checks / 未读 --checks-file）',
    })
  } else {
    const judged =
      checksFile === undefined
        ? judgeGhChecks(gh.prChecks(pr, { repo }), pr)
        : readChecksFile(checksFile, pr)
    if (!judged.ok) return stop('ci', judged.code, judged.detail)
    done('ci', judged.detail)
  }

  // —— 5b. 演练模式：闸门与 CI 都过了就停，不合并、不清理 ——
  if (checkOnly) return { ok: true, steps, checkOnly: true }

  // —— 6. squash 合并 ——
  if (state === 'MERGED') {
    done('merge', `PR #${pr} 已是 MERGED，跳过合并，仅清理现场`)
  } else {
    const merged = gh.prMerge(pr, { repo, squash: true })
    if (!merged.ok) return stop('merge', merged.code ?? 'E_GH', `合并失败: ${merged.error}`)
    done('merge', `已合并 PR #${pr}（--squash）`)
  }

  // —— 7. 清理现场 ——
  // 主工作区取 `git worktree list --porcelain` 的第一条：git 保证主工作区排在最前。
  // 不能只按「哪个 worktree 检出 main」反查——PR 分支本身就在主工作区 checkout 时，
  // 没有 worktree 检出 main，反查会退回 root，把主工作区当成普通 worktree 去 remove。
  const listed = git.worktreeList(root, {})
  if (!listed.ok) return stop('worktree', listed.code ?? 'E_GIT', `无法列出工作树: ${listed.error}`)
  const entries = Array.isArray(listed.data) ? listed.data : []
  const mainEntry = entries[0] ?? entries.find((entry) => entry.branch === MAIN_BRANCH)
  const mainWorktree =
    typeof mainEntry?.path === 'string' && mainEntry.path.length > 0 ? mainEntry.path : root

  // 7a. 找到检出该分支的 worktree 并移除（root 自身不可能是待移除对象）
  const holder = entries.find((entry) => entry.branch === branch && !samePath(entry.path, root))
  if (!holder) {
    done('worktree', `没有持有 ${branch} 的 worktree，跳过移除`)
  } else if (samePath(holder.path, mainWorktree)) {
    // 主工作区不可 remove（git 会报 "is a main working tree"）：跳过删除、继续收尾。
    // 分支交给 7c 的 branch -D 处理，fetch / 快进 / 删分支都不受影响。
    done(
      'worktree',
      `分支 ${branch} 检出在主工作区 ${holder.path}，跳过 worktree 移除（不删除主工作区，仅删分支）`,
    )
  } else {
    const removed = git.worktreeRemove(mainWorktree, holder.path, {})
    if (!removed.ok) {
      return stop('worktree', removed.code ?? 'E_GIT', `worktree 移除失败: ${holder.path}: ${removed.error}`)
    }
    done('worktree', `已移除 worktree: ${holder.path}`)
  }

  // 7b. 主工作区 fetch（只更新远端引用，不动工作区）
  const fetched = git.fetch(mainWorktree, { remote: 'origin' })
  if (!fetched.ok) return stop('fetch', fetched.code ?? 'E_GIT', `fetch origin 失败: ${fetched.error}`)
  done('fetch', `已 fetch origin（主工作区 ${mainWorktree}）`)

  // 7c. 快进前先确认主工作区停在 main：
  // 主工作区检出的若是 PR 分支（上一个 PR 收尾时留下的现场），
  // `merge --ff-only origin/main` 必然失败（当前分支不是 main）。分三种情况：
  //   - 已在 main：直接快进；
  //   - 不在 main 但工作区干净：先 checkout main（明确打印这一动作），再快进；
  //   - 不在 main 且有未提交改动：绝不改动用户现场，跳过快进并给出可执行提示，
  //     继续往下删分支（删不掉就跳过并说明），流程不中断。
  let currentBranchName = ''
  if (typeof mainEntry?.branch === 'string' && mainEntry.branch.length > 0) {
    currentBranchName = mainEntry.branch
  } else if (mainEntry?.detached === true) {
    currentBranchName = 'HEAD'
  } else {
    const probed = git.currentBranch(mainWorktree, {})
    if (probed.ok && typeof probed.data === 'string') currentBranchName = probed.data.trim()
  }
  const branchLabel = currentBranchName.length > 0 ? currentBranchName : '未知分支'

  let ffPrefix = ''
  let ffSkip = ''
  if (currentBranchName !== MAIN_BRANCH) {
    const status = git.statusPorcelain(mainWorktree, {})
    if (!status.ok) {
      ffSkip = `无法读取主工作区状态（${status.error}），跳过快进 ${FF_REF}；请手动执行 git -C ${mainWorktree} checkout ${MAIN_BRANCH} 后重试`
    } else if (String(status.data ?? '').trim().length > 0) {
      ffSkip = `主工作区停留在 ${branchLabel}，请手动切换后重试（有未提交改动，未改动现场，已跳过快进 ${FF_REF}）`
    } else {
      const switched = git.checkout(mainWorktree, { branch: MAIN_BRANCH })
      if (!switched.ok) {
        return stop(
          'ff',
          switched.code ?? 'E_GIT',
          `主工作区停留在 ${branchLabel}，切换 ${MAIN_BRANCH} 失败: ${switched.error}；请手动执行 git -C ${mainWorktree} checkout ${MAIN_BRANCH} 后重试`,
        )
      }
      ffPrefix = `已从 ${branchLabel} 切换到 ${MAIN_BRANCH}；`
    }
  }

  if (ffSkip.length > 0) {
    steps.push({ name: 'ff', ok: true, skipped: true, detail: ffSkip })
  } else {
    const advanced = git.mergeFF(mainWorktree, { ref: FF_REF })
    if (!advanced.ok) {
      return stop('ff', advanced.code ?? 'E_GIT', `main 快进失败（${FF_REF}）: ${advanced.error}`)
    }
    done('ff', `${ffPrefix}main 已快进到 ${FF_REF}`)
  }

  // 7d. 删除本地分支（远端分支由 gh pr merge 的默认行为处理）
  // 合并方式固定 squash，原提交永远不是 main 的祖先，-d 必然拒绝，因此显式强删。
  // 分支仍被某个工作区检出时 git 会拒绝，这属于「用户现场还没收拾好」：
  // 跳过删除并说明怎么手动做，不把整条流程判失败。
  const deleted = git.deleteBranch(mainWorktree, branch, { force: true })
  if (deleted.ok) {
    done('branch', `已删除本地分支: ${branch}（-D）`)
  } else if (BRANCH_GONE.test(String(deleted.error))) {
    done('branch', `本地分支 ${branch} 已不存在，跳过删除`)
  } else if (BRANCH_CHECKED_OUT.test(String(deleted.error))) {
    done(
      'branch',
      `本地分支 ${branch} 仍被工作区检出，跳过删除；请手动执行 git -C ${mainWorktree} branch -D -- ${branch}`,
    )
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
