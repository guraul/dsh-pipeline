/**
 * lib/peer.mjs：`selftest --peer` 的声明收集与判定。
 *
 * 覆盖四个声明来源与优先级、peer 依赖只在前面都没有时才生效、跳过生成物目录、
 * `resolveDshVersion` 的两个位置、`checkPeer` 的四种结果，以及 CLI 退出码与 `--json`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { checkPeer, collectRequirements, resolveDshVersion } from '../lib/peer.mjs'

const DSH = '0.2.2-rc.1'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-peer-'))
}

function makePkg(root, path, pkg) {
  mkdirSync(join(root, path), { recursive: true })
  writeFileSync(join(root, path, 'package.json'), JSON.stringify(pkg))
}

function run(argv) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
  })
  return { code, ...state }
}

test('collectRequirements：四个来源都能取到，peer 依赖只在前面都没有时才生效', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  makePkg(root, 'a', { name: 'a', engines: { dsh: '>=0.1.0-rc.7 <0.3.0-0' } })
  makePkg(root, 'b', { name: 'b', dsh: { engines: { dsh: '>=0.1.5-rc.1' } } })
  makePkg(root, 'c', { name: 'c', dsh: { compatibility: { dsh: '^0.2.1-rc.2' } } })
  makePkg(root, 'd', { name: 'd', peerDependencies: { '@deepseek-ai/dsh-tools': '^0.2.1-alpha.5' } })
  makePkg(root, 'e', { name: 'e', engines: { dsh: '>=0.1.0' }, peerDependencies: { '@deepseek-ai/dsh-tools': '^9.9.9' } })
  // 同包多来源：只取优先级最高的那条
  makePkg(root, 'f', { name: 'f', engines: { dsh: '>=0.1.0' }, dsh: { compatibility: { dsh: '^9.9.9' } } })
  for (const dir of ['node_modules/x', 'dist', '.cache']) makePkg(root, dir, { name: dir, engines: { dsh: '>=9.0.0' } })

  const { requirements, scanned } = collectRequirements(root)
  assert.deepEqual(
    requirements.map((item) => [item.name, item.source]),
    [
      ['a', 'engines.dsh'],
      ['b', 'dsh.engines.dsh'],
      ['c', 'dsh.compatibility.dsh'],
      ['d', 'peerDependencies.@deepseek-ai/dsh-tools'],
      ['e', 'engines.dsh'],
      ['f', 'engines.dsh'],
    ],
  )
})

test('resolveDshVersion：读 node_modules 与 tools/node_modules 两处', (t) => {
  const a = tmp()
  const b = tmp()
  const empty = tmp()
  t.after(() => [a, b, empty].forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  makePkg(a, 'node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: DSH })
  makePkg(b, 'tools/node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: '0.1.9' })

  assert.equal(resolveDshVersion(a), DSH)
  assert.equal(resolveDshVersion(b), '0.1.9')
  assert.equal(resolveDshVersion(empty), null)
})

test('checkPeer：跳过 / 覆盖 / 不覆盖 / 不知道版本', (t) => {
  const empty = tmp()
  const root = tmp()
  t.after(() => [empty, root].forEach((dir) => rmSync(dir, { recursive: true, force: true })))
  makePkg(root, 'a', { name: 'a', dsh: { compatibility: { dsh: '^0.2.1-rc.2' } } })

  const skip = checkPeer(empty, { dshVersion: DSH })
  assert.equal(skip.ok, true)

  const ok = checkPeer(root, { dshVersion: DSH })
  assert.equal(ok.ok, true)
  assert.match(ok.detail, /1 条声明都覆盖 dsh 0\.2\.2-rc\.1/)

  const bad = checkPeer(root, { dshVersion: '0.3.0' })
  assert.equal(bad.ok, false)
  assert.match(bad.detail, /1\/1 条声明不覆盖 dsh 0\.3\.0: a（dsh\.compatibility\.dsh）声明 "\^0\.2\.1-rc\.2"/)

  const unknown = checkPeer(root, {})
  assert.equal(unknown.ok, false)
  assert.match(unknown.detail, /无法确定当前 DSH 版本/)
})

test('selftest --peer：覆盖 0 / 不覆盖 1 / 不知道版本 2 / 非法版本 2', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  makePkg(root, 'a', { name: 'a', dsh: { compatibility: { dsh: '^0.2.1-rc.2' } } })

  const ok = run(['selftest', '--peer', '--root', root, '--dsh-version', DSH])
  assert.equal(ok.code, 0, ok.err)

  const bad = run(['selftest', '--peer', '--root', root, '--dsh-version', '0.3.0'])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /不覆盖 dsh 0\.3\.0/)

  const unknown = run(['selftest', '--peer', '--root', root])
  assert.equal(unknown.code, 2)
  assert.match(unknown.err, /无法确定当前 DSH 版本/)

  const invalid = run(['selftest', '--peer', '--root', root, '--dsh-version', 'nope'])
  assert.equal(invalid.code, 2)
  assert.match(invalid.err, /--dsh-version 必须是合法版本号/)

  const notDir = run(['selftest', '--peer', '--root', join(root, 'a', 'package.json'), '--dsh-version', DSH])
  assert.equal(notDir.code, 2)
  assert.match(notDir.err, /--root 不是目录/)
})

test('selftest --peer：缺省版本从仓里装的包读；--json 结构与其他检查项一致', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  makePkg(root, 'a', { name: 'a', engines: { dsh: '>=0.2.0' } })
  makePkg(root, 'node_modules/@deepseek-ai/dsh', { name: '@deepseek-ai/dsh', version: DSH })

  const result = run(['selftest', '--peer', '--json', '--root', root])
  const payload = JSON.parse(run(['selftest', '--peer', '--json', '--root', root]).out)
  assert.equal(payload.ok, true)
  assert.equal(payload.checks[0].name, 'peer')
  assert.equal(payload.checks[0].ok, true)
  assert.match(payload.checks[0].detail, /1 条声明都覆盖 dsh 0\.2\.2-rc\.1/)
})
