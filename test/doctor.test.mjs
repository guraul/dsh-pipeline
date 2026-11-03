/**
 * doctor：跨仓构建一致性检查。
 *
 * 背景：消费方用 `file:` 指向本地 tarball，版本号常年不变（都是 0.1.0）而内容会变，
 * 所以「三个仓装的是不是同一次打包」只能靠 build.json 判断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describeRow, diagnose, inspectRepo } from '../lib/doctor.mjs'

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
