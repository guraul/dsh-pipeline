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

test('branchShow / headOneline / worktreeListPlain：status 仓库概览用的三条只读命令', () => {
  const branch = recorder({ status: 0, stdout: 'main\n', stderr: '' })
  assert.equal(git.branchShow(CWD, { runner: branch }).data, 'main')
  assert.deepEqual(branch.calls[0].args, ['-C', CWD, 'branch', '--show-current'])

  // detached 时 --show-current 成功但输出空串：调用方据此拼 <detached> <sha7>
  const detached = recorder({ status: 0, stdout: '', stderr: '' })
  assert.equal(git.branchShow(CWD, { runner: detached }).data, '')
  assert.equal(git.branchShow(CWD, { runner: detached }).ok, true)

  const oneline = recorder({ status: 0, stdout: 'abc1234 修一个 bug\n', stderr: '' })
  assert.equal(git.headOneline(CWD, { runner: oneline }).data, 'abc1234 修一个 bug')
  assert.deepEqual(oneline.calls[0].args, ['-C', CWD, 'log', '--oneline', '-1'])

  const list = recorder({ status: 0, stdout: '/repo (main)\n/wt (task/7)\n\n', stderr: '' })
  assert.deepEqual(git.worktreeListPlain(CWD, { runner: list }).data, ['/repo (main)', '/wt (task/7)'])
  assert.deepEqual(list.calls[0].args, ['-C', CWD, 'worktree', 'list'])
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

test('checkout：固定 argv，分支名过校验，非法入参不调用 git', () => {
  const runner = recorder({ status: 0, stdout: "Switched to branch 'main'\n", stderr: '' })
  const result = git.checkout(CWD, { branch: 'main', runner })
  assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'checkout', 'main'])
  assert.equal(result.ok, true)

  const invalid = recorder({ status: 0, stdout: '', stderr: '' })
  for (const branch of [undefined, '', '-b', '--orphan', 'a..b', 'a b']) {
    const failed = git.checkout(CWD, { branch, runner: invalid })
    assert.equal(failed.ok, false, `branch=${String(branch)}`)
    assert.equal(failed.code, 'E_INPUT')
  }
  assert.equal(invalid.calls.length, 0)
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
    'branchShow',
    'checkout',
    'commitExists',
    'configGet',
    'configSet',
    'currentBranch',
    'deleteBranch',
    'diffNameOnly',
    'diffNameStatus',
    'diffShortstat',
    'fetch',
    'gitCommonDir',
    'headOneline',
    'headSha',
    'isAncestor',
    'logOnelineRange',
    'lsFiles',
    'mergeFF',
    'push',
    'remoteUrl',
    'showStat',
    'statusPorcelain',
    'toplevel',
    'worktreeAdd',
    'worktreeList',
    'worktreeListPlain',
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

test('showStat：固定 argv，非法提交名不执行', () => {
  const SHA = 'a'.repeat(40)
  const ok = recorder({ status: 0, stdout: ' a.mjs | 2 ++\n' })
  assert.equal(git.showStat(CWD, { sha: SHA, runner: ok }).data, ' a.mjs | 2 ++')
  assert.deepEqual(ok.calls[0].args, ['-C', CWD, 'show', '--stat', SHA])

  for (const sha of [undefined, '', '--all', 'a..b']) {
    const never = recorder({ status: 0, stdout: '', stderr: '' })
    assert.equal(git.showStat(CWD, { sha, runner: never }).code, 'E_INPUT', String(sha))
    assert.equal(never.calls.length, 0)
  }
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


test('lsFiles：-z 分隔、-- 保护 pathspec、非法项不执行', () => {
  const runner = recorder({ status: 0, stdout: 'lib/a.mjs\0lib/b.mjs\0' })
  const result = git.lsFiles(CWD, { pathspec: ['lib/*.mjs'], runner })
  assert.deepEqual(result.data, ['lib/a.mjs', 'lib/b.mjs'])
  assert.deepEqual(runner.calls[0].args, ['-C', CWD, 'ls-files', '-z', '--', 'lib/*.mjs'])

  const bad = recorder()
  assert.equal(git.lsFiles(CWD, { pathspec: [], runner: bad }).code, 'E_INPUT')
  assert.equal(git.lsFiles(CWD, { pathspec: ['-x'], runner: bad }).code, 'E_INPUT')
  assert.equal(bad.calls.length, 0)
})

test('commitExists / isAncestor：固定 argv，非十六进制 sha 不执行', () => {
  const ok = recorder({ status: 0, stdout: '' })
  assert.equal(git.commitExists(CWD, { sha: 'abc1234', runner: ok }).ok, true)
  assert.deepEqual(ok.calls[0].args, ['-C', CWD, 'cat-file', '-e', 'abc1234^{commit}'])

  const ancestor = recorder({ status: 1, stdout: '', stderr: '' })
  const result = git.isAncestor(CWD, { sha: 'abc1234', runner: ancestor })
  assert.equal(result.ok, false)
  assert.equal(result.code, 1)
  assert.deepEqual(ancestor.calls[0].args, ['-C', CWD, 'merge-base', '--is-ancestor', 'abc1234', 'HEAD'])

  const bad = recorder()
  assert.equal(git.commitExists(CWD, { sha: 'not-hex', runner: bad }).code, 'E_INPUT')
  assert.equal(git.isAncestor(CWD, { sha: 'a..b', runner: bad }).code, 'E_INPUT')
  assert.equal(bad.calls.length, 0)
})

test('logOnelineRange / diffShortstat / diffNameOnly：固定 argv', () => {
  const log = recorder({ status: 0, stdout: 'abc1234 改 a\ndef5678 改 b\n' })
  const lines = git.logOnelineRange(CWD, { from: 'aaa1111', paths: ['lib/*.mjs'], runner: log })
  assert.deepEqual(lines.data, ['abc1234 改 a', 'def5678 改 b'])
  assert.deepEqual(log.calls[0].args, [
    '-C', CWD, 'log', '--oneline', 'aaa1111..HEAD', '--', 'lib/*.mjs',
  ])

  const stat = recorder({ status: 0, stdout: ' 1 file changed, 2 insertions(+)\n' })
  assert.equal(
    git.diffShortstat(CWD, { from: 'aaa1111', paths: ['lib/*.mjs'], runner: stat }).data,
    '1 file changed, 2 insertions(+)',
  )

  const staged = recorder({ status: 0, stdout: 'lib/a.mjs\n' })
  assert.deepEqual(git.diffNameOnly(CWD, { staged: true, runner: staged }).data, ['lib/a.mjs'])
  assert.deepEqual(staged.calls[0].args, ['-C', CWD, 'diff', '--name-only', '--cached'])

  const range = recorder({ status: 0, stdout: 'lib/a.mjs\n' })
  git.diffNameOnly(CWD, { range: 'main..HEAD', runner: range })
  assert.deepEqual(range.calls[0].args, ['-C', CWD, 'diff', '--name-only', 'main..HEAD'])

  const bad = recorder()
  assert.equal(git.diffNameOnly(CWD, { range: '-x..y', runner: bad }).code, 'E_INPUT')
  assert.equal(bad.calls.length, 0)
})
