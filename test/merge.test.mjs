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

test('闸门按配置 review.rounds 判轮次：rounds=2 时 round 3 的记录被拒', async () => {
  const { root, file } = approvedRoot({ round: 3 })
  withRepo(root, 'owner/repo')
  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    JSON.stringify({ repo: 'owner/repo', review: { rounds: 2 } }),
    'utf8',
  )

  const result = await runMerge(
    { pr: PR, root, recordPath: file, headSha: SHA, now: () => NOW },
    { gh: fakeGh() },
  )
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_RECORD')
  assert.match(result.error, /round 必须是 1\.\.2 的整数/)
  assert.equal(result.step, 'gate', '应停在闸门步骤')
})

function ok(data = '') {
  return { ok: true, code: 0, data, error: null }
}

function fail(code, error) {
  return { ok: false, code, data: null, error }
}

/** 假 gh：记录调用顺序，默认 prView 返回 OPEN 的 PR，prChecks 返回全部通过。 */
function fakeGh({ state = 'OPEN', branch = BRANCH, view, merge, checks } = {}) {
  const calls = []
  return {
    calls,
    gh: {
      prView: (pr, options) => {
        calls.push({ op: 'prView', pr, options })
        if (typeof view === 'function') return view(pr, options)
        return ok({ headRefName: branch, state, headRefOid: SHA })
      },
      prChecks: (pr, options) => {
        calls.push({ op: 'prChecks', pr, options })
        if (typeof checks === 'function') return checks(pr, options)
        return ok([{ name: 'test', state: 'SUCCESS', bucket: 'pass' }])
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
      currentBranch: (cwd) => respond('currentBranch', { cwd }, ok('main')),
      statusPorcelain: (cwd) => respond('statusPorcelain', { cwd }, ok('')),
      checkout: (cwd, options) => respond('checkout', { cwd, options }, ok('')),
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
    ['repo', 'head', 'gate', 'pr', 'ci', 'merge', 'worktree', 'fetch', 'ff', 'branch'],
  )
  assert.ok(result.steps.every((step) => step.ok))

  assert.deepEqual(
    gh.calls.map((call) => call.op),
    ['prView', 'prChecks', 'prMerge'],
    '定位 PR → CI → 合并，全部发生在闸门之后',
  )
  assert.deepEqual(gh.calls[2].options, { repo: 'owner/repo', squash: true })

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
    ['repo', 'head', 'gate', 'pr', 'ci', 'merge', 'worktree'],
  )
  assert.deepEqual(
    result.steps.map((step) => step.ok),
    [true, true, true, true, true, true, false],
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

// —— 主工作区保护：PR 分支在主工作区里 checkout 时不能 remove 主工作区 ——

test('分支检出在主工作区：跳过 worktree 移除，fetch / 快进 / 删分支照常', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: [
      { path: MAIN_WT, head: SHA, branch: BRANCH, detached: false, bare: false },
      { path: root, head: OTHER_SHA, branch: 'task/9', detached: false, bare: false },
    ],
  })

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
    ['repo', 'head', 'gate', 'pr', 'ci', 'merge', 'worktree', 'fetch', 'ff', 'branch'],
    'worktree 保护不能中断后续步骤',
  )
  assert.ok(result.steps.every((step) => step.ok))

  const step = result.steps.find((item) => item.name === 'worktree')
  assert.match(step.detail, /主工作区/)
  assert.match(step.detail, /跳过/)
  assert.ok(step.detail.includes(MAIN_WT), step.detail)

  assert.deepEqual(
    git.ops(),
    ['worktreeList', 'fetch', 'statusPorcelain', 'checkout', 'mergeFF', 'deleteBranch'],
    '主工作区不能被 worktree remove；先切回 main 再快进，最后删分支',
  )
  const fetched = git.calls.find((call) => call.op === 'fetch')
  const switched = git.calls.find((call) => call.op === 'checkout')
  const advanced = git.calls.find((call) => call.op === 'mergeFF')
  const deleted = git.calls.find((call) => call.op === 'deleteBranch')
  assert.equal(fetched.cwd, MAIN_WT, 'fetch 仍在主工作区执行')
  assert.deepEqual(switched.options, { branch: 'main' }, 'PR 分支被检出时必须先切回 main')
  assert.equal(advanced.cwd, MAIN_WT, 'main 快进仍在主工作区执行')
  assert.equal(advanced.options.ref, FF_REF)
  assert.match(result.steps.find((item) => item.name === 'ff').detail, /已从 task\/7 切换到 main/)
  assert.equal(deleted.name, BRANCH, '分支照常删除')
  assert.deepEqual(deleted.options, { force: true })
})

