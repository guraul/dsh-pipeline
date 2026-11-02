import test from 'node:test'
import assert from 'node:assert/strict'
import * as git from '../lib/git.mjs'

const CWD = '/repo/checkout'

/** 假 runner：记录 git 实际收到的 argv，按预设返回结果。 */
function recorder(response = { status: 0, stdout: '', stderr: '' }) {
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return typeof response === 'function' ? response(command, args) : response
  }
  runner.calls = calls
  return runner
}

test('worktreeList：命令固定，并且把 porcelain 解析成结构', () => {
  const stdout = [
    'worktree /repo/checkout',
    'HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'branch refs/heads/main',
    '',
    'worktree /repo/wt-feature',
    'HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    'detached',
    '',
  ].join('\n')
  const runner = recorder({ status: 0, stdout, stderr: '' })
  const result = git.worktreeList(CWD, { runner })

  assert.deepEqual(runner.calls[0], {
    command: 'git',
    args: ['-C', CWD, 'worktree', 'list', '--porcelain'],
    options: {},
  })
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, [
    {
      path: '/repo/checkout',
      head: 'a'.repeat(40),
      branch: 'main',
      detached: false,
      bare: false,
    },
    {
      path: '/repo/wt-feature',
      head: 'b'.repeat(40),
      branch: null,
      detached: true,
      bare: false,
    },
  ])
})

test('currentBranch / headSha / remoteUrl：各自对应一条只读命令', () => {
  const branch = recorder({ status: 0, stdout: 'feat/x\n', stderr: '' })
  const branchResult = git.currentBranch(CWD, { runner: branch })
  assert.deepEqual(branch.calls[0].args, ['-C', CWD, 'rev-parse', '--abbrev-ref', 'HEAD'])
  assert.equal(branchResult.data, 'feat/x')

  const head = recorder({ status: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' })
  const headResult = git.headSha(CWD, { runner: head })
  assert.deepEqual(head.calls[0].args, ['-C', CWD, 'rev-parse', 'HEAD'])
  assert.equal(headResult.data, 'c'.repeat(40))

  const remote = recorder({ status: 0, stdout: 'git@github.com:guraul/dsh-pipeline.git\n', stderr: '' })
  const remoteResult = git.remoteUrl(CWD, { runner: remote })
  assert.deepEqual(remote.calls[0].args, ['-C', CWD, 'remote', 'get-url', 'origin'])
  assert.equal(remoteResult.data, 'git@github.com:guraul/dsh-pipeline.git')
})

test('fetch：默认 origin，带 --prune，remote 可覆盖', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  git.fetch(CWD, { runner })
  assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'fetch', '--prune', 'origin'])

  const upstream = recorder({ status: 0, stdout: '', stderr: '' })
  git.fetch(CWD, { remote: 'upstream', runner: upstream })
  assert.deepEqual(upstream.calls[0].args, ['-C', CWD, 'fetch', '--prune', 'upstream'])
})

test('mergeFF：只能 --ff-only，绝不产生 merge commit', () => {
  const runner = recorder({ status: 0, stdout: 'Fast-forward\n', stderr: '' })
  const result = git.mergeFF(CWD, { ref: 'origin/main', runner })

  assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'merge', '--ff-only', 'origin/main'])
  for (const forbidden of ['--no-ff', '--squash', '-m', '--strategy']) {
    assert.ok(!runner.calls[0].args.includes(forbidden), `不应出现 ${forbidden}`)
  }
  assert.equal(result.ok, true)
})

test('mergeFF：ref 缺失或以 - 开头时拒绝，不调用 git', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  for (const ref of [undefined, '', '-x', '--abort', 'a..b', 'a b']) {
    const result = git.mergeFF(CWD, { ref, runner })
    assert.equal(result.ok, false, `ref=${String(ref)}`)
    assert.equal(result.code, 'E_INPUT')
  }
  assert.equal(runner.calls.length, 0)
})

