import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FF_REF, runMerge } from '../lib/merge.mjs'
import { deleteBranch as realDeleteBranch } from '../lib/git.mjs'
import { PACKAGE_VERSION, SCHEMA_VERSION, reviewsDir, writeRecord } from '../lib/record.mjs'

const PR = 7
const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const BRANCH = 'task/7'
const MAIN_WT = '/repo/main'
const TASK_WT = '/repo/.wt/task-7'
const NOW = new Date('2026-11-01T00:00:00.000Z')

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-merge-'))
}

function withRepo(root, repo = 'owner/repo') {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify({ repo }), 'utf8')
}

function recordFor(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: PACKAGE_VERSION,
    pr: PR,
    round: 1,
    verdict: 'APPROVE',
    head_sha: SHA,
    findings: [],
    evidence: ['cmd: node --test'],
    createdAt: NOW.toISOString(),
    ...overrides,
  }
}

/** 造一个带审核记录的临时仓库根。 */
function approvedRoot(overrides = {}) {
  const root = tmp()
  withRepo(root)
  const file = writeRecord(reviewsDir(root), recordFor(overrides))
  return { root, file }
}

function ok(data = '') {
  return { ok: true, code: 0, data, error: null }
}

function fail(code, error) {
  return { ok: false, code, data: null, error }
}

/** 假 gh：记录调用顺序，默认 prView 返回 OPEN 的 PR。 */
function fakeGh({ state = 'OPEN', branch = BRANCH, view, merge } = {}) {
  const calls = []
  return {
    calls,
    gh: {
      prView: (pr, options) => {
        calls.push({ op: 'prView', pr, options })
        if (typeof view === 'function') return view(pr, options)
        return ok({ headRefName: branch, state })
      },
      prMerge: (pr, options) => {
        calls.push({ op: 'prMerge', pr, options })
        return typeof merge === 'function' ? merge(pr, options) : ok('merged')
      },
    },
  }
}

/** 默认 worktree 列表：主工作区 + 持有 task/7 的 worktree。 */
const DEFAULT_WORKTREES = [
  { path: MAIN_WT, head: OTHER_SHA, branch: 'main', detached: false, bare: false },
  { path: TASK_WT, head: SHA, branch: BRANCH, detached: false, bare: false },
]

/**
 * 假 git：每个操作都先记调用再返回结果，responses 可按操作名替换返回值
 * （替换也要留下调用记录，否则「失败后有没有继续往下做」就看不出来了）。
 */
function fakeGit({ responses = {}, worktrees = DEFAULT_WORKTREES, head = SHA } = {}) {
  const calls = []
  const respond = (op, payload, fallback) => {
    calls.push({ op, ...payload })
    return typeof responses[op] === 'function' ? responses[op](payload) : fallback
  }
  return {
    calls,
    ops: () => calls.map((call) => call.op),
    git: {
      headSha: (cwd) => respond('headSha', { cwd }, ok(head)),
      worktreeList: (cwd) => respond('worktreeList', { cwd }, ok(worktrees)),
      worktreeRemove: (cwd, path) => respond('worktreeRemove', { cwd, path }, ok()),
      fetch: (cwd, options) => respond('fetch', { cwd, options }, ok()),
      mergeFF: (cwd, options) => respond('mergeFF', { cwd, options }, ok('Fast-forward')),
      deleteBranch: (cwd, name, options) =>
        respond('deleteBranch', { cwd, name, options }, ok(`Deleted branch ${name}`)),
    },
  }
}

function depsOf(gh, git, now = () => NOW) {
  return { gh: gh.gh, git: git.git, now }
}

test('入参非法：第一步就停，不碰 gh / git', () => {
  const gh = fakeGh()
  const git = fakeGit()
  const result = runMerge({ pr: 0, root: tmp(), deps: depsOf(gh, git) })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'input')
  assert.equal(result.code, 'E_INPUT')
  assert.deepEqual(result.steps.map((step) => step.name), ['input'])
  assert.equal(gh.calls.length, 0)
  assert.equal(git.calls.length, 0)
})