test('root 带尾斜杠时仍认得出主工作区：不误删主工作区，流程走完', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: [
      { path: root, head: SHA, branch: BRANCH, detached: false, bare: false },
      { path: TASK_WT, head: OTHER_SHA, branch: 'task/9', detached: false, bare: false },
    ],
  })

  const result = runMerge({
    pr: PR,
    root: `${root}/`,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(git.ops().includes('worktreeRemove'), false, '主工作区（哪怕路径写法不同）绝不能 remove')
  assert.match(result.steps.find((item) => item.name === 'worktree').detail, /跳过/)
  assert.deepEqual(git.ops(), [
    'worktreeList',
    'fetch',
    'statusPorcelain',
    'checkout',
    'mergeFF',
    'deleteBranch',
  ])
})

test('分支在 linked worktree：仍正常移除，且不碰主工作区', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: [
      { path: root, head: OTHER_SHA, branch: 'main', detached: false, bare: false },
      { path: TASK_WT, head: SHA, branch: BRANCH, detached: false, bare: false },
    ],
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
  const removed = git.calls.find((call) => call.op === 'worktreeRemove')
  assert.equal(removed.path, TASK_WT, '移除的是 linked worktree')
  assert.equal(removed.cwd, root, '从主工作区执行移除')
  assert.match(result.steps.find((item) => item.name === 'worktree').detail, /已移除 worktree/)
})

test('worktree 建在仓库外的 --worktrees-dir：清理仍按分支找到并移除它', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  // 清理只认 `git worktree list` 里分支对应的路径，与 worktree 建在仓内还是仓外无关
  const external = '/Users/x/workspace/dsh-pipeline-worktrees/22-worktrees-dir'
  const git = fakeGit({
    worktrees: [
      { path: root, head: OTHER_SHA, branch: 'main', detached: false, bare: false },
      { path: external, head: SHA, branch: BRANCH, detached: false, bare: false },
    ],
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  const removed = git.calls.find((call) => call.op === 'worktreeRemove')
  assert.equal(removed.path, external, '移除的是仓库外目录里的 worktree')
  assert.equal(removed.cwd, root, '仍从主工作区执行移除')
  assert.match(result.steps.find((item) => item.name === 'worktree').detail, /已移除 worktree/)
})

// —— 快进前确认主工作区分支：PR 分支被 checkout 在主工作区时不能直接 merge --ff-only ——

/** 主工作区停在 PR 分支、另有一个无关 worktree：模拟上一个 PR 收尾留下的现场。 */
const ON_PR_BRANCH = [
  { path: MAIN_WT, head: SHA, branch: BRANCH, detached: false, bare: false },
  { path: '/repo/.wt/task-9', head: OTHER_SHA, branch: 'task/9', detached: false, bare: false },
]

test('主工作区已在 main：不读 status、不 checkout，直接快进', () => {
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
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
  assert.equal(git.ops().includes('checkout'), false)
  assert.equal(git.ops().includes('statusPorcelain'), false)
  const ff = result.steps.find((step) => step.name === 'ff')
  assert.equal(ff.skipped, undefined)
  assert.match(ff.detail, /main 已快进到 origin\/main/)
})

test('主工作区在 PR 分支且干净：先 checkout main 再快进，分支照常删除', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({ worktrees: ON_PR_BRANCH })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.deepEqual(git.ops(), [
    'worktreeList',
    'fetch',
    'statusPorcelain',
    'checkout',
    'mergeFF',
    'deleteBranch',
  ])
  const checkout = git.calls.find((call) => call.op === 'checkout')
  assert.equal(checkout.cwd, MAIN_WT)
  assert.deepEqual(checkout.options, { branch: 'main' })
  const advanced = git.calls.find((call) => call.op === 'mergeFF')
  assert.equal(advanced.cwd, MAIN_WT)
  assert.deepEqual(advanced.options, { ref: FF_REF })

  const ff = result.steps.find((step) => step.name === 'ff')
  assert.equal(ff.ok, true)
  assert.equal(ff.skipped, undefined)
  assert.match(ff.detail, new RegExp(`已从 ${BRANCH} 切换到 main`))
  assert.match(ff.detail, /main 已快进到 origin\/main/)
  assert.equal(result.steps.find((step) => step.name === 'branch').ok, true)
})

