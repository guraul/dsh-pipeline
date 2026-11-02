import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'

const URL_ = 'https://github.com/owner/repo/pull/34'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-pr-'))
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

function withRepo(root, repo = 'owner/repo') {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify({ repo }), 'utf8')
}

/** 去掉 `-C <cwd>` 前缀，返回真正的 git 子命令与参数。 */
function sub(args) {
  return args[0] === '-C' ? args.slice(2) : args
}

/**
 * 假 runner：分支名、PR 是否已存在、工作区是否干净、push 结果都可覆盖。
 */
function makeRunner({
  branch = 'task/12-add-login',
  title = 'Add login',
  existingPr = null,
  status = '',
  push = { status: 0, stdout: '', stderr: '' },
  create = { status: 0, stdout: `${URL_}\n`, stderr: '' },
} = {}) {
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    const rest = sub(args)
    if (command === 'gh') {
      if (rest[0] === 'issue' && rest[1] === 'view') {
        return { status: 0, stdout: JSON.stringify({ number: 12, title }), stderr: '' }
      }
      if (rest[0] === 'pr' && rest[1] === 'view') {
        if (existingPr === null) return { status: 1, stdout: '', stderr: 'no pull requests found' }
        return { status: 0, stdout: JSON.stringify({ url: existingPr }), stderr: '' }
      }
      if (rest[0] === 'pr' && rest[1] === 'create') return create
      return { status: 1, stdout: '', stderr: 'unexpected gh' }
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
      return { status: 0, stdout: `${branch}\n`, stderr: '' }
    }
    if (rest[0] === 'status') return { status: 0, stdout: status, stderr: '' }
    if (rest[0] === 'push') return push
    return { status: 1, stdout: '', stderr: `unexpected git: ${rest.join(' ')}` }
  }
  return { runner, calls }
}

function run(argv, io, runner) {
  return runCli(argv, { stdout: io.stdout, stderr: io.stderr, runner, sleep: () => {} })
}

test('pr: 正常推送并创建 PR，正文首行 Closes #号', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner()
  const io = makeIO()

  assert.equal(run(['pr', '--root', root], io, runner), 0)
  assert.ok(io.state.out.includes(URL_))
  assert.equal(io.state.err, '')

  const pushed = calls.find((call) => sub(call.args)[0] === 'push')
  assert.deepEqual(pushed.args, ['-C', root, 'push', '-u', 'origin', 'task/12-add-login'])

  const created = calls.find((call) => sub(call.args)[0] === 'pr' && sub(call.args)[1] === 'create')
  assert.deepEqual(created.args.slice(0, 9), [
    'pr',
    'create',
    '--repo',
    'owner/repo',
    '--base',
    'main',
    '--head',
    'task/12-add-login',
    '--title',
  ])
  const body = created.args[created.args.indexOf('--body') + 1]
  assert.equal(body.split('\n')[0], 'Closes #12')
  assert.match(body, /CI 通过 \+ 审核闸门通过；APPROVE 且未命中高风险可直接合并；命中高风险 \/ ESCALATE \/ 轮次超限才需要人点头/)
})

test('pr: 分支名不合规时退出 2，且不 push', () => {
  const root = tmp()
  withRepo(root)
  for (const branch of ['main', 'task/12', 'task/12-Add-Login', 'feat/12-add-login']) {
    const { runner, calls } = makeRunner({ branch })
    const io = makeIO()
    assert.equal(run(['pr', '--root', root], io, runner), 2, `branch: ${branch}`)
    assert.match(io.state.err, /task\/<号>-<slug>/)
    assert.equal(calls.some((call) => sub(call.args)[0] === 'push'), false)
  }
})

test('pr: PR 已存在时只打印链接，不重推不新建', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner({ existingPr: URL_ })
  const io = makeIO()

  assert.equal(run(['pr', '--root', root], io, runner), 0)
  assert.match(io.state.out, /PR 已存在/)
  assert.ok(io.state.out.includes(URL_))
  assert.equal(calls.some((call) => sub(call.args)[0] === 'push'), false)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'pr' && sub(call.args)[1] === 'create'), false)
})

test('pr: push 失败时退出 2，且不创建 PR', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner({
    push: { status: 128, stdout: '', stderr: 'remote: Permission to owner/repo denied' },
  })
  const io = makeIO()

  assert.equal(run(['pr', '--root', root], io, runner), 2)
  assert.match(io.state.err, /推送 task\/12-add-login 失败/)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'pr' && sub(call.args)[1] === 'create'), false)
})

test('pr: 工作区有未提交改动时退出 2', () => {
  const root = tmp()
  withRepo(root)
  const { runner, calls } = makeRunner({ status: ' M lib/pr.mjs\n' })
  const io = makeIO()

  assert.equal(run(['pr', '--root', root], io, runner), 2)
  assert.match(io.state.err, /未提交改动/)
  assert.equal(calls.some((call) => sub(call.args)[0] === 'push'), false)
})

test('pr: 参数错误退出 2（含 --root 缺值）', () => {
  const { runner } = makeRunner()
  for (const argv of [['pr', '--nope'], ['pr', '--root'], ['pr', '--root', '']]) {
    const io = makeIO()
    assert.equal(run(argv, io, runner), 2, `argv: ${argv.join(' ')}`)
    assert.match(io.state.err, /pr:/)
  }
})
