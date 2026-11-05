import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'

import { runCli } from '../bin/cli.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-task-'))
}

function makeIO() {
  const state = { out: '', err: '' }
  return {
    state,
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
  }
}

function withRepo(root, repo = 'owner/repo', extra = {}) {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify({ repo, ...extra }), 'utf8')
}

/** 去掉 `-C <cwd>` 前缀，返回真正的 git 子命令与参数。 */
function sub(args) {
  return args[0] === '-C' ? args.slice(2) : args
}

function worktreePorcelain(entries) {
  return entries
    .map((entry) => `worktree ${entry.path}\nHEAD ${'a'.repeat(40)}\nbranch refs/heads/${entry.branch}\n`)
    .join('\n')
}

/**
 * 假 runner：按 git 子命令 / gh 子命令分派，记录全部 argv。
 * fetch 与 worktree add 的返回值可覆盖，用来演练重试与失败路径。
 */
function makeRunner({ title = 'Add login', worktrees = [], fetch = () => ({ status: 0, stdout: '', stderr: '' }), add, identity } = {}) {
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    const rest = sub(args)
    if (command === 'gh') {
      if (rest[0] === 'issue' && rest[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 1, title }), stderr: '' }
      }
      return { status: 1, stdout: '', stderr: 'unexpected gh' }
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return { status: 0, stdout: worktreePorcelain(worktrees), stderr: '' }
    }
    if (rest[0] === 'fetch') return fetch()
    if (rest[0] === 'worktree' && rest[1] === 'add') {
      return add ? add() : { status: 0, stdout: '', stderr: '' }
    }
    if (rest[0] === 'config' && rest[1] === '--get') {
      return identity
        ? { status: 0, stdout: `${identity}\n`, stderr: '' }
        : { status: 1, stdout: '', stderr: 'unset' }
    }
    if (rest[0] === 'config') return { status: 0, stdout: '', stderr: '' }
    return { status: 1, stdout: '', stderr: `unexpected git: ${rest.join(' ')}` }
  }
  return { runner, calls }
}

function run(argv, io, runner, extra = {}) {
  return runCli(argv, { stdout: io.stdout, stderr: io.stderr, runner, sleep: () => {}, ...extra })
}

test('task: 正常创建分支与 worktree，基线为 origin/main', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 0)

  const worktree = join(root, '.worktrees', '12-add-login')
  assert.match(io.state.out, /task: issue #12: Add login\n/)
  assert.match(io.state.out, /分支: {5}task\/12-add-login/)
  assert.ok(io.state.out.includes(worktree))
  assert.equal(io.state.err, '')

  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.deepEqual(add.args, ['-C', root, 'worktree', 'add', '-b', 'task/12-add-login', worktree, 'origin/main'])

  const fetches = calls.filter((call) => sub(call.args)[0] === 'fetch')
  assert.deepEqual(fetches[0].args, ['-C', root, 'fetch', '--prune', 'origin'])
  assert.equal(fetches.length, 1)
})

test('task: 中文标题兜底为标题 sha1 前 8 位（不是固定的 task）', () => {
  const root = tmp()
  withRepo(root)
  const title = '修复登录'
  const expected = createHash('sha1').update(title, 'utf8').digest('hex').slice(0, 8)
  const { runner, calls } = makeRunner({ title })
  const io = makeIO()

  assert.equal(run(['task', '7', '--root', root], io, runner), 0)

  assert.ok(io.state.out.includes(`task/7-${expected}`))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[3], `task/7-${expected}`)
})

test('task: worktree 已存在时幂等退出 0，不再 fetch 也不重复创建', () => {
  const root = tmp()
  withRepo(root)
  const worktree = join(root, '.worktrees', '12-add-login')
  const { runner, calls } = makeRunner({ worktrees: [{ path: worktree, branch: 'task/12-add-login' }] })
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 0)

  assert.match(io.state.out, /worktree 已存在/)
  assert.ok(io.state.out.includes(worktree))
  assert.equal(calls.some((call) => sub(call.args)[0] === 'fetch'), false)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add'), false)
})

test('task: 目标路径存在但不是本仓 worktree 时退出 2', () => {
  const root = tmp()
  withRepo(root)
  const worktree = join(root, '.worktrees', '12-add-login')
  mkdirSync(worktree, { recursive: true })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 2)

  assert.match(io.state.err, /路径已存在但不是本仓库的 worktree/)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'fetch'), false)
})