test('主工作区在 PR 分支且有未提交改动：不动现场、跳过快进并提示，仍尝试删分支', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: ON_PR_BRANCH,
    responses: { statusPorcelain: () => ok(' M lib/merge.mjs\n?? scratch.txt') },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.deepEqual(git.ops(), ['worktreeList', 'fetch', 'statusPorcelain', 'deleteBranch'])
  assert.equal(git.ops().includes('checkout'), false, '绝不能改动用户现场')
  assert.equal(git.ops().includes('mergeFF'), false, '快进必须跳过')

  const ff = result.steps.find((step) => step.name === 'ff')
  assert.equal(ff.ok, true)
  assert.equal(ff.skipped, true, '跳过快进必须能被看出来')
  assert.ok(ff.detail.includes(`主工作区停留在 ${BRANCH}`), ff.detail)
  assert.match(ff.detail, /请手动切换后重试/)
  assert.match(ff.detail, /未改动现场/)

  assert.match(result.steps.find((step) => step.name === 'branch').detail, /已删除本地分支/)
})

test('分支仍被检出任凭删除被拒：跳过删除并说明，不判失败', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: ON_PR_BRANCH,
    responses: {
      statusPorcelain: () => ok(' M lib/merge.mjs'),
      deleteBranch: () =>
        fail(1, `error: Cannot delete branch '${BRANCH}' checked out at '${MAIN_WT}'`),
    },
  })

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(result.step, undefined, '不应停在 branch 步骤')
  assert.equal(result.steps.find((step) => step.name === 'ff').skipped, true)

  const branch = result.steps.find((step) => step.name === 'branch')
  assert.equal(branch.ok, true)
  assert.match(branch.detail, /仍被工作区检出/)
  assert.match(branch.detail, /跳过删除/)
  assert.ok(branch.detail.includes(`git -C ${MAIN_WT} branch -D -- ${BRANCH}`), branch.detail)
})

test('主工作区在 PR 分支且干净、但 checkout 失败：停在 ff 并给出可执行命令', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit({
    worktrees: ON_PR_BRANCH,
    responses: { checkout: () => fail(1, "fatal: 'main' is already checked out at '/repo/other'") },
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
  assert.match(result.error, /主工作区停留在 task\/7/)
  assert.match(result.error, /切换 main 失败/)
  assert.ok(result.error.includes(`git -C ${MAIN_WT} checkout main`), result.error)
  assert.equal(git.ops().includes('mergeFF'), false, 'checkout 失败不得继续快进')
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

test('未指定 headSha 时取 PR 的 head（不是本机 HEAD）', () => {
  const { root, file } = approvedRoot()
  const fake = fakeGh()
  const git = fakeGit()

  const result = runMerge({ pr: PR, root, recordPath: file, deps: depsOf(fake, git) })

  assert.equal(result.ok, true, JSON.stringify(result.steps))
  // head 必须来自 PR，而不是本机 HEAD：合并通常从主工作区发起，本地 HEAD 是 main
  assert.equal(fake.calls.some((c) => c.op === 'prView'), true, '应向 gh 要 PR head')
  assert.equal(git.ops().includes('headSha'), false, '不应拿本机 HEAD 当 PR head')
  assert.match(result.steps.find((step) => step.name === 'head').detail, new RegExp(SHA))
})

// —— 三个开关：--check-only / --checks-file / --force ——

/** 造一份 checks 文件：内容形如 {"state":"success"}。 */
function checksFileWith(state) {
  const file = join(tmp(), 'checks.json')
  writeFileSync(file, JSON.stringify({ state }), 'utf8')
  return file
}

test('--check-only：只校验，不调用 prMerge、不做任何 git 操作', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    checkOnly: true,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(result.checkOnly, true)
  assert.deepEqual(result.steps.map((step) => step.name), ['repo', 'head', 'gate', 'pr', 'ci'])
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0, '演练模式绝不合并')
  assert.deepEqual(gh.calls.map((call) => call.op), ['prView', 'prChecks'], '只读：定位 PR 与读 CI')
  assert.deepEqual(git.ops(), [], '不清理现场')
})

test('--checks-file: state=success 放行，且不调用 gh pr checks', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    checksFile: checksFileWith('success'),
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(gh.calls.filter((call) => call.op === 'prChecks').length, 0, '有 checks-file 时不该调 gh')
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 1)
  const ci = result.steps.find((step) => step.name === 'ci')
  assert.equal(ci.ok, true)
  assert.equal(ci.skipped, undefined, '通过不等于跳过')
  assert.match(ci.detail, /通过/)
  assert.match(ci.detail, /checks-file/)
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
})