test('未配置 repo：停在 repo 步骤，不碰 gh / git', () => {
  const root = tmp()
  const gh = fakeGh()
  const git = fakeGit()
  const result = runMerge({ pr: PR, root, headSha: SHA, recordPath: 'x.json', deps: depsOf(gh, git) })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'repo')
  assert.match(result.error, /未配置仓库标识/)
  assert.equal(gh.calls.length, 0)
  assert.equal(git.calls.length, 0)
})

test('闸门拒绝：零合并、零清理，只记录到 gate', () => {
  const { root, file } = approvedRoot({ head_sha: OTHER_SHA })
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'gate')
  assert.match(result.error, /审核闸门: /)
  assert.match(result.error, /判定已作废/)
  assert.deepEqual(result.steps.map((step) => step.name), ['repo', 'head', 'gate'])
  assert.deepEqual(result.steps.map((step) => step.ok), [true, true, false])
  assert.equal(gh.calls.length, 0, '闸门未过时不应发出任何 gh 命令')
  assert.equal(git.calls.length, 0, '闸门未过时不应做任何 git 操作')
})

test('缺审核记录且未声明跳过：fail-closed，零合并零清理', () => {
  const root = tmp()
  withRepo(root)
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({ pr: PR, root, headSha: SHA, deps: depsOf(gh, git) })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'gate')
  assert.match(result.error, /未提供审核记录/)
  assert.match(result.error, /失败关闭/)
  assert.equal(gh.calls.length, 0)
  assert.equal(git.calls.length, 0)
})

test('--no-review：写跳过审计后继续合并与清理', () => {
  const root = tmp()
  withRepo(root)
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    noReview: true,
    reason: '紧急回滚，已人工确认',
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  const skipDir = join(reviewsDir(root), 'skips')
  assert.ok(existsSync(skipDir))
  assert.equal(readdirSync(skipDir).filter((name) => name.endsWith('.json')).length, 1)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 1)
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
})

test('合并成功：按 worktree → fetch → 快进 → 删本地分支的顺序清理', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['repo', 'head', 'gate', 'pr', 'merge', 'worktree', 'fetch', 'ff', 'branch'],
  )
  assert.ok(result.steps.every((step) => step.ok))

  assert.deepEqual(
    gh.calls.map((call) => call.op),
    ['prView', 'prMerge'],
  )
  assert.deepEqual(gh.calls[1].options, { repo: 'owner/repo', squash: true })

  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])

  const [removed, fetched, advanced, deleted] = git.calls.slice(1)
  assert.equal(removed.path, TASK_WT, '移除的是检出该分支的 worktree')
  assert.equal(removed.cwd, MAIN_WT, '从主工作区执行移除')
  assert.equal(fetched.cwd, MAIN_WT)
  assert.equal(fetched.options.remote, 'origin')
  assert.equal(advanced.cwd, MAIN_WT)
  assert.equal(advanced.options.ref, FF_REF)
  assert.equal(deleted.name, BRANCH, '删除的正是 PR 的 head 分支')
  assert.equal(deleted.cwd, MAIN_WT)
  assert.deepEqual(deleted.options, { force: true }, 'squash 合并后必须走 -D（force）')
})

test('worktree 移除失败：仍报告已完成的步骤，且不再继续清理', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    responses: {
      worktreeRemove: () =>
        fail(1, 'fatal: working trees containing submodules cannot be moved or removed'),
    },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'worktree')
  assert.equal(result.code, 1)
  assert.match(result.error, /worktree 移除失败/)
  assert.ok(result.error.includes(TASK_WT), result.error)

  assert.deepEqual(
    result.steps.map((step) => step.name),
    ['repo', 'head', 'gate', 'pr', 'merge', 'worktree'],
  )
  assert.deepEqual(
    result.steps.map((step) => step.ok),
    [true, true, true, true, true, false],
  )
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 1, '合并已成功，记录不能丢')
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove'], '失败后不再 fetch / 快进 / 删分支')
})

