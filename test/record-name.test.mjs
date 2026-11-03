/**
 * --name：自定义落盘文件名（分片审核用，避免「先写规范名再删除」的窗口）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeRecord } from '../lib/record.mjs'

const sha = 'a'.repeat(40)
const base = {
  schemaVersion: 1,
  policyVersion: '0.1.0',
  pr: 7,
  round: 1,
  verdict: 'APPROVE',
  head_sha: sha,
  findings: [],
  evidence: [],
  createdAt: new Date().toISOString(),
}

test('--name：按给定文件名落盘，不产生规范名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-name-'))
  try {
    const file = writeRecord(dir, base, { name: `7-${sha}.shard-1-of-2.json` })
    assert.match(file, /shard-1-of-2\.json$/)
    assert.deepEqual(readdirSync(dir), [`7-${sha}.shard-1-of-2.json`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--name：非法文件名一律拒绝（含路径穿越与错后缀）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-name-'))
  try {
    for (const bad of ['../evil.json', 'a/b.json', 'x.txt', '.hidden.json', 'a..json']) {
      assert.throws(() => writeRecord(dir, base, { name: bad }), /文件名非法/, bad)
    }
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--name：文件内容仍是完整记录，可被 readRecord 读回', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rec-name-'))
  try {
    const file = writeRecord(dir, base, { name: 'x.json' })
    const text = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(text.pr, 7)
    assert.equal(text.verdict, 'APPROVE')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
