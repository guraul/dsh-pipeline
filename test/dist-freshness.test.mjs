import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { sourceHash, verifyDistFreshness } from '../lib/dist-freshness.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-dist-freshness-'))
}

/** 伪造一个「源码 checkout」：校验时会重算它的指纹。 */
function makeSource() {
  const root = tmp()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"x"}\n')
  writeFileSync(join(root, 'lib', 'index.mjs'), 'export const ok = true\n')
  return root
}

/** 伪造装包目录里的 build.json。 */
function writeBuild(dir, info) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'build.json'), `${JSON.stringify(info)}\n`)
  return join(dir, 'build.json')
}

test('没有 build.json → 跳过（running from source）', () => {
  const result = verifyDistFreshness({ buildPath: join(tmp(), 'build.json') })
  assert.deepEqual(result, { ok: true, skipped: true, reason: 'running from source' })
})

test('记录的源码目录不存在 → 跳过（source checkout not found）', () => {
  const buildPath = writeBuild(tmp(), {
    sourcePath: join(tmp(), 'does-not-exist'),
    sourceHash: 'a'.repeat(64),
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.equal(result.reason, 'source checkout not found')
})

test('指纹一致 → ok', () => {
  const source = makeSource()
  const buildPath = writeBuild(tmp(), {
    gitSha: 'a'.repeat(40),
    builtAt: '2026-11-07T00:00:00Z',
    dirty: false,
    sourcePath: source,
    sourceHash: sourceHash(source),
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, false)
  assert.equal(result.recorded, result.actual)
})

test('指纹不一致 → not ok，reason 含「已过期」并给出前 8 位', () => {
  const source = makeSource()
  const recorded = 'b'.repeat(64)
  const buildPath = writeBuild(tmp(), { sourcePath: source, sourceHash: recorded })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, false)
  assert.equal(result.skipped, false)
  assert.match(result.reason, /dist 已过期：源码已改但未重新 pack/)
  assert.ok(result.reason.includes(recorded.slice(0, 8)), 'reason 要带记录指纹前 8 位')
  assert.ok(result.reason.includes(result.actual.slice(0, 8)), 'reason 要带当前指纹前 8 位')
})

test('allowStale 不改变 ok（是否放行由调用方判断）', () => {
  const source = makeSource()
  const buildPath = writeBuild(tmp(), { sourcePath: source, sourceHash: 'c'.repeat(64) })
  assert.equal(verifyDistFreshness({ buildPath, allowStale: true }).ok, false)
})

test('旧版打包（缺 sourcePath/sourceHash）→ 跳过，不打挂消费方', () => {
  const buildPath = writeBuild(tmp(), {
    gitSha: 'a'.repeat(40),
    builtAt: '2026-11-07T00:00:00Z',
    dirty: false,
  })
  const result = verifyDistFreshness({ buildPath })
  assert.equal(result.ok, true)
  assert.equal(result.skipped, true)
  assert.match(result.reason, /旧版打包/)
})