test('task: fetch 连续失败重试 3 次后退出 2', () => {
  const root = tmp()
  withRepo(root)
  let sleeps = 0
  const { runner, calls } = makeRunner({
    fetch: () => ({ status: 128, stdout: '', stderr: 'Could not resolve host: github.com' }),
  })
  const io = makeIO()

  const code = runCli(['task', '12', '--root', root], {
    stdout: io.stdout,
    stderr: io.stderr,
    runner,
    sleep: () => {
      sleeps += 1
    },
  })

  assert.equal(code, 2)
  assert.match(io.state.err, /origin fetch 3 次均失败/)
  assert.equal(calls.filter((call) => sub(call.args)[0] === 'fetch').length, 3)
  assert.equal(sleeps, 2)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add'), false)
})

test('task: 缺省 root 取主工作区（--git-common-dir 的父目录），仓库标识可从 origin 反推', () => {
  const root = tmp()
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    const rest = sub(args)
    if (command === 'gh') {
      return { status: 0, stdout: JSON.stringify({ number: 3, title: 'Fix typo' }), stderr: '' }
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--git-common-dir') {
      return { status: 0, stdout: '.git\n', stderr: '' }
    }
    if (rest[0] === 'remote') {
      return { status: 0, stdout: 'git@github.com:guraul/dsh-pipeline.git\n', stderr: '' }
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') return { status: 0, stdout: '', stderr: '' }
    if (rest[0] === 'fetch') return { status: 0, stdout: '', stderr: '' }
    if (rest[0] === 'worktree' && rest[1] === 'add') return { status: 0, stdout: '', stderr: '' }
    return { status: 1, stdout: '', stderr: 'unset' }
  }
  const io = makeIO()

  assert.equal(run(['task', '3'], io, runner, { cwd: root }), 0)

  const issue = calls.find((call) => call.command === 'gh' && sub(call.args)[0] === 'issue')
  assert.deepEqual(issue.args.slice(0, 5), ['issue', 'view', '3', '--repo', 'guraul/dsh-pipeline'])
  assert.ok(io.state.out.includes(join(root, '.worktrees', '3-fix-typo')))
})

test('task: 参数错误一律退出 2', () => {
  const { runner } = makeRunner()
  for (const argv of [['task'], ['task', 'abc'], ['task', '0'], ['task', '12', '--nope', 'x'], ['task', '12', '--root']]) {
    const io = makeIO()
    assert.equal(run(argv, io, runner), 2, `argv: ${argv.join(' ')}`)
    assert.match(io.state.err, /task:/)
  }
})

test('task: --slug 覆盖分支与目录后缀（中文标题也能得到可读 slug）', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--slug', 'Pipeline-Migrate', '--root', root], io, runner), 0)
  const worktree = join(root, '.worktrees', '12-pipeline-migrate')
  assert.match(io.state.out, /分支: {5}task\/12-pipeline-migrate/)
  assert.ok(io.state.out.includes(worktree))
  assert.ok(
    calls.some((c) => c.command === 'git' && c.args.includes('worktree') && c.args.some((a) => a.includes('12-pipeline-migrate'))),
  )
})

test('task: --slug 非法时退出 2，不创建任何东西', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--slug', '!!!', '--root', root], io, runner), 2)
  assert.match(io.state.err, /--slug 不合法/)
  assert.equal(calls.some((c) => c.command === 'git' && c.args.includes('worktree')), false)
})

test('task: --worktrees-dir 绝对路径时 worktree 建在该目录下，容器目录自动创建', () => {
  const root = tmp()
  withRepo(root)
  const container = join(tmp(), 'outer', 'wt')
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root, '--worktrees-dir', container], io, runner), 0)

  const worktree = join(container, '12-add-login')
  assert.ok(io.state.out.includes(worktree))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.deepEqual(add.args, ['-C', root, 'worktree', 'add', '-b', 'task/12-add-login', worktree, 'origin/main'])
  assert.ok(existsSync(container), '不存在的容器目录应按 mkdir -p 语义创建')
  assert.equal(existsSync(join(root, '.worktrees')), false, '缺省目录不应被顺手创建')
})

test('task: --worktrees-dir 相对路径按 --root 解析成绝对路径', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root, '--worktrees-dir', 'ext-wt'], io, runner), 0)

  const worktree = join(root, 'ext-wt', '12-add-login')
  assert.ok(isAbsolute(worktree))
  assert.ok(io.state.out.includes(worktree))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[4], worktree)
  assert.ok(existsSync(join(root, 'ext-wt')))
})

