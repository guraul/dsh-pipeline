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

/** 工作树列表的人读形态：`git worktree list` 原始行，一行一棵，不做解析。 */
export function worktreeListPlain(cwd, { runner } = {}) {
  return runGit({
    cwd,
    runner,
    args: ['worktree', 'list'],
    transform: (stdout) =>
      String(stdout)
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0),
  })
}

/** 当前分支名（detached 时 git 返回 HEAD，原样透出）。 */
export function currentBranch(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', '--abbrev-ref', 'HEAD'] })
}

/**
 * 当前分支名（`git branch --show-current`）：detached 时成功但输出空串，
 * 尚无提交的仓库也能取到分支名——status 的仓库概览用它判断 detached。
 */
export function branchShow(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['branch', '--show-current'] })
}

/** HEAD 一行摘要（`git log --oneline -1`）：短 sha + 提交标题。 */
export function headOneline(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['log', '--oneline', '-1'] })
}

/** 当前 HEAD 完整 sha。 */
export function headSha(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', 'HEAD'] })
}

/**
 * 某次提交的改动摘要（`git show --stat <sha>`）。
 * review prepare 的 inline 档把它贴进证据包：审核方没有工具权限，只能看内联材料。
 */
export function showStat(cwd, { sha, runner } = {}) {
  if (!checkRef(sha)) return fail('E_INPUT', `非法提交: ${String(sha)}`)
  return runGit({ cwd, runner, args: ['show', '--stat', sha] })
}

/** origin 的远端地址。 */
export function remoteUrl(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['remote', 'get-url', 'origin'] })
}

/** 当前工作树根目录（在 linked worktree 里就是该 worktree 的目录）。 */
export function toplevel(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', '--show-toplevel'] })
}

/**
 * 公共 git 目录：主工作区与所有 linked worktree 共享同一份。
 * 普通仓库里它就是 <主工作区>/.git，因此父目录即主工作区；
 * task 用它来固定 worktree 容器，避免在主工作区的 worktree 里再嵌套一层。
 */
export function gitCommonDir(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['rev-parse', '--git-common-dir'] })
}

/** 工作区状态（porcelain，一行一个改动）。空串表示干净。 */
export function statusPorcelain(cwd, { runner } = {}) {
  return runGit({ cwd, runner, args: ['status', '--porcelain'] })
}

/**
 * 切换到已有本地分支：`git checkout <branch>`。
 *
 * 分支名过 checkRef（不能以 - 开头、不能含 ..），因此不会被当成选项；
 * 不用 `--` 分隔——`git checkout -- <name>` 会变成「恢复路径」而不是切分支。
 */
