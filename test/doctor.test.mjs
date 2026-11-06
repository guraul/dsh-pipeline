/**
 * doctor：跨仓构建一致性检查。
 *
 * 背景：消费方用 `file:` 指向本地 tarball，版本号常年不变（都是 0.1.0）而内容会变，
 * 所以「三个仓装的是不是同一次打包」只能靠 build.json 判断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { describeRow, diagnose, inspectRepo } from '../lib/doctor.mjs'
import { resolveProfileDir } from '../lib/profile-check.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-doctor-'))
}

/** 造一个「装了包」的仓。build 传 null 表示旧版包（没有 build.json）。 */
function repoWithPackage(root, build) {
  const dir = join(root, 'tools', 'node_modules', 'dsh-pipeline')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@guraul/dsh-pipeline', version: '0.1.0' }))
  if (build !== null) writeFileSync(join(dir, 'build.json'), JSON.stringify(build))
  return root
}

const BUILD_A = { gitSha: 'a'.repeat(40), builtAt: '2026-11-03T10:00:00Z', dirty: false }
const BUILD_B = { gitSha: 'b'.repeat(40), builtAt: '2026-11-03T11:00:00Z', dirty: false }

test('doctor：三个仓同一个构建 → 无漂移', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const roots = ['r1', 'r2', 'r3'].map((n) => repoWithPackage(join(base, n), BUILD_A))

  const { baseline, drift, rows } = diagnose(roots)
  assert.equal(baseline, BUILD_A.gitSha)
  assert.deepEqual(drift, [])
  assert.equal(rows.every((r) => r.installed && r.build !== null), true)
})

test('doctor：有一个仓装的是旧版包（无 build.json）→ 指出该仓', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const fresh = repoWithPackage(join(base, 'fresh'), BUILD_A)
  const stale = repoWithPackage(join(base, 'stale'), null)

  const { rows } = diagnose([fresh, stale])
  const byRoot = Object.fromEntries(rows.map((r) => [r.root, r]))
  assert.match(describeRow(byRoot[stale]), /无构建标识/)
  assert.equal(byRoot[stale].build, null)
  assert.equal(byRoot[fresh].build.gitSha, BUILD_A.gitSha)
})

test('doctor：不同构建 → 记入漂移列表', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const a = repoWithPackage(join(base, 'a'), BUILD_A)
  const b = repoWithPackage(join(base, 'b'), BUILD_B)

  const { baseline, drift } = diagnose([a, b])
  assert.equal(baseline, BUILD_A.gitSha)
  assert.deepEqual(drift, [b])
})

test('doctor：未安装的目录单独报告，不参与漂移判定', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const installed = repoWithPackage(join(base, 'has'), BUILD_A)
  const empty = join(base, 'empty')
  mkdirSync(empty, { recursive: true })

  assert.equal(inspectRepo(empty).installed, false)
  assert.equal(describeRow(inspectRepo(empty)), '未安装')
  assert.deepEqual(diagnose([installed, empty]).drift, [])
})

test('doctor：包源码目录报告「源码目录」而不是未安装', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@guraul/dsh-pipeline', version: '0.1.0' }))

  const row = inspectRepo(root)
  assert.equal(row.source, true)
  assert.match(describeRow(row), /源码目录/)
})

test('doctor：新包 + 旧包混装时，旧包计入漂移（否则会静默通过）', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const fresh = repoWithPackage(join(base, 'fresh'), BUILD_A)
  const stale = repoWithPackage(join(base, 'stale'), null)

  const { baseline, drift } = diagnose([fresh, stale])
  assert.equal(baseline, BUILD_A.gitSha)
  assert.deepEqual(drift, [stale], '装了旧包的仓必须算漂移')
})

test('doctor：全部是源码目录时无漂移（没有可比的安装）', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const src = join(base, 'src')
  mkdirSync(src, { recursive: true })
  writeFileSync(join(src, 'package.json'), JSON.stringify({ name: '@guraul/dsh-pipeline' }))

  const { baseline, drift } = diagnose([src])
  assert.equal(baseline, null)
  assert.deepEqual(drift, [])
})

/** CLI 层跑 doctor：返回退出码与两路输出（profile 体检的 ✓/✗ 分两路，都要断言）。 */
function runDoctor(args, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(['doctor', ...args], {
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

/** 造一个 profile 目录：按开关写 package.json 的包声明与 cordis.patch.yml。 */
function fakeProfile(dir, { oldPkg = false, newPkg = true, cordis = true } = {}) {
  mkdirSync(dir, { recursive: true })
  const dependencies = {}
  if (oldPkg) dependencies['dsh-plugin-product-subagents'] = 'link:../dsh-plugin-product-subagents'
  if (newPkg) dependencies['dsh-plugin-subagents'] = 'link:../dsh-subagents'
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'web', private: true, dependencies }))
  if (cordis) writeFileSync(join(dir, 'cordis.patch.yml'), 'patch: {}\n')
  return dir
}