test('task: 不给 --worktrees-dir 时默认仍是 <root>/.worktrees（行为不变）', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 0)

  const worktree = join(root, '.worktrees', '12-add-login')
  assert.ok(io.state.out.includes(worktree))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[4], worktree)
  assert.equal(
    existsSync(join(root, '.worktrees')),
    false,
    '缺省路径不由本包 mkdir（仍交给 git worktree add），失败时不留下空目录',
  )
})

test('task: --worktrees-dir 容器已存在时直接复用，不报错', () => {
  const root = tmp()
  withRepo(root)
  const container = join(tmp(), 'exists-wt')
  mkdirSync(container, { recursive: true })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root, '--worktrees-dir', container], io, runner), 0)

  assert.ok(io.state.out.includes(join(container, '12-add-login')))
  assert.ok(calls.some((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add'))
})

test('task: --worktrees-dir 下同一 issue 重复调用仍幂等，只打印已有路径', () => {
  const root = tmp()
  withRepo(root)
  const container = join(tmp(), 'idem-wt')
  const worktree = join(container, '12-add-login')
  const { runner, calls } = makeRunner({ worktrees: [{ path: worktree, branch: 'task/12-add-login' }] })
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root, '--worktrees-dir', container], io, runner), 0)

  assert.match(io.state.out, /worktree 已存在/)
  assert.ok(io.state.out.includes(worktree))
  assert.equal(calls.some((call) => sub(call.args)[0] === 'fetch'), false)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add'), false)
})

test('task: --worktrees-dir 空值退出 2，不发出任何命令', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  for (const argv of [
    ['task', '12', '--root', root, '--worktrees-dir'],
    ['task', '12', '--root', root, '--worktrees-dir', '   '],
  ]) {
    const io = makeIO()
    assert.equal(run(argv, io, runner), 2, `argv: ${argv.join(' ')}`)
    assert.match(io.state.err, /--worktrees-dir/)
  }
  assert.equal(calls.length, 0, '参数错误不该发出任何命令')
})

test('task: 配置 worktreesDir 且不传 flag 时 worktree 建在配置目录', () => {
  const root = tmp()
  const container = join(tmp(), 'cfg-wt')
  withRepo(root, 'owner/repo', { worktreesDir: container })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 0)

  const worktree = join(container, '12-add-login')
  assert.ok(io.state.out.includes(worktree))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[4], worktree)
  assert.ok(existsSync(container), '配置的容器目录不存在时按 mkdir -p 创建')
})

test('task: --worktrees-dir 与配置同时给定时用 flag', () => {
  const root = tmp()
  const configured = join(tmp(), 'from-config')
  const flagged = join(tmp(), 'from-flag')
  withRepo(root, 'owner/repo', { worktreesDir: configured })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root, '--worktrees-dir', flagged], io, runner), 0)

  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[4], join(flagged, '12-add-login'))
  assert.equal(existsSync(configured), false, 'flag 生效时不该动配置里的目录')
})

test('task: 配置 worktreesDir 是相对路径时按 --root 解析成绝对路径', () => {
  const root = tmp()
  withRepo(root, 'owner/repo', { worktreesDir: 'ext-wt' })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 0)

  const worktree = join(root, 'ext-wt', '12-add-login')
  assert.ok(isAbsolute(worktree))
  assert.ok(io.state.out.includes(worktree))
  const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
  assert.equal(sub(add.args)[4], worktree)
  assert.ok(existsSync(join(root, 'ext-wt')))
})

test('task: 配置 worktreesDir 写 ~/ 时展开成家目录', () => {
  const root = tmp()
  const container = join(homedir(), '.dsh-pipeline-task-test-wt')
  rmSync(container, { recursive: true, force: true })
  withRepo(root, 'owner/repo', { worktreesDir: '~/.dsh-pipeline-task-test-wt' })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  try {
    assert.equal(run(['task', '12', '--root', root], io, runner), 0)

    const worktree = join(container, '12-add-login')
    assert.ok(io.state.out.includes(worktree))
    const add = calls.find((call) => sub(call.args)[0] === 'worktree' && sub(call.args)[1] === 'add')
    assert.equal(sub(add.args)[4], worktree)
    assert.ok(existsSync(container))
  } finally {
    rmSync(container, { recursive: true, force: true })
  }
})

test('task: 配置 worktreesDir 非字符串时退出 2，不发出任何命令', () => {
  const root = tmp()
  withRepo(root, 'owner/repo', { worktreesDir: 42 })
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['task', '12', '--root', root], io, runner), 2)
  assert.match(io.state.err, /worktreesDir/)
  assert.equal(calls.length, 0, '配置不合规不该发出任何命令')
})
