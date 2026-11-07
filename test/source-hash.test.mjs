import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { sourceHash } from '../scripts/source-hash.mjs'

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-source-hash-'))
}

/** 造一份文件结构；entries = [[相对路径, 内容], …]，按给定顺序写入。 */
function makeTree(root, entries) {
  for (const [rel, content] of entries) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  return root
}

const BASE = [
  ['package.json', '{"name":"x"}\n'],
  ['bin/cli.mjs', 'export const a = 1\n'],
  ['lib/policy.mjs', 'export const b = 2\n'],
  ['lib/nested/util.mjs', 'export const c = 3\n'],
  ['templates/shim.sh', '#!/usr/bin/env bash\necho hi\n'],
]

test('同一份源码在不同目录算出同一个指纹', () => {
  const a = makeTree(tmp(), BASE)
  const b = makeTree(tmp(), BASE)
  assert.equal(sourceHash(a), sourceHash(b))
  assert.match(sourceHash(a), /^[0-9a-f]{64}$/)
})

test('改一个字节指纹就变', () => {
  const a = makeTree(tmp(), BASE)
  const b = makeTree(tmp(), [
    ...BASE.slice(0, 3),
    ['lib/nested/util.mjs', 'export const c = 4\n'],
    ...BASE.slice(4),
  ])
  assert.notEqual(sourceHash(a), sourceHash(b))
})

test('文件写入顺序不影响指纹（按路径字典序拼接）', () => {
  const a = makeTree(tmp(), BASE)
  const b = makeTree(tmp(), [...BASE].reverse())
  assert.equal(sourceHash(a), sourceHash(b))
})

test('各机器不一致的条目（隐藏文件、node_modules）不进指纹', () => {
  const a = makeTree(tmp(), BASE)
  const b = makeTree(tmp(), [
    ...BASE,
    ['.DS_Store', 'junk'],
    ['lib/.hidden', 'junk'],
    ['lib/node_modules/dep/index.js', 'module.exports = 1\n'],
  ])
  assert.equal(sourceHash(a), sourceHash(b))
})

test('缺目标目录只影响该目标，不抛错', () => {
  const root = makeTree(tmp(), [['package.json', '{"name":"y"}\n']])
  assert.match(sourceHash(root), /^[0-9a-f]{64}$/)
})
