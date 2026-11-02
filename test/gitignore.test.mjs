import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

test('.gitignore 忽略 .tmp/：审核产物不入库', () => {
  const lines = readFileSync(join(ROOT, '.gitignore'), 'utf8').split(/\r?\n/)
  assert.ok(lines.includes('.tmp/'), '.gitignore 应包含一条独立的 .tmp/')

  // 用真实 git 判定，而不是只匹配文本：模式写错（如 .tmp 漏斜杠）也该被测出来。
  const result = spawnSync('git', ['-C', ROOT, 'check-ignore', '--no-index', '-q', '.tmp/review.json'], {
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, `git check-ignore 应判定 .tmp/ 下的文件被忽略: ${result.stderr ?? ''}`)
})
