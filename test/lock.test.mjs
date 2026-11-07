/**
 * 锁文件（契约 §7.2）：`.dsh/pipeline.lock.json` 的读、写、校验，以及 `lock write|check` 与
 * `selftest --lock` 两条入口。
 *
 * 覆盖：expect 的格式化；锁不存在 → 跳过（0）；格式非法 / 多余字段 → 1；
 * 未装包 → 跳过（0）；旧版本包（无 build.json）→ 1；与锁不一致 → 1 且 detail 同时给出两边值；
 * `lock write` 落盘内容与再次运行即刷新；`lock write` 未装包 → 2；
 * `selftest --lock` 与 `lock check` 同一结论；`--peer` 已实现（无声明时跳过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { LockError, checkLock, formatExpect, readLock, readInstalledBuild, writeLock } from '../lib/lock.mjs'

const SHA = '5a6d133aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const BUILT_AT = '2026-11-06T14:00:00Z'
const EXPECT = '5a6d133 2026-11-06T14:00:00Z'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-lock-'))
}

/** 造一个装了共享包的消费仓；build=false 时只写 package.json（模拟旧版本包）。 */
function makeRepo({ pkg = true, build = true, sha = SHA, builtAt = BUILT_AT } = {}) {
  const root = tmp()
  if (!pkg) return root
  const dir = join(root, 'tools', 'node_modules', 'dsh-pipeline')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), '{"name":"@guraul/dsh-pipeline"}')
  if (build) writeFileSync(join(dir, 'build.json'), JSON.stringify({ gitSha: sha, builtAt, dirty: false }))
  return root
}

function writeLockFile(root, content) {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.lock.json'), content)
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

// ---------- 纯函数 ----------

test('formatExpect：sha7 + 空格 + builtAt，不带 +dirty', () => {
  assert.equal(formatExpect({ gitSha: SHA, builtAt: BUILT_AT }), EXPECT)
  assert.equal(formatExpect({ gitSha: SHA, builtAt: BUILT_AT, dirty: true }), EXPECT)
})

test('formatExpect：缺 gitSha / builtAt → LockError', () => {
  assert.throws(() => formatExpect({ gitSha: SHA }), LockError)
  assert.throws(() => formatExpect({ builtAt: BUILT_AT }), LockError)
  assert.throws(() => formatExpect(null), LockError)
})

test('formatExpect：非十六进制 sha / 含空白的 builtAt → LockError', () => {
  assert.throws(() => formatExpect({ gitSha: 'unknown', builtAt: BUILT_AT }), /gitSha 必须是/)
  assert.throws(() => formatExpect({ gitSha: SHA, builtAt: '2026-11-06 14:00:00' }), /builtAt 不能含空白/)
})

test('readLock：锁里写 40 位全 sha 也算格式错（写侧恒写 sha7）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, JSON.stringify({ expect: `${SHA} ${BUILT_AT}` }))
  assert.throws(() => readLock(root), /expect 必须是「<sha7> <构建时间>」/)
})

test('readLock：文件不存在 → expect 为 null（合法状态）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const lock = readLock(root)
  assert.equal(lock.expect, null)
})

test('readLock：合法文件 → 解析出 expect', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)
  assert.equal(readLock(root).expect, EXPECT)
})

test('readLock：JSON 非法 / 多余字段 / 格式错 → 抛 LockError', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  writeLockFile(root, '{oops')
  assert.throws(() => readLock(root), LockError)

  writeLockFile(root, `{"expect":"${EXPECT}","x":1}`)
  assert.throws(() => readLock(root), /多余字段: x/)

  writeLockFile(root, '{"expect":"不是sha 时间"}')
  assert.throws(() => readLock(root), /expect 必须是/)

  writeLockFile(root, '{"expect":"5a6d133"}')
  assert.throws(() => readLock(root), /expect 必须是/)

  // `$` 在 JS 里放过末尾换行，这里必须显式拒绝
  writeLockFile(root, `{"expect":"${EXPECT}\\n"}`)
  assert.throws(() => readLock(root), /expect 必须是/)
})

test('writeLock：落盘内容固定（2 空格缩进 + 尾换行），并自动建 .dsh/', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = writeLock(root, { gitSha: SHA, builtAt: BUILT_AT })
  assert.equal(file, join(root, '.dsh', 'pipeline.lock.json'))
  assert.equal(readFileSync(file, 'utf8'), `{\n  "expect": "${EXPECT}"\n}\n`)
})

test('readInstalledBuild：未装包 / 旧版本包 / 正常 三种状态', (t) => {
  const missing = makeRepo({ pkg: false })
  const legacy = makeRepo({ build: false })
  const ok = makeRepo()
  t.after(() => [missing, legacy, ok].forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  assert.equal(readInstalledBuild(missing).state, 'missing')
  assert.equal(readInstalledBuild(legacy).state, 'legacy')
  const normal = readInstalledBuild(ok)
  assert.equal(normal.state, 'ok')
  assert.equal(normal.build.gitSha, SHA)
})

// ---------- checkLock ----------

test('checkLock：无锁文件 → 跳过（ok，detail 写跳过）', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const result = checkLock(root)
  assert.equal(result.ok, true)
  assert.equal(result.name, 'lock')
  assert.match(result.detail, /无 \.dsh\/pipeline\.lock\.json（跳过）/)
})