test('快进失败：返回 ff 错误，fetch 记为成功，不删本地分支', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    responses: { mergeFF: () => fail(128, 'fatal: Not possible to fast-forward, aborting.') },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'ff')
  assert.equal(result.code, 128)
  assert.match(result.error, /main 快进失败/)
  assert.match(result.error, /Not possible to fast-forward/)

  const byName = new Map(result.steps.map((step) => [step.name, step.ok]))
  assert.equal(byName.get('fetch'), true)
  assert.equal(byName.get('ff'), false)
  assert.equal(byName.get('branch'), undefined)
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF'])
})

test('没有 worktree 持有该分支：跳过移除步骤，其余照常', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: [{ path: MAIN_WT, head: OTHER_SHA, branch: 'main', detached: false, bare: false }],
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true)
  const step = result.steps.find((item) => item.name === 'worktree')
  assert.equal(step.ok, true)
  assert.match(step.detail, /跳过移除/)
  assert.deepEqual(git.ops(), ['worktreeList', 'fetch', 'mergeFF', 'deleteBranch'])
})

test('本地分支已不存在：按跳过处理，不算失败', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    responses: { deleteBranch: () => fail(1, "error: branch 'task/7' not found.") },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true)
  const step = result.steps.find((item) => item.name === 'branch')
  assert.equal(step.ok, true)
  assert.match(step.detail, /已不存在/)
})

test('强删仍被拒绝（不该发生）：报 E_BRANCH_UNMERGED，不谎报成功', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    responses: {
      deleteBranch: () =>
        fail(
          1,
          "error: the branch 'task/7' is not fully merged.\nhint: If you are sure you want to delete it, run 'git branch -D task/7'.",
        ),
    },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'branch')
  assert.equal(result.code, 'E_BRANCH_UNMERGED')
  assert.match(result.error, /未删除/)
  assert.deepEqual(
    git.calls.find((call) => call.op === 'deleteBranch').options,
    { force: true },
    '兜底路径本身走的也是 -D',
  )
  assert.equal(result.steps.find((step) => step.name === 'ff').ok, true, '前面的步骤记录仍在')
})

test('PR 已是 MERGED：跳过合并，仍完成清理（幂等重跑）', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh({ state: 'MERGED' })
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0)
  assert.match(result.steps.find((step) => step.name === 'merge').detail, /已是 MERGED/)
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
  assert.deepEqual(
    git.calls.find((call) => call.op === 'deleteBranch').options,
    { force: true },
    '幂等重跑同样走 -D',
  )
})

test('删分支接真实实现时，merge 发出的 argv 是 branch -D --', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const fake = fakeGit()
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    return { status: 0, stdout: `Deleted branch ${BRANCH}\n`, stderr: '' }
  }

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: {
      gh: gh.gh,
      git: {
        ...fake.git,
        deleteBranch: (cwd, name, options) => realDeleteBranch(cwd, name, { ...options, runner }),
      },
      now: () => NOW,
    },
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    command: 'git',
    args: ['-C', MAIN_WT, 'branch', '-D', '--', BRANCH],
  })
})

test('PR 已 CLOSED 且未合并：停在 pr 步骤，不清理', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh({ state: 'CLOSED' })
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'pr')
  assert.match(result.error, /CLOSED/)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0)
  assert.equal(git.calls.length, 0)
})

test('未指定 headSha 时用 git.headSha 取当前提交', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({ pr: PR, root, recordPath: file, deps: depsOf(gh, git) })

  assert.equal(result.ok, true)
  assert.equal(git.ops()[0], 'headSha')
  assert.equal(git.calls[0].cwd, root)
  assert.match(result.steps.find((step) => step.name === 'head').detail, new RegExp(SHA))
})