test('--checks-file: state=failure 拒绝，停在 ci，零合并零清理', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    checksFile: checksFileWith('failure'),
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'ci')
  assert.equal(result.code, 'E_CI')
  assert.match(result.error, /failure/)
  assert.deepEqual(result.steps.map((step) => step.name), ['repo', 'head', 'gate', 'pr', 'ci'])
  assert.equal(result.steps.at(-1).ok, false)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0, 'CI 未过不许合并')
  assert.equal(git.calls.length, 0, 'CI 未过不许清理')
})

test('state=failure + --force：继续合并，ci 步骤标注为跳过（不是通过）', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    checksFile: checksFileWith('failure'),
    force: true,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, true, JSON.stringify(result.steps, null, 2))
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 1)
  const ci = result.steps.find((step) => step.name === 'ci')
  assert.equal(ci.ok, true)
  assert.equal(ci.skipped, true, 'force 时 CI 是「跳过」，必须能被看出来')
  assert.match(ci.detail, /--force/)
  assert.match(ci.detail, /跳过/)
  assert.equal(gh.calls.filter((call) => call.op === 'prChecks').length, 0, 'force 时连 gh 都不发')
  assert.deepEqual(git.ops(), ['worktreeList', 'worktreeRemove', 'fetch', 'mergeFF', 'deleteBranch'])
})

test('--force 不能绕过闸门：REJECT 记录 + force 仍停在 gate，零 gh / 零 git', () => {
  const { root, file } = approvedRoot({ verdict: 'REJECT' })
  const gh = fakeGh()
  const git = fakeGit()

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    force: true,
    checksFile: checksFileWith('success'),
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'gate')
  assert.equal(result.code, 'E_VERDICT')
  assert.match(result.error, /REJECT/)
  assert.deepEqual(result.steps.map((step) => step.name), ['repo', 'head', 'gate'])
  assert.equal(gh.calls.length, 0, 'force 只作用于 CI，闸门未过时一个 gh 命令都不发')
  assert.equal(git.calls.length, 0)
})

test('gh pr checks 有 pending：拒绝合并（E_CI），零清理', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh({
    checks: () => ok([{ name: 'build', state: 'IN_PROGRESS', bucket: 'pending' }]),
  })
  const git = fakeGit()

  const result = runMerge({ pr: PR, root, recordPath: file, headSha: SHA, deps: depsOf(gh, git) })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'ci')
  assert.equal(result.code, 'E_CI')
  assert.match(result.error, /build/)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0)
  assert.equal(git.calls.length, 0)
})

test('--checks-file 内容不是合法 JSON：按 E_CI 拒绝，不静默放行', () => {
  const { root, file } = approvedRoot()
  const gh = fakeGh()
  const git = fakeGit()
  const bad = join(tmp(), 'checks.json')
  writeFileSync(bad, 'not json', 'utf8')

  const result = runMerge({
    pr: PR,
    root,
    recordPath: file,
    headSha: SHA,
    checksFile: bad,
    deps: depsOf(gh, git),
  })

  assert.equal(result.ok, false)
  assert.equal(result.step, 'ci')
  assert.equal(result.code, 'E_CI')
  assert.match(result.error, /不是合法 JSON/)
  assert.equal(gh.calls.filter((call) => call.op === 'prMerge').length, 0)
})