test('worktreeRemove / deleteBranch：路径与分支名以 -- 隔离', () => {
  const remove = recorder({ status: 0, stdout: '', stderr: '' })
  git.worktreeRemove(CWD, '/repo/wt-feature', { runner: remove })
  assert.deepEqual(remove.calls[0].args, [
    '-C',
    CWD,
    'worktree',
    'remove',
    '--',
    '/repo/wt-feature',
  ])

  const branch = recorder({ status: 0, stdout: 'Deleted branch feat/x\n', stderr: '' })
  git.deleteBranch(CWD, 'feat/x', { runner: branch })
  assert.deepEqual(branch.calls[0].args, ['-C', CWD, 'branch', '-d', '--', 'feat/x'])
  assert.ok(!branch.calls[0].args.includes('-D'), '未合并的分支不应被强删')
})

test('deleteBranch：缺省仍是 -d，只有显式 force:true 才用 -D', () => {
  const plain = recorder({ status: 0, stdout: '', stderr: '' })
  git.deleteBranch(CWD, 'feat/x', { runner: plain })
  assert.deepEqual(plain.calls[0].args, ['-C', CWD, 'branch', '-d', '--', 'feat/x'])

  // 显式传 force 的假值也不应升级成强删
  for (const force of [false, 0, 'yes', undefined, null]) {
    const runner = recorder({ status: 0, stdout: '', stderr: '' })
    git.deleteBranch(CWD, 'feat/x', { force, runner })
    assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'branch', '-d', '--', 'feat/x'], `force=${String(force)}`)
  }

  const forced = recorder({ status: 0, stdout: 'Deleted branch feat/x\n', stderr: '' })
  const result = git.deleteBranch(CWD, 'feat/x', { force: true, runner: forced })
  assert.deepEqual(forced.calls[0].args, ['-C', CWD, 'branch', '-D', '--', 'feat/x'])
  assert.equal(result.ok, true)
})

test('deleteBranch：分支名校验不因 force 放宽', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  for (const name of [undefined, '', '-x', '--force', 'a..b', 'a b']) {
    const result = git.deleteBranch(CWD, name, { force: true, runner })
    assert.equal(result.ok, false, `name=${String(name)}`)
    assert.equal(result.code, 'E_INPUT')
  }
  assert.equal(runner.calls.length, 0)
})

test('失败时返回 code 与 stderr 末两行，不抛异常', () => {
  const runner = recorder({
    status: 128,
    stdout: '',
    stderr: 'hint: 一些提示\nfatal: Not possible to fast-forward, aborting.\n',
  })
  const result = git.mergeFF(CWD, { ref: 'origin/main', runner })

  assert.deepEqual(result, {
    ok: false,
    code: 128,
    data: null,
    error: 'hint: 一些提示\nfatal: Not possible to fast-forward, aborting.',
  })
})

test('runner 抛错或返回异常结构也不抛', () => {
  const throwing = () => {
    throw new Error('spawn git ENOENT')
  }
  const thrown = git.headSha(CWD, { runner: throwing })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /ENOENT/)

  const weird = () => undefined
  const shaped = git.headSha(CWD, { runner: weird })
  assert.equal(shaped.ok, false)
  assert.match(shaped.error, /runner/)
})

test('cwd 非法时拒绝，不调用 git', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  for (const cwd of [undefined, '', '   ', 42, '/repo/\0bad']) {
    assert.equal(git.currentBranch(cwd, { runner }).code, 'E_INPUT', `cwd=${String(cwd)}`)
  }
  assert.equal(runner.calls.length, 0)
})

