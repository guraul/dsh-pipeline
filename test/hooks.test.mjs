/**
 * hooks：pre-push 直推拦截钩子的安装与校验。
 *
 * 覆盖：tmp 里 git init → install → 文件存在且 0755 且含标记行 → check 通过 →
 * 改一个字节 → check 退 1 → 再 install 覆盖回正确内容 → 手写无标记钩子被拒退 1、
 * --force 后覆盖成功 → 直推 main 拒绝 exit 1、其它分支放行 exit 0 →
 * --allow-main 装放行版 → worktree 里 install 装到主仓 git 目录 → 用法错误退 2。
 * 只做本地 git 操作（init / config / commit --allow-empty / worktree add），不联网。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli } from '../bin/cli.mjs'
import { HOOK_MARKER, renderHook } from '../lib/hooks.mjs'

function tmp(prefix = 'dsh-hooks-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function run(argv, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    ...deps,
  })
  return { code, ...state }
}

function git(root, ...args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败: ${result.stderr}`)
  return result.stdout
}

function initRepo() {
  const root = tmp()
  const result = spawnSync('git', ['init', root], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return root
}

function hookPath(root) {
  return join(root, '.git', 'hooks', 'pre-push')
}

function pushLines(...refs) {
  return refs.map((remote) => `refs/heads/x sha111 ${remote} sha222\n`).join('')
}

function runHook(hook, input) {
  return spawnSync('bash', [hook], { input, encoding: 'utf8' })
}

test('hooks install：装进 git 目录的 hooks/pre-push，0755 且含标记行，check 通过', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const installed = run(['hooks', 'install', '--root', root])
  assert.equal(installed.code, 0)
  assert.equal(installed.err, '')
  const file = hookPath(root)
  assert.equal(installed.out, `hooks: 已安装 ${file}\n`)

  assert.ok(existsSync(file), 'pre-push 应存在')
  assert.equal(statSync(file).mode & 0o777, 0o755, '应为 0755')
  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes(HOOK_MARKER), '应含标记行')
  assert.equal(content, renderHook())

  const checked = run(['hooks', 'check', '--root', root])
  assert.equal(checked.code, 0)
  assert.equal(checked.err, '')
  assert.match(checked.out, /hooks: 钩子与本包一致/)
})

test('hooks check：改动一个字节 → 退 1；再 install 覆盖回 → check 通过', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(run(['hooks', 'install', '--root', root]).code, 0)

  const file = hookPath(root)
  const original = readFileSync(file, 'utf8')
  const tampered = original.replace('# git 约定', '# git 约定 ')
  assert.notEqual(tampered, original, '篡改应真的改了内容')
  writeFileSync(file, tampered, 'utf8')

  const failed = run(['hooks', 'check', '--root', root])
  assert.equal(failed.code, 1)
  assert.equal(failed.out, '')
  assert.match(failed.err, /钩子与本包生成的内容不一致/)

  const reinstalled = run(['hooks', 'install', '--root', root])
  assert.equal(reinstalled.code, 0)
  assert.equal(reinstalled.err, '')
  assert.equal(reinstalled.out, `hooks: 已更新 ${file}\n`, '带标记行的旧版本直接覆盖')
  assert.equal(readFileSync(file, 'utf8'), original)
  assert.equal(run(['hooks', 'check', '--root', root]).code, 0)
})

test('hooks check：未装 → 退 1 并提示 hooks install', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(['hooks', 'check', '--root', root])
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /未安装 pre-push 钩子/)
  assert.match(result.err, /hooks install/)
})

test('hooks install：手写无标记钩子 → 拒绝覆盖退 1；--force 后覆盖成功', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const file = hookPath(root)
  const foreign = '#!/usr/bin/env bash\necho 手写的钩子\nexit 0\n'
  mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
  writeFileSync(file, foreign, 'utf8')

  const refused = run(['hooks', 'install', '--root', root])
  assert.equal(refused.code, 1)
  assert.equal(refused.out, '')
  assert.match(refused.err, /不是本工具安装的钩子/)
  assert.match(refused.err, /--force/)
  assert.equal(readFileSync(file, 'utf8'), foreign, '拒绝时不许动磁盘')

  const forced = run(['hooks', 'install', '--root', root, '--force'])
  assert.equal(forced.code, 0)
  assert.equal(forced.err, '')
  assert.equal(forced.out, `hooks: 已更新 ${file}\n`)
  assert.equal(readFileSync(file, 'utf8'), renderHook())
  assert.equal(statSync(file).mode & 0o777, 0o755)
  assert.equal(run(['hooks', 'check', '--root', root]).code, 0)
})

test('钩子行为：直推 main / master 拒绝 exit 1，其它分支放行 exit 0', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(run(['hooks', 'install', '--root', root]).code, 0)
  const hook = hookPath(root)

  const toMain = runHook(hook, pushLines('refs/heads/main'))
  assert.equal(toMain.status, 1)
  assert.equal(toMain.stdout, '')
  assert.match(toMain.stderr, /拒绝直推/)

  const toMaster = runHook(hook, pushLines('refs/heads/master'))
  assert.equal(toMaster.status, 1)

  const toBranch = runHook(hook, pushLines('refs/heads/x'))
  assert.equal(toBranch.status, 0, toBranch.stderr)
  assert.equal(toBranch.stderr, '')

  const mixed = runHook(hook, pushLines('refs/heads/x', 'refs/heads/main'))
  assert.equal(mixed.status, 1, '一行命中就整批拒绝')
})

test('hooks install --allow-main：装放行版本，check 仍通过', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const installed = run(['hooks', 'install', '--root', root, '--allow-main'])
  assert.equal(installed.code, 0)
  assert.equal(installed.err, '')
  const file = hookPath(root)
  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes(HOOK_MARKER))
  assert.notEqual(content, renderHook())

  assert.equal(runHook(file, pushLines('refs/heads/main')).status, 0, '放行版不拦截')
  assert.equal(run(['hooks', 'check', '--root', root]).code, 0, '放行版也算本包生成')
})

test('hooks install：在 linked worktree 里跑也装到主仓 git 目录', (t) => {
  const root = initRepo()
  const container = tmp('dsh-hooks-wt-')
  const worktree = join(container, 'wt')
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(container, { recursive: true, force: true })
  })

  git(root, 'config', 'user.name', 'hooks-test')
  git(root, 'config', 'user.email', 'hooks-test@example.com')
  git(root, 'commit', '--allow-empty', '-m', 'init')
  git(root, 'worktree', 'add', '-b', 'task/wt', worktree, 'HEAD')
  assert.ok(statSync(join(worktree, '.git')).isFile(), 'worktree 里 .git 应是文件')

  const installed = run(['hooks', 'install', '--root', worktree])
  assert.equal(installed.code, 0, installed.err)
  // git 给 common dir 的是解析过符号链接的真实路径（macOS /var → /private/var）
  const file = hookPath(realpathSync(root))
  assert.equal(installed.out, `hooks: 已安装 ${file}\n`, '应落在主仓 git 目录')
  assert.ok(existsSync(file))
  assert.equal(run(['hooks', 'check', '--root', worktree]).code, 0)
})

test('hooks：缺动作 / 未知动作 / 未知选项 → 退 2', () => {
  const noAction = run(['hooks'])
  assert.equal(noAction.code, 2)
  assert.match(noAction.err, /用法: dsh-pipeline hooks/)

  const unknown = run(['hooks', 'frobnicate'])
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /未知动作: frobnicate/)

  const unknownFlag = run(['hooks', 'install', '--bogus'])
  assert.equal(unknownFlag.code, 2)
  assert.match(unknownFlag.err, /未知选项: --bogus/)

  // check 不接受 --force / --allow-main：严格解析，不静默忽略
  const forceOnCheck = run(['hooks', 'check', '--force'])
  assert.equal(forceOnCheck.code, 2)
  assert.match(forceOnCheck.err, /未知选项: --force/)
})

test('hooks install：仓库设了 core.hooksPath 时装到那里，而不是 .git/hooks', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const customDir = join(root, 'my-hooks')
  mkdirSync(customDir, { recursive: true })
  git(root, 'config', 'core.hooksPath', 'my-hooks')

  const r = run(['hooks', 'install', '--root', root])
  assert.equal(r.code, 0, r.err)
  assert.equal(existsSync(join(customDir, 'pre-push')), true, '应装进 core.hooksPath 指定目录')
  assert.equal(existsSync(hookPath(root)), false, '不应再装进 .git/hooks')
  assert.equal(run(['hooks', 'check', '--root', root]).code, 0)
})

test('hooks check：内容对但被 chmod -x → 退 1（钩子不会跑，不能假绿）', (t) => {
  const root = initRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  assert.equal(run(['hooks', 'install', '--root', root]).code, 0)
  chmodSync(hookPath(root), 0o644)
  const r = run(['hooks', 'check', '--root', root])
  assert.equal(r.code, 1)
  assert.match(r.err, /可执行位/)
})

test('hooks install：core.hooksPath 以 ~/ 开头时按 HOME 展开（git 也会展开，不能装到 <root>/~）', (t) => {
  const root = initRepo()
  const fakeHome = tmp('dsh-hooks-home-')
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(fakeHome, { recursive: true, force: true })
  })
  mkdirSync(join(fakeHome, 'hooks'), { recursive: true })
  git(root, 'config', 'core.hooksPath', '~/hooks')

  const spawned = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/cli.mjs', import.meta.url)), 'hooks', 'install', '--root', root], {
    encoding: 'utf8',
    env: { ...process.env, HOME: fakeHome },
  })
  assert.equal(spawned.status, 0, spawned.stderr)
  assert.equal(existsSync(join(fakeHome, 'hooks', 'pre-push')), true, '应装到 $HOME/hooks')
  assert.equal(existsSync(join(root, '~', 'hooks', 'pre-push')), false, '不得落到 <root>/~/hooks')
})