export function checkout(cwd, { branch, runner } = {}) {
  if (!checkRef(branch)) return fail('E_INPUT', `非法分支名: ${String(branch)}`)
  return runGit({ cwd, runner, args: ['checkout', branch] })
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
 * 新建工作树并同时创建分支：`worktree add -b <branch> <path> <ref>`。
 * ref 显式给成 origin/main 而不是 HEAD——基线必须是远端 main，不能随本机分支漂。
 * path 用绝对路径（调用方保证），因此不会被当成选项；也不用 `--` 分隔，
 * 老版本 git 对 `worktree add ... --` 的支持不一致。
 */
export function worktreeAdd(cwd, { branch, path, ref, runner } = {}) {
  if (!checkRef(branch)) return fail('E_INPUT', `非法分支名: ${String(branch)}`)
  if (!checkCwd(path)) return fail('E_INPUT', `非法工作树路径: ${String(path)}`)
  if (!checkRef(ref)) return fail('E_INPUT', `非法基线引用: ${String(ref)}`)
  return runGit({ cwd, runner, args: ['worktree', 'add', '-b', branch, path, ref] })
}

/**
 * 推送分支。默认 -u 建立上游（与参考脚本 `push -u origin <branch>` 一致）；
 * remote 与分支各自过一个 argv 元素，不拼字符串。
 */
export function push(cwd, { remote = 'origin', branch, setUpstream = true, runner } = {}) {
  if (!checkRef(remote)) return fail('E_INPUT', `非法 remote: ${String(remote)}`)
  if (!checkRef(branch)) return fail('E_INPUT', `非法分支名: ${String(branch)}`)
  const args = ['push']
  if (setUpstream === true) args.push('-u')
  args.push(remote, branch)
  return runGit({ cwd, runner, args })
}

/** 配置键只允许分段名（user.name / user.email 这类），挡掉任意参数注入。 */
const CONFIG_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*(\.[A-Za-z0-9][A-Za-z0-9.-]*)*$/

/** 读取 git 配置项；未设置时 git 以非零退出，按失败结果返回。 */
export function configGet(cwd, key, { runner } = {}) {
  if (typeof key !== 'string' || !CONFIG_KEY_PATTERN.test(key)) {
    return fail('E_INPUT', `非法配置键: ${String(key)}`)
  }
  return runGit({ cwd, runner, args: ['config', '--get', key] })
}

/** 写入 git 配置项（作用于指定工作树/仓库，不改全局配置）。 */
export function configSet(cwd, { key, value, runner } = {}) {
  if (typeof key !== 'string' || !CONFIG_KEY_PATTERN.test(key)) {
    return fail('E_INPUT', `非法配置键: ${String(key)}`)
  }
  if (typeof value !== 'string' || value.length === 0) {
    return fail('E_INPUT', '配置值必须是非空字符串')
  }
  return runGit({ cwd, runner, args: ['config', key, value] })
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

/** 覆盖路径的 glob 子集校验：与 policy 的 globToRegExp 同一套字符集，不允许空白与 NUL。 */
const PATHSPEC_PATTERN = /^[^-\0][^\0]*$/

function checkPathspec(value) {
  return typeof value === 'string' && value.length > 0 && PATHSPEC_PATTERN.test(value)
}

/**
 * 列出与 pathspec 匹配的**已跟踪**文件（`git ls-files -z -- <pathspec…>`）。
 * 知识库的覆盖路径只能靠它展开：`fs` 递归会把 node_modules 与未跟踪文件算进去。
 * 用 `-z` 分隔，路径里有空格或换行也不会被拆错。
 */
export function lsFiles(cwd, { pathspec, runner } = {}) {
  if (!Array.isArray(pathspec) || pathspec.length === 0) {
    return fail('E_INPUT', 'pathspec 必须是非空数组')
  }
  if (!pathspec.every(checkPathspec)) {
    return fail('E_INPUT', `pathspec 含非法项: ${JSON.stringify(pathspec)}`)
  }
  return runGit({
    cwd,
    runner,
    args: ['ls-files', '-z', '--', ...pathspec],
    transform: (stdout) => String(stdout).split('\0').filter((item) => item.length > 0),
  })
}

/** 提交对象是否存在（`git cat-file -e <sha>^{commit}`）：不存在时 git 以非零退出。 */
export function commitExists(cwd, { sha, runner } = {}) {
  if (typeof sha !== 'string' || !/^[0-9a-fA-F]{4,40}$/.test(sha)) {
    return fail('E_INPUT', `非法提交: ${String(sha)}`)
  }
  return runGit({ cwd, runner, args: ['cat-file', '-e', `${sha}^{commit}`] })
}

/**
 * sha 是否为 ref 的祖先（`git merge-base --is-ancestor`）。
 * 退出 0 = 是、1 = 不是（两种都算「命令跑通了」）；其它退出码才是环境错误。
 */
export function isAncestor(cwd, { sha, ref = 'HEAD', runner } = {}) {
  if (!checkRef(sha) || sha.includes('..')) return fail('E_INPUT', `非法提交: ${String(sha)}`)
  if (!checkRef(ref) || ref.includes('..')) return fail('E_INPUT', `非法引用: ${String(ref)}`)
  return runGit({ cwd, runner, args: ['merge-base', '--is-ancestor', sha, ref] })
}

/**
 * 区间内、限定 pathspec 的提交摘要（`git log --oneline <from>..<to> -- <paths…>`）。
 * 知识库的 stale 判定用它：返回一行一个 `短sha 标题`。
 */
export function logOnelineRange(cwd, { from, to = 'HEAD', paths = [], runner } = {}) {
  if (!checkRef(from) || from.includes('..')) return fail('E_INPUT', `非法起始引用: ${String(from)}`)
  if (!checkRef(to) || to.includes('..')) return fail('E_INPUT', `非法结束引用: ${String(to)}`)
  if (!Array.isArray(paths) || !paths.every(checkPathspec)) {
    return fail('E_INPUT', `非法 pathspec: ${JSON.stringify(paths)}`)
  }
  const args = ['log', '--oneline', `${from}..${to}`]
  if (paths.length > 0) args.push('--', ...paths)
  return runGit({
    cwd,
    runner,
    args,
    transform: (stdout) => String(stdout).split(/\r?\n/).filter((line) => line.length > 0),
  })
}

/** 区间 diff 的短统计（`git diff --shortstat <from>..<to> -- <paths…>`），用于升级规则。 */
export function diffShortstat(cwd, { from, to = 'HEAD', paths = [], runner } = {}) {
  if (!checkRef(from) || from.includes('..')) return fail('E_INPUT', `非法起始引用: ${String(from)}`)
  if (!checkRef(to) || to.includes('..')) return fail('E_INPUT', `非法结束引用: ${String(to)}`)
  if (!Array.isArray(paths) || !paths.every(checkPathspec)) {
    return fail('E_INPUT', `非法 pathspec: ${JSON.stringify(paths)}`)
  }
  const args = ['diff', '--shortstat', `${from}..${to}`]
  if (paths.length > 0) args.push('--', ...paths)
  return runGit({ cwd, runner, args, transform: (stdout) => String(stdout).trim() })
}

/**
 * 变更文件清单（`git diff --name-only`）：`--staged` 取暂存区，给了 range 取区间。
 * range 只接受 `<a>..<b>` 形状，且不能以 - 开头（避免被当成选项）。
 */
export function diffNameOnly(cwd, { staged = false, range, runner } = {}) {
  const args = ['diff', '--name-only']
  if (staged === true) {
    args.push('--cached')
  } else if (range !== undefined) {
    if (typeof range !== 'string' || !/^[^\s-][^\s]*\.\.[^\s]+$/.test(range)) {
      return fail('E_INPUT', `非法区间: ${String(range)}`)
    }
    args.push(range)
  }
  return runGit({
    cwd,
    runner,
    args,
    transform: (stdout) =>
      String(stdout)
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
  })
}
