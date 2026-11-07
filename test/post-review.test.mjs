/**
 * review publish --post-review 的行为测试。
 *
 * 全部走真实子进程 + PATH 前置的 stub gh：stub 只记录 argv、按环境变量
 * 决定「已有 review 列表」与「POST 退出码」，不联网、不碰真实 gh。
 *
 * 断言的都是对外承诺：不带 --post-review 一个 gh 都不发、event 映射、
 * 同 SHA 幂等跳过、发失败退 3 且记录不回滚、缺 repo 退 2、dry-run 不落盘。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'cli.mjs')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const PR = 42
const SHA = 'c'.repeat(40)
const NONCE = 'ABCDEFGHJKLM'
const DIFF = 'diff --git a/lib/a.mjs b/lib/a.mjs\n--- a/lib/a.mjs\n+++ b/lib/a.mjs\n+1\n'
const MARKER = `<!-- dsh-pipeline:review ${SHA} -->`
const RECORD_REL = `.dsh-web/reviews/${PR}-${SHA}.json`

/**
 * stub gh：每行记一次调用（参数内换行转成空格，argv 用制表符分隔）；
 * 只有 `-X POST` 是 POST（按 STUB_POST_EXIT 决定成败），其余（含 `-X GET`）是列已有 review（按 STUB_REVIEWS_JSON 应答）。
 */
const STUB_GH = `#!/bin/sh
line=''
for a in "$@"; do
  a=$(printf '%s' "$a" | tr '\\n' ' ')
  if [ -z "$line" ]; then line="$a"; else line="$line	$a"; fi
done
printf '%s\\n' "$line" >> "$STUB_GH_LOG"

is_post=0
prev=''
for a in "$@"; do
  if [ "$prev" = "-X" ] && [ "$a" = "POST" ]; then is_post=1; fi
  prev="$a"
done

if [ "$is_post" = "1" ]; then
  post_exit="$STUB_POST_EXIT"
  if [ -z "$post_exit" ]; then post_exit=0; fi
  if [ "$post_exit" != "0" ]; then
    post_err="$STUB_POST_STDERR"
    if [ -z "$post_err" ]; then post_err='stub gh: POST failed'; fi
    printf '%s\\n' "$post_err" >&2
    exit "$post_exit"
  fi
  printf '{"id":1}\\n'
  exit 0
fi

list_exit="$STUB_LIST_EXIT"
if [ -z "$list_exit" ]; then list_exit=0; fi
if [ "$list_exit" != "0" ]; then
  list_err="$STUB_LIST_STDERR"
  if [ -z "$list_err" ]; then list_err='stub gh: list failed'; fi
  printf '%s\\n' "$list_err" >&2
  exit "$list_exit"
fi
reviews="$STUB_REVIEWS_JSON"
if [ -z "$reviews" ]; then reviews='[]'; fi
printf '%s\\n' "$reviews"
exit 0
`

function reviewText(verdict, sha, findings = []) {
  const json = JSON.stringify({ findings, evidence: ['cmd: node --test'] })
  return [
    '分析：变更符合验收依据。',
    '```json',
    json,
    '```',
    `${NONCE} VERDICT: ${verdict} SHA: ${sha}`,
    '',
  ].join('\n')
}