test('doctor --profile：package.json 仍有旧包 → exit 1，「已无旧包」项报 ✗', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const profile = fakeProfile(join(base, 'profile'), { oldPkg: true })

  const r = runDoctor(['--repo', repo, '--profile', profile])
  assert.equal(r.code, 1, '构建一致，exit 1 必须来自 profile 体检')
  assert.match(r.err, /✗ profile 里已无 dsh-plugin-product-subagents/)
})

test('doctor --profile：缺新包 dsh-plugin-subagents → exit 1', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const profile = fakeProfile(join(base, 'profile'), { oldPkg: false, newPkg: false })

  const r = runDoctor(['--repo', repo, '--profile', profile])
  assert.equal(r.code, 1)
  assert.match(r.err, /✗ profile 里有 dsh-plugin-subagents/)
})

test('doctor --profile：缺 cordis.patch.yml → exit 1', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const profile = fakeProfile(join(base, 'profile'), { cordis: false })

  const r = runDoctor(['--repo', repo, '--profile', profile])
  assert.equal(r.code, 1)
  assert.match(r.err, /✗ cordis\.patch\.yml 存在且非空/)
})

test('doctor --profile：三项都对 → 构建段原样在前、profile 段全 ✓，exit 0', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const profile = fakeProfile(join(base, 'profile'))

  const r = runDoctor(['--repo', repo, '--profile', profile])
  assert.equal(r.code, 0)
  assert.equal(r.err, '')
  const out = r.out.split('\n').filter((line) => line.length > 0)
  assert.ok(out[0].startsWith(`${repo}\t`), `第一行是构建比对结果（保持原样），实际: ${out[0]}`)
  assert.match(r.out, /✓ profile 里已无 dsh-plugin-product-subagents/)
  assert.match(r.out, /✓ profile 里有 dsh-plugin-subagents/)
  assert.match(r.out, /✓ cordis\.patch\.yml 存在且非空/)
  assert.match(r.out, /✓ profile 目录 .*DSH_HOME/)
  assert.equal(out.length, 5, `构建 1 行 + profile 4 行，实际: ${JSON.stringify(out)}`)
})

test('doctor 不带 --profile → 不跑 profile 体检（DSH_HOME 指向有旧包的 profile 仍 exit 0）', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const home = join(base, 'dsh-home')
  fakeProfile(join(home, 'profiles', 'web'), { oldPkg: true, newPkg: false, cordis: false })

  const r = runDoctor(['--repo', repo], { env: { DSH_HOME: home } })
  assert.equal(r.code, 0)
  assert.ok(!r.out.includes('✓'), `不该出现体检行（stdout）: ${r.out}`)
  assert.ok(!r.err.includes('✗'), `不该出现体检行（stderr）: ${r.err}`)
})

test('doctor --json --profile：体检结果并进 JSON，退出码与人读模式一致', (t) => {
  const base = tmp()
  t.after(() => rmSync(base, { recursive: true, force: true }))
  const repo = repoWithPackage(join(base, 'repo'), BUILD_A)
  const profile = fakeProfile(join(base, 'profile'), { oldPkg: true })

  const r = runDoctor(['--repo', repo, '--profile', profile, '--json'])
  assert.equal(r.code, 1)
  assert.equal(r.err, '', '--json 模式不逐行打 ✓/✗，结果在 payload 里')
  const payload = JSON.parse(r.out)
  assert.equal(payload.profile.dir, profile)
  assert.equal(payload.profile.failed, true)
  assert.equal(payload.profile.checks.length, 4)
  assert.equal(payload.profile.checks[0].ok, false)
})

test('profile 目录口径：--profile 给了用它；不给用 $DSH_HOME/profiles/web（DSH_HOME 缺省 $HOME/.dsh）', () => {
  assert.equal(resolveProfileDir('/tmp/custom', { DSH_HOME: '/x/.dsh' }), '/tmp/custom')
  assert.equal(resolveProfileDir(undefined, { DSH_HOME: '/x/.dsh' }), join('/x/.dsh', 'profiles', 'web'))
  assert.equal(resolveProfileDir(undefined, { HOME: '/u' }), join('/u', '.dsh', 'profiles', 'web'))
  assert.equal(resolveProfileDir(undefined, {}), join(homedir(), '.dsh', 'profiles', 'web'))
})