test('导出面固定：只有具名操作，没有接受 argv 的通用入口', () => {
  const callables = Object.entries(git).filter(([, value]) => typeof value === 'function')
  assert.deepEqual(callables.map(([name]) => name).sort(), [
    'configGet',
    'configSet',
    'currentBranch',
    'deleteBranch',
    'fetch',
    'gitCommonDir',
    'headSha',
    'mergeFF',
    'push',
    'remoteUrl',
    'statusPorcelain',
    'toplevel',
    'worktreeAdd',
    'worktreeList',
    'worktreeRemove',
  ])

  for (const [name, fn] of callables) {
    assert.ok(fn.length <= 2, `${name} 最多接受两个参数`)
    assert.ok(!/exec|spawn|run|argv/i.test(name), `${name} 不应是通用执行入口`)
  }

  // 额外位置参数（数组形式的 argv）不会被采纳。
  const runner = recorder({ status: 0, stdout: 'main\n', stderr: '' })
  git.currentBranch(CWD, { runner }, ['push', '--force'])
  assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'rev-parse', '--abbrev-ref', 'HEAD'])
})

test('toplevel / gitCommonDir / statusPorcelain / worktreeAdd / push：各自一条固定 argv', () => {
  const top = recorder({ status: 0, stdout: '/repo\n', stderr: '' })
  assert.equal(git.toplevel(CWD, { runner: top }).data, '/repo')
  assert.deepEqual(top.calls[0].args, ['-C', CWD, 'rev-parse', '--show-toplevel'])

  const common = recorder({ status: 0, stdout: '/repo/.git\n', stderr: '' })
  assert.equal(git.gitCommonDir(CWD, { runner: common }).data, '/repo/.git')
  assert.deepEqual(common.calls[0].args, ['-C', CWD, 'rev-parse', '--git-common-dir'])

  const status = recorder({ status: 0, stdout: '', stderr: '' })
  git.statusPorcelain(CWD, { runner: status })
  assert.deepEqual(status.calls[0].args, ['-C', CWD, 'status', '--porcelain'])

  const added = recorder({ status: 0, stdout: '', stderr: '' })
  git.worktreeAdd(CWD, { branch: 'task/12-x', path: '/repo/.worktrees/12-x', ref: 'origin/main', runner: added })
  assert.deepEqual(added.calls[0].args, [
    '-C',
    CWD,
    'worktree',
    'add',
    '-b',
    'task/12-x',
    '/repo/.worktrees/12-x',
    'origin/main',
  ])

  const pushed = recorder({ status: 0, stdout: '', stderr: '' })
  git.push(CWD, { branch: 'task/12-x', runner: pushed })
  assert.deepEqual(pushed.calls[0].args, ['-C', CWD, 'push', '-u', 'origin', 'task/12-x'])

  const plain = recorder({ status: 0, stdout: '', stderr: '' })
  git.push(CWD, { branch: 'task/12-x', setUpstream: false, runner: plain })
  assert.deepEqual(plain.calls[0].args, ['-C', CWD, 'push', 'origin', 'task/12-x'])
})

test('worktreeAdd / push / configGet / configSet：非法入参不调用 git', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  assert.equal(git.worktreeAdd(CWD, { branch: '-b', path: '/repo/wt', ref: 'origin/main', runner }).code, 'E_INPUT')
  assert.equal(git.worktreeAdd(CWD, { branch: 'task/1-x', path: '', ref: 'origin/main', runner }).code, 'E_INPUT')
  assert.equal(git.worktreeAdd(CWD, { branch: 'task/1-x', path: '/repo/wt', ref: '', runner }).code, 'E_INPUT')
  assert.equal(git.push(CWD, { branch: '--force', runner }).code, 'E_INPUT')
  assert.equal(git.configGet(CWD, 'user.name; rm -rf /', { runner }).code, 'E_INPUT')
  assert.equal(git.configSet(CWD, { key: 'user.name', value: '', runner }).code, 'E_INPUT')
  assert.equal(runner.calls.length, 0)

  const set = recorder({ status: 0, stdout: '', stderr: '' })
  git.configSet(CWD, { key: 'user.name', value: 'gubin', runner: set })
  assert.deepEqual(set.calls[0].args, ['-C', CWD, 'config', 'user.name', 'gubin'])
})