/** 造假消费仓 + stub gh；repo 为 null 时写一份没有 repo 的配置。 */
function makeFixture({ repo = 'o/r', verdict = 'APPROVE', findings = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-post-review-'))
  const root = join(base, 'repo')
  const binDir = join(base, 'bin')
  const cwd = join(base, 'cwd')
  const logFile = join(base, 'calls.log')
  const response = join(base, 'response.txt')

  mkdirSync(join(root, '.dsh'), { recursive: true })
  mkdirSync(join(root, '.tmp', 'review', String(PR)), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(logFile, '', 'utf8')

  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    `${JSON.stringify(repo === null ? {} : { repo }, null, 2)}\n`,
    'utf8',
  )
  writeFileSync(
    join(root, '.tmp', 'review', String(PR), 'request.json'),
    JSON.stringify({
      pr: PR,
      head_sha: SHA,
      round: 1,
      nonce: NONCE,
      model: null,
      provider: null,
      form: null,
      files: ['lib/a.mjs'],
      diff: DIFF,
    }),
    'utf8',
  )
  writeFileSync(response, reviewText(verdict, SHA, findings), 'utf8')

  const ghFile = join(binDir, 'gh')
  writeFileSync(ghFile, STUB_GH, 'utf8')
  chmodSync(ghFile, 0o755)

  const env = {
    ...process.env,
    PATH: `${binDir}${delimiter}${process.env.PATH}`,
    STUB_GH_LOG: logFile,
  }
  return { base, root, cwd, logFile, response, env }
}

function runPublish(fixture, extraArgs = [], envOverrides = {}) {
  const args = [
    CLI,
    'review',
    'publish',
    '--pr',
    String(PR),
    '--response',
    fixture.response,
    '--root',
    fixture.root,
    ...extraArgs,
  ]
  const result = spawnSync(process.execPath, args, {
    cwd: fixture.cwd,
    env: { ...fixture.env, ...envOverrides },
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

function ghCalls(fixture) {
  return readFileSync(fixture.logFile, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
}

function recordPath(fixture) {
  return join(fixture.root, '.dsh-web', 'reviews', `${PR}-${SHA}.json`)
}

function cleanup(t, fixture) {
  t.after(() => rmSync(fixture.base, { recursive: true, force: true }))
  return fixture
}

// 分页调用：gh api -X GET --paginate -F per_page=100 --jq '.[] | {...}' repos/<repo>/pulls/<pr>/reviews
// -X GET 不能省：gh api 见到 -F 却没有显式方法时会把请求切成 POST（读列表变成创建 review）。
const LIST_CALL = `api\t-X\tGET\t--paginate\t-F\tper_page=100\t--jq\t.[] | {commit_id: .commit_id, body: .body}\trepos/o/r/pulls/${PR}/reviews`

test('不带 --post-review：只落盘，gh 一次都不调', (t) => {
  const fixture = cleanup(t, makeFixture())
  const result = runPublish(fixture)

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已写入审核记录: /)
  assert.ok(existsSync(recordPath(fixture)), '记录必须落盘')
  assert.deepEqual(ghCalls(fixture), [], '没带 --post-review 时不许发出任何 gh 调用')
})

test('记录没写成（退 2）：不发 review，退出码保持 2', (t) => {
  const fixture = cleanup(t, makeFixture())
  // 把 reviews 目录换成同名文件，让 writeRecord 必然失败
  mkdirSync(join(fixture.root, '.dsh-web'), { recursive: true })
  writeFileSync(join(fixture.root, '.dsh-web', 'reviews'), 'not a dir', 'utf8')

  const result = runPublish(fixture, ['--post-review'])

  assert.equal(result.status, 2, result.stderr)
  assert.deepEqual(ghCalls(fixture), [], '记录没写成时不许发任何 gh 请求')
})

test('event 映射：APPROVE / REJECT / ESCALATE 各发成对应 event', (t) => {
  const cases = [
    ['APPROVE', 'APPROVE'],
    ['REJECT', 'REQUEST_CHANGES'],
    ['ESCALATE', 'COMMENT'],
  ]
  for (const [verdict, expected] of cases) {
    const fixture = cleanup(t, makeFixture({ verdict, findings: [{ severity: 'blocker', file: 'lib/a.mjs', line: 12, message: '必须先补测试' }] }))
    const result = runPublish(fixture, ['--post-review'])

    assert.equal(result.status, 0, `${verdict}: ${result.stderr}`)
    const calls = ghCalls(fixture)
    assert.equal(calls.length, 2, `${verdict}: 应先列已有 review 再 POST\n${calls.join('\n')}`)
    assert.equal(calls[0], LIST_CALL)
    assert.match(calls[1], new RegExp(`-X\\tPOST\\t-f\\tevent=${expected}\\t`), calls[1])
    assert.ok(calls[1].includes(`-f\tbody=`), 'POST 必须带 body')
    assert.ok(calls[1].includes(MARKER), 'body 必须含幂等标记')
    assert.ok(calls[1].includes(RECORD_REL), 'body 末尾必须附记录相对路径')
    assert.ok(calls[1].includes('[blocker] lib/a.mjs:12 必须先补测试'), 'body 要带 findings 摘要')
    assert.match(result.stdout, new RegExp(`已发送 GitHub review（event=${expected}）`))

    const record = JSON.parse(readFileSync(recordPath(fixture), 'utf8'))
    assert.equal(record.verdict, verdict)
  }
})

test('列已有 review 必须显式 -X GET：gh 遇 -F 无 -X 会把方法切成 POST', (t) => {
  const fixture = cleanup(t, makeFixture())
  const result = runPublish(fixture, ['--post-review'])

  assert.equal(result.status, 0, result.stderr)
  const [listCall] = ghCalls(fixture)
  const argv = listCall.split('\t')
  assert.equal(argv[0], 'api')
  assert.deepEqual(argv.slice(1, 3), ['-X', 'GET'], `列表调用缺显式 GET（会被 gh 翻成 POST）：\n${listCall}`)
})

test('已有同 SHA 且含标记的 review：跳过发送，不发 POST，退 0', (t) => {
  const fixture = cleanup(t, makeFixture())
  // 列表接口现在按 NDJSON 解析（--paginate + --jq '.[]'），stub 原样回显，所以这里也给逐行 JSON
  const existing = [JSON.stringify({ commit_id: SHA, body: `判定已发过\n${MARKER}\n记录: ${RECORD_REL}` })].join('\n')
  const result = runPublish(fixture, ['--post-review'], { STUB_REVIEWS_JSON: existing })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /review publish: 已存在同 SHA 的 review，跳过发送/)
  const calls = ghCalls(fixture)
  assert.deepEqual(calls, [LIST_CALL], '幂等命中时只允许列一次，不许 POST')
  assert.ok(existsSync(recordPath(fixture)), '记录照常落盘')
})

test('POST 失败：stderr 打原文，退 3，记录不回滚', (t) => {
  const fixture = cleanup(t, makeFixture())
  const result = runPublish(fixture, ['--post-review'], {
    STUB_POST_EXIT: '1',
    STUB_POST_STDERR: 'stub gh: 403 forbidden by server',
  })

  assert.equal(result.status, 3, `stdout: ${result.stdout}`)
  assert.match(result.stderr, /stub gh: 403 forbidden by server/, 'stderr 要打 gh 原文')
  assert.match(result.stderr, /记录已写，review 未发出/)
  assert.ok(existsSync(recordPath(fixture)), '记录已落盘，不回滚')
})

test('配置没有 repo：退 2，不发任何 gh 调用', (t) => {
  const fixture = cleanup(t, makeFixture({ repo: null }))
  const result = runPublish(fixture, ['--post-review'])

  assert.equal(result.status, 2, `stdout: ${result.stdout}`)
  assert.match(result.stderr, /缺少 repo/)
  assert.deepEqual(ghCalls(fixture), [], '缺 repo 时连列 review 都不许发')
  assert.ok(existsSync(recordPath(fixture)), '记录照常落盘')
})

test('--dry-run：不写盘、不发请求，打印 event 与 body 前 200 字', (t) => {
  const fixture = cleanup(t, makeFixture({ findings: [{ severity: 'major', file: 'lib/b.mjs', line: 7, message: '缺一条分支' }] }))
  const result = runPublish(fixture, ['--post-review', '--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /--dry-run，不写盘、不发请求/)
  assert.match(result.stdout, /^event: APPROVE$/m)
  const bodyLine = result.stdout.split('\n').find((line) => line.startsWith('body（前 200 字）:'))
  assert.ok(bodyLine, `stdout 里没找到 body 行:\n${result.stdout}`)
  assert.match(result.stdout, new RegExp(`body（前 200 字）:\\n${NONCE} VERDICT: APPROVE SHA: ${SHA}`))
  assert.ok(!existsSync(recordPath(fixture)), 'dry-run 不许写记录')
  assert.deepEqual(ghCalls(fixture), [], 'dry-run 不许发请求')
  assert.ok(result.stdout.length > 0)
})

test('--dry-run 判定不可用时按 ESCALATE 预览（与正式落盘口径一致）', (t) => {
  const fixture = cleanup(t, makeFixture())
  writeFileSync(fixture.response, '没有判定行的响应\n', 'utf8')
  const result = runPublish(fixture, ['--dry-run'])

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^event: COMMENT$/m)
  assert.ok(!existsSync(recordPath(fixture)), 'dry-run 不许写记录')
  assert.deepEqual(ghCalls(fixture), [])
})

test('body 的 findings 摘要最多 10 条，超出截断（记录本身仍留全部）', (t) => {
  const findings = Array.from({ length: 12 }, (_, index) => ({
    severity: 'nit',
    file: `lib/f${index}.mjs`,
    line: index + 1,
    message: `问题${index}`,
  }))
  const fixture = cleanup(t, makeFixture({ findings }))
  const result = runPublish(fixture, ['--post-review'])

  assert.equal(result.status, 0, result.stderr)
  const post = ghCalls(fixture)[1]
  assert.equal((post.match(/\[nit\]/g) ?? []).length, 10, post)
  assert.ok(post.includes('问题9'), '前 10 条要保留')
  assert.ok(!post.includes('问题10') && !post.includes('问题11'), '第 11 条起不该进 body')

  const record = JSON.parse(readFileSync(recordPath(fixture), 'utf8'))
  assert.equal(record.findings.length, 12, '截断只发生在 body，记录仍是全量')
})

test('列已有 review 失败：退 3，记录仍在，不发 POST', (t) => {
  const fixture = cleanup(t, makeFixture())
  const result = runPublish(fixture, ['--post-review'], {
    STUB_LIST_EXIT: '1',
    STUB_LIST_STDERR: 'stub gh: list exploded',
  })

  assert.equal(result.status, 3, `stdout: ${result.stdout}`)
  assert.match(result.stderr, /stub gh: list exploded/)
  assert.match(result.stderr, /记录已写，review 未发出/)
  assert.equal(ghCalls(fixture).length, 1, '列失败后不许再 POST')
  assert.ok(existsSync(recordPath(fixture)), '记录已落盘，不回滚')
})

test('幂等不受分页影响：目标 review 在第 2 页（>100 条之后）仍被认出来', (t) => {
  const fixture = cleanup(t, makeFixture())
  // 模拟 --paginate 把两页拼起来：第 1 页 100 条无关 review，第 2 页才有同 SHA 的那条。
  // 若列表调用退回成「只取第一页」，这里会漏判并重复 POST。
  const firstPage = Array.from({ length: 100 }, (_, i) =>
    JSON.stringify({ commit_id: `sha-other-${i}`, body: `无关 review ${i}` }),
  )
  const secondPage = [
    JSON.stringify({ commit_id: SHA, body: `已发过\n${MARKER}\n记录: ${RECORD_REL}` }),
  ]
  const result = runPublish(fixture, ['--post-review'], {
    STUB_REVIEWS_JSON: [...firstPage, ...secondPage].join('\n'),
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /已存在同 SHA 的 review，跳过发送/)
  assert.deepEqual(ghCalls(fixture), [LIST_CALL], '幂等命中时不许 POST')
})
