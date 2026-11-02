/**
 * pr 子命令：推送当前 task 分支并开 PR。
 *
 * 语义对齐 self-dsh-plugins 的 scripts/pipeline/open-pr.sh：
 *   - 当前分支必须形如 task/<号>-<slug>，否则退出 2（issue 号从分支名解析，不额外问用户）；
 *   - 工作区必须干净（未提交改动就开 PR 等于把半成品当成品）；
 *   - 幂等：PR 已存在 → 只打印链接，不重推、不新建；
 *   - PR 正文首行固定 `Closes #<号>`，其余写明合并前提，避免每次都要人去翻手册。
 *
 * 所有外部动作走注入的 runner，单测用假 runner 断言 argv，不触网、不动真实仓库。
 */
import * as realGit from './git.mjs'
import * as realGh from './gh.mjs'
import { resolveRepo, resolveRoot } from './repo.mjs'

/** 分支名规则：task/<号>-<slug>；slug 与 task 子命令的 slugify 同源。 */
export const TASK_BRANCH_PATTERN = /^task\/([1-9][0-9]*)-([a-z0-9][a-z0-9-]*)$/

/** PR 的 base 分支。 */
export const PR_BASE = 'main'

function fail(code, error) {
  return { ok: false, code, error, lines: [] }
}

/**
 * 从分支名解析 issue 号；不合规返回 null（调用方按参数错误处理）。
 */
export function issueFromBranch(branch) {
  const match = TASK_BRANCH_PATTERN.exec(typeof branch === 'string' ? branch : '')
  if (!match) return null
  const issue = Number(match[1])
  return Number.isInteger(issue) && issue > 0 ? issue : null
}

/**
 * PR 正文：首行 Closes #<号>（合并即自动关 issue），其后是合并前提。
 * 这段文字与 docs/pipeline/README.md §四 的口径一致，改动请同步。
 */
export function prBody(issue) {
  return [
    `Closes #${issue}`,
    '',
    '---',
    '由 dsh-pipeline pr 创建。',
    '合并前提：CI 通过 + 审核闸门通过；APPROVE 且未命中高风险可直接合并；命中高风险 / ESCALATE / 轮次超限才需要人点头（见 docs/pipeline/README.md §四 第 1 条）。',
  ].join('\n')
}

/**
 * 执行 pr。
 *
 * @param {{ root?: string, cwd?: string, runner?: Function }} input
 * @returns {{ ok: boolean, code?: string|number, error?: string, lines: string[], branch?: string, url?: string, existing?: boolean }}
 */
export function runPr({ root, cwd, runner } = {}) {
  const git = realGit
  const gh = realGh

  const resolved = resolveRoot({ root, cwd, git: { toplevel: (dir) => git.toplevel(dir, { runner }) } })
  if (!resolved.ok) return fail('E_ROOT', resolved.error)
  const rootPath = resolved.root

  const current = git.currentBranch(rootPath, { runner })
  if (!current.ok) return fail('E_GIT', `无法读取当前分支: ${current.error}`)
  const branch = typeof current.data === 'string' ? current.data.trim() : ''
  const issue = issueFromBranch(branch)
  if (issue === null) {
    const shown = branch.length > 0 ? branch : '<detached>'
    return fail('E_BRANCH', `当前不在 task/<号>-<slug> 分支上: ${shown}（应在对应 worktree 里运行）`)
  }

  const repo = resolveRepo({
    root: rootPath,
    git: { remoteUrl: (dir) => git.remoteUrl(dir, { runner }) },
  })
  if (!repo.ok) return fail('E_REPO', repo.error)

  const issueResult = gh.issueView(issue, { repo: repo.repo, runner })
  if (!issueResult.ok) return fail('E_ISSUE', `issue #${issue} 无法访问: ${issueResult.error}`)
  const title = typeof issueResult.data?.title === 'string' ? issueResult.data.title.trim() : ''
  if (title.length === 0) return fail('E_ISSUE', `issue #${issue} 没有可用的标题`)

  // —— 幂等：PR 已存在就只报告，不重推、不新建 ——
  const existing = gh.prViewByBranch(branch, { repo: repo.repo, runner })
  const existingUrl = existing.ok && typeof existing.data?.url === 'string' ? existing.data.url.trim() : ''
  if (existingUrl.length > 0) {
    return { ok: true, existing: true, branch, url: existingUrl, lines: [`PR 已存在: ${existingUrl}`] }
  }

  const status = git.statusPorcelain(rootPath, { runner })
  if (!status.ok) return fail('E_GIT', `无法读取工作区状态: ${status.error}`)
  if (String(status.data ?? '').trim().length > 0) {
    return fail('E_DIRTY', '工作区有未提交改动，先 commit（或 stash）')
  }

  const pushed = git.push(rootPath, { remote: 'origin', branch, runner })
  if (!pushed.ok) return fail('E_PUSH', `推送 ${branch} 失败: ${pushed.error}`)

  const created = gh.prCreate({
    repo: repo.repo,
    base: PR_BASE,
    head: branch,
    title: `${title} (#${issue})`,
    body: prBody(issue),
    runner,
  })
  if (!created.ok) return fail('E_PR', `创建 PR 失败: ${created.error}`)

  const url = typeof created.data === 'string' ? created.data.trim() : ''
  return {
    ok: true,
    existing: false,
    branch,
    url,
    lines: [
      url.length > 0 ? `PR 已创建: ${url}` : 'PR 已创建',
      '等待 CI 与审核判定（APPROVE 且未命中高风险可直接合并）',
    ],
  }
}
