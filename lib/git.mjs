/**
 * git 执行封装：交付流程需要的那几个仓库动作，全部走固定 argv。
 *
 * 与 gh.mjs 同一套约定：
 * 1. 只暴露具名操作，调用方无法传入任意 git 子命令；
 * 2. 一律返回 { ok, code, data, error }，不抛异常；
 * 3. runner 可注入，单测用假 runner 断言实际发出的命令，不碰真实仓库。
 *
 * 目录用 `git -C <cwd>` 传递而不是 spawn 的 cwd 选项：命令本身就能自解释，
 * 测试断言时也不必额外看 options。
 */
import { spawnSync } from 'node:child_process'

/** 引用名/路径校验：不允许以 - 开头（挡掉被当成选项），不允许空白与 .. */
const REF_PATTERN = /^[^\s-][^\s]*$/

function fail(code, error) {
  return { ok: false, code, data: null, error }
}

/** 默认 runner：真实调用 git，参数为数组，不经 shell。 */
function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

function tailLines(text, count = 2) {
  if (typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.slice(-count).join('\n')
}

function resolveRunner(runner) {
  return typeof runner === 'function' ? runner : defaultRunner
}

function checkCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim().length > 0 && !cwd.includes('\0')
}

function checkRef(value) {
  if (typeof value !== 'string' || value.length === 0) return false
  if (!REF_PATTERN.test(value)) return false
  return !value.includes('..')
}

/**
 * 执行 git 并归一结果。
 * transform 在成功时把 stdout 转成结构化 data；不给则返回 trimmed stdout。
 */
function runGit({ cwd, args, runner, transform }) {
  if (!checkCwd(cwd)) return fail('E_INPUT', `非法工作目录: ${String(cwd)}`)

  const fullArgs = ['-C', cwd, ...args]
  let result
  try {
    result = resolveRunner(runner)('git', fullArgs, {})
  } catch (error) {
    return fail(null, `git 执行失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (result === null || typeof result !== 'object') {
    return fail(null, 'runner 未返回结果')
  }

  const code = typeof result.status === 'number' ? result.status : null
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''

  if (result.error instanceof Error) {
    return fail(code, `git 执行失败: ${result.error.message}`)
  }
  if (code !== 0) {
    const detail = tailLines(stderr)
    return fail(code, detail.length > 0 ? detail : `git 退出码 ${String(code)}，无 stderr 输出`)
  }

  if (typeof transform === 'function') {
    try {
      return { ok: true, code, data: transform(stdout), error: null }
    } catch (error) {
      return fail(code, `git 输出无法解析: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return { ok: true, code, data: stdout.replace(/\r?\n$/, ''), error: null }
}

/**
 * 解析 `git worktree list --porcelain`：空行分隔的块，
 * 每块含 worktree 路径、HEAD，以及 branch / detached / bare 之一。
 */
function parseWorktrees(stdout) {
  const entries = []
  let current = null

  for (const raw of String(stdout).split(/\r?\n/)) {
    if (raw.trim().length === 0) {
      if (current) entries.push(current)
      current = null
      continue
    }
    const space = raw.indexOf(' ')
    const key = space === -1 ? raw : raw.slice(0, space)
    const value = space === -1 ? '' : raw.slice(space + 1)

    if (key === 'worktree') {
      if (current) entries.push(current)
      current = { path: value, head: null, branch: null, detached: false, bare: false }
      continue
    }
    if (!current) continue
    if (key === 'HEAD') current.head = value
    else if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') current.detached = true
    else if (key === 'bare') current.bare = true
  }
  if (current) entries.push(current)

  return entries
}

/** 列出工作树（路径、HEAD、分支）。 */
export function worktreeList(cwd, { runner } = {}) {
  return runGit({
    cwd,
    runner,
    args: ['worktree', 'list', '--porcelain'],
    transform: parseWorktrees,
  })
}

/** 当前分支名（detached 时 git 返回 HEAD，原样透出）。 */
export function currentBranch(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', '--abbrev-ref', 'HEAD'] })
}

/** 当前 HEAD 完整 sha。 */
export function headSha(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', 'HEAD'] })
}

/** origin 的远端地址。 */
export function remoteUrl(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['remote', 'get-url', 'origin'] })
}

/** 拉取远端（带 --prune，删掉已消失的远端分支引用）。 */
export function fetch(cwd, { remote = 'origin', runner } = {}) {
  if (!checkRef(remote)) return fail('E_INPUT', `非法 remote: ${String(remote)}`)
  return runGit({ cwd, runner, args: ['fetch', '--prune', remote] })
}

/** 只做快进合并：不能快进就失败，绝不产生 merge commit。 */
export function mergeFF(cwd, { ref, runner } = {}) {
  if (!checkRef(ref)) return fail('E_INPUT', `非法 ref: ${String(ref)}`)
  return runGit({ cwd, runner, args: ['merge', '--ff-only', ref] })
}

/**
 * 移除工作树。path 以 -- 结尾隔离，避免路径被当成选项；
 * 不加 --force——有未提交改动时应当失败，而不是悄悄丢弃。
 */
export function worktreeRemove(cwd, path, { runner } = {}) {
  if (!checkCwd(path)) return fail('E_INPUT', `非法工作树路径: ${String(path)}`)
  return runGit({ cwd, runner, args: ['worktree', 'remove', '--', path] })
}

/**
 * 删除本地分支。缺省用 -d：未合并的分支不删。
 *
 * force: true 时改用 -D。squash 合并后原提交不是 main 的祖先，-d 必然以
 * "not fully merged" 拒绝，这种调用方只能显式声明强删，而不是让默认行为悄悄变强。
 */
export function deleteBranch(cwd, name, { force = false, runner } = {}) {
  if (!checkRef(name)) return fail('E_INPUT', `非法分支名: ${String(name)}`)
  const flag = force === true ? '-D' : '-d'
  return runGit({ cwd, runner, args: ['branch', flag, '--', name] })
}
