/**
 * task 的 root 语义集成测试：用真实临时仓库 + 真实 `git worktree add` 复现
 * 「在 worktree 里再跑 task」的现场，断言新建 worktree 永远落在主工作区下。
 * 只有 gh 被替换成假 runner，不触网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'

const ISSUE = 235
const TITLE = 'Fix worktree root'
const SLUG = 'fix-worktree-root'

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败: ${result.stderr}`)
  return result.stdout
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

/** git 走真实实现，gh 返回固定 issue——task 是唯一被测对象，不验证 gh。 */
function runner(command, args, options) {
  if (command === 'gh') {
    return { status: 0, stdout: JSON.stringify({ number: ISSUE, title: TITLE }), stderr: '' }
  }
  return spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, ...options })
}

function callTask(argv, cwd) {
  const io = makeIO()
  const code = runCli(argv, {
    cwd,
    runner,
    sleep: () => {},
    stdout: io.stdout,
    stderr: io.stderr,
  })
  return { code, ...io.state }
}

/**
 * 主工作区 + bare origin + 一个 linked worktree。
 * linked worktree 用来模拟「已经在某个 task worktree 里」的运行现场。
 */
function fixture() {
  // 先 realpath：macOS 的 /var 是 /private/var 的符号链接，不归一会让 git 输出的路径
  // 与 join(tmpdir(), ...) 拼出来的路径对不上。
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-task-root-')))
  const origin = join(base, 'origin.git')
  const main = join(base, 'main')
  const linked = join(base, 'linked')

  runGit(base, ['init', '--bare', origin])
  runGit(base, ['init', '-b', 'main', main])
  runGit(main, ['config', 'user.name', 'Test User'])
  runGit(main, ['config', 'user.email', 'test@example.com'])

  writeFileSync(join(main, 'README.md'), '# fixture\n', 'utf8')
  mkdirSync(join(main, '.dsh'), { recursive: true })
  writeFileSync(join(main, '.dsh', 'pipeline.json'), JSON.stringify({ repo: 'owner/repo' }), 'utf8')

  runGit(main, ['add', '.'])
  runGit(main, ['commit', '-m', 'init'])
  runGit(main, ['remote', 'add', 'origin', origin])
  runGit(main, ['push', '-u', 'origin', 'main'])

  runGit(main, ['worktree', 'add', '-b', `task/9-${SLUG}`, linked, 'origin/main'])

  return { base, main, linked }
}

test('task: 在 linked worktree 里运行，worktree 建在主工作区而不是嵌套', () => {
  const { main, linked } = fixture()
  const target = join(main, '.worktrees', `${ISSUE}-${SLUG}`)
  const nested = join(linked, '.worktrees', `${ISSUE}-${SLUG}`)

  const result = callTask(['task', String(ISSUE)], linked)

  assert.equal(result.code, 0, result.err)
  assert.ok(result.out.includes(target), `输出应包含主工作区路径:\n${result.out}`)
  assert.ok(existsSync(target), '新 worktree 应实际创建在主工作区下')
  assert.equal(existsSync(nested), false, '不应在 linked worktree 下嵌套 .worktrees')

  const list = runGit(main, ['worktree', 'list', '--porcelain'])
  assert.ok(list.includes(`worktree ${target}`), '主工作区的 worktree 列表应包含新路径')
})

test('task: 显式 --root 指向主工作区时行为不变', () => {
  const { main } = fixture()
  const target = join(main, '.worktrees', `${ISSUE}-${SLUG}`)

  const result = callTask(['task', String(ISSUE), '--root', main], main)

  assert.equal(result.code, 0, result.err)
  assert.ok(result.out.includes(target), result.out)
  assert.ok(existsSync(target))
})

test('task: 同一 issue 再跑一次仍是「已存在」而不是报错', () => {
  const { main, linked } = fixture()
  const target = join(main, '.worktrees', `${ISSUE}-${SLUG}`)

  const first = callTask(['task', String(ISSUE)], linked)
  assert.equal(first.code, 0, first.err)
  assert.ok(existsSync(target))

  const second = callTask(['task', String(ISSUE)], linked)
  assert.equal(second.code, 0, second.err)
  assert.equal(second.err, '')
  assert.match(second.out, /worktree 已存在/)

  // 分支只建一次：第二次没有再执行 worktree add，也没有留下重复目录。
  const branches = runGit(main, ['branch', '--list', `task/${ISSUE}-${SLUG}`])
  assert.equal(branches.trim().split('\n').length, 1)
})

test('task: 显式 --root 指向 linked worktree 时折回主工作区', () => {
  const { main, linked } = fixture()
  const target = join(main, '.worktrees', `${ISSUE}-${SLUG}`)
  const nested = join(linked, '.worktrees', `${ISSUE}-${SLUG}`)

  const result = callTask(['task', String(ISSUE), '--root', linked], linked)

  assert.equal(result.code, 0, result.err)
  assert.ok(existsSync(target), '显式传入 worktree 路径也应把容器放回主工作区')
  assert.equal(existsSync(nested), false)
})