test('checkLock：未装包 → 跳过（ok）', (t) => {
  const root = makeRepo({ pkg: false })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)
  const result = checkLock(root)
  assert.equal(result.ok, true)
  assert.match(result.detail, /跳过（未装包/)
})

test('checkLock：旧版本包（无 build.json）→ 失败', (t) => {
  const root = makeRepo({ build: false })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)
  const result = checkLock(root)
  assert.equal(result.ok, false)
  assert.match(result.detail, /没有 build\.json（旧版本包）/)
})

test('checkLock：与锁不一致 → 失败，detail 同时给出两边', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, '{"expect":"deadbee 2026-11-06T14:00:00Z"}')
  const result = checkLock(root)
  assert.equal(result.ok, false)
  assert.match(result.detail, /锁里是 deadbee .*，装的是 5a6d133 /)
})

test('checkLock：一致 → 通过', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)
  const result = checkLock(root)
  assert.equal(result.ok, true)
  assert.match(result.detail, /与锁一致/)
})

// ---------- CLI：lock 与 selftest --lock ----------

test('lock write：把装包标识写进锁，再次运行即刷新', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const first = run(['lock', 'write', '--root', root])
  assert.equal(first.code, 0, first.err)
  assert.match(first.out, /已写入 \.dsh\/pipeline\.lock\.json（5a6d133 2026-11-06T14:00:00Z）/)
  assert.equal(readLock(root).expect, EXPECT)

  // 换一个构建（重新打包）后重写 → 锁跟着变
  writeFileSync(
    join(root, 'tools', 'node_modules', 'dsh-pipeline', 'build.json'),
    JSON.stringify({ gitSha: 'b'.repeat(40), builtAt: '2026-11-07T01:00:00Z' }),
  )
  const second = run(['lock', 'write', '--root', root])
  assert.equal(second.code, 0, second.err)
  assert.equal(readLock(root).expect, 'bbbbbbb 2026-11-07T01:00:00Z')
})

test('lock write：未装包 → 2；旧版本包 → 2', (t) => {
  const missing = makeRepo({ pkg: false })
  const legacy = makeRepo({ build: false })
  t.after(() => [missing, legacy].forEach((dir) => rmSync(dir, { recursive: true, force: true })))

  const a = run(['lock', 'write', '--root', missing])
  assert.equal(a.code, 2)
  assert.match(a.err, /没有装共享包/)

  const b = run(['lock', 'write', '--root', legacy])
  assert.equal(b.code, 2)
  assert.match(b.err, /旧版本包/)
})

test('checkLock：build.json 的 gitSha 非十六进制（pack.sh 的 unknown）→ 失败退 1，不是冒泡', (t) => {
  const root = makeRepo({ sha: 'unknown' })
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)

  const viaLock = run(['lock', 'check', '--root', root])
  assert.equal(viaLock.code, 1, viaLock.err)
  assert.match(viaLock.err, /gitSha 必须是/)

  const viaSelftest = run(['selftest', '--lock', '--root', root])
  assert.equal(viaSelftest.code, 1, viaSelftest.err)
})

test('lock check / write：--root 不存在或不是目录 → 2（路径打错不能静默通过）', (t) => {
  const root = tmp()
  const file = join(root, 'not-a-dir')
  writeFileSync(file, 'x')
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const missing = run(['lock', 'check', '--root', join(root, 'nope')])
  assert.equal(missing.code, 2)
  assert.match(missing.err, /目录不存在/)

  const notDir = run(['lock', 'write', '--root', file])
  assert.equal(notDir.code, 2)
  assert.match(notDir.err, /不是目录/)
})

test('lock check：与 selftest --lock 结论一致（0 / 1）', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)

  assert.equal(run(['lock', 'check', '--root', root]).code, 0)
  assert.equal(run(['selftest', '--lock', '--root', root]).code, 0)

  writeLockFile(root, '{"expect":"deadbee 2026-11-06T14:00:00Z"}')
  const viaLock = run(['lock', 'check', '--root', root])
  const viaSelftest = run(['selftest', '--lock', '--root', root])
  assert.equal(viaLock.code, 1)
  assert.equal(viaSelftest.code, 1)
  assert.match(viaSelftest.err, /selftest: 锁里是 deadbee .*，装的是 5a6d133 /)
})

test('lock：用法错误统一退 2（缺动作 / 未知动作 / 缺 --root）', () => {
  assert.equal(run(['lock']).code, 2)
  assert.equal(run(['lock', 'bogus', '--root', '.']).code, 2)
  assert.equal(run(['lock', 'check']).code, 2)
})

test('selftest：--peer 已实现（无声明 → 跳过 0）；未指定检查项的提示包含 --lock / --peer', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const peer = run(['selftest', '--peer', '--root', root])
  assert.equal(peer.code, 0, peer.err)
  assert.match(peer.out, /未发现声明 DSH 版本的包（跳过）/)

  const none = run(['selftest'])
  assert.equal(none.code, 2)
  assert.match(none.err, /--lock/)
  assert.match(none.err, /--peer/)
})

test('selftest --lock --json：结构与其它检查项一致', (t) => {
  const root = makeRepo()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeLockFile(root, `{"expect":"${EXPECT}"}`)

  const result = run(['selftest', '--lock', '--json', '--root', root])
  assert.equal(result.code, 0, result.err)
  const payload = JSON.parse(result.out)
  assert.equal(payload.ok, true)
  assert.equal(payload.checks.length, 1)
  assert.equal(payload.checks[0].name, 'lock')
  assert.equal(payload.checks[0].ok, true)
})
