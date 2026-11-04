/**
 * review 子命令（prepare / publish）的行为测试。
 *
 * 全部注入假 runner 断言「实际发出的 gh 命令」，不触网；
 * publish 的落盘断言读真实文件——审计轨迹有没有丢，只有文件能证明。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import { NONCE_PATTERN } from '../lib/review.mjs'
import { readRecord, recordFile, reviewsDir } from '../lib/record.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const NONCE = 'ABCDEFGHJKLM'
const DIFF = 'diff --git a/lib/a.mjs b/lib/a.mjs\n--- a/lib/a.mjs\n+++ b/lib/a.mjs\n+1\n'

function makeIO() {
  const state = { out: '', err: '' }
  return {
    state,
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
  }
}

function run(argv, io, deps = {}) {
  return runCli(argv, { stdout: io.stdout, stderr: io.stderr, ...deps })
}

/** 消费仓根目录；repo 为 null 时连 .dsh/pipeline.json 都不写。 */
function makeRoot({ repo = 'owner/repo' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  if (repo !== null) {
    mkdirSync(join(root, '.dsh'), { recursive: true })
    writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify({ repo }), 'utf8')
  }
  return root
}

/** 假 gh：pr view / pr diff 各给一份预设输出，其余命令一律失败。 */
function ghRunner({ view, diff, viewStatus = 0, diffStatus = 0 } = {}) {
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    if (command !== 'gh') return { status: 1, stdout: '', stderr: `意外的命令: ${command}` }
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        status: viewStatus,
        stdout: JSON.stringify(view ?? {}),
        stderr: viewStatus === 0 ? '' : 'gh pr view 失败',
      }
    }
    if (args[0] === 'pr' && args[1] === 'diff') {
      return { status: diffStatus, stdout: diff ?? '', stderr: diffStatus === 0 ? '' : 'gh pr diff 失败' }
    }
    return { status: 1, stdout: '', stderr: `未预期的 gh 调用: ${args.join(' ')}` }
  }
  return { runner, calls }
}

const VIEW_OK = {
  number: 7,
  headRefOid: SHA,
  baseRefName: 'main',
  files: [{ path: 'lib/a.mjs' }, { path: 'test/a.test.mjs' }],
}

function requestPath(root, pr = 7) {
  return join(root, '.tmp', 'review', String(pr), 'request.json')
}

/** 按 prepare 的产物形状写请求文件（写到 pr=7 的默认路径，内容字段可覆盖）。 */
function writeRequest(root, overrides = {}) {
  const file = requestPath(root, 7)
  mkdirSync(join(root, '.tmp', 'review', '7'), { recursive: true })
  writeFileSync(
    file,
    JSON.stringify({
      pr: 7,
      head_sha: SHA,
      round: 1,
      nonce: NONCE,
      model: null,
      provider: null,
      form: null,
      files: ['lib/a.mjs'],
      diff: DIFF,
      ...overrides,
    }),
    'utf8',
  )
  return file
}

function writeResponse(root, text) {
  const file = join(root, 'response.txt')
  writeFileSync(file, text, 'utf8')
  return file
}

function reviewText(verdict, sha, nonce = NONCE) {
  return ['分析：变更符合验收依据。', `${nonce} VERDICT: ${verdict} SHA: ${sha}`, ''].join('\n')
}

// ---------- prepare ----------

test('review prepare：生成请求 JSON，nonce/head/files 正确，stdout 正好三行', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  const code = run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner, cwd: '/别的目录' })
  assert.equal(code, 0, io.state.err)

  const file = requestPath(root)
  const request = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(request.pr, 7)
  assert.equal(request.head_sha, SHA)
  assert.equal(request.round, 1)
  assert.match(request.nonce, NONCE_PATTERN)
  assert.equal(request.nonce.length, 12)
  assert.equal(request.model, null)
  assert.equal(request.provider, null)
  assert.equal(request.form, null)
  assert.deepEqual(request.files, ['lib/a.mjs', 'test/a.test.mjs'])
  assert.equal(request.diff, DIFF)

  const lines = io.state.out.trim().split('\n')
  assert.equal(lines.length, 3, `stdout 应正好三行，实际: ${io.state.out}`)
  assert.equal(lines[0], `请求文件: ${file}`)
  assert.equal(lines[1], `nonce: ${request.nonce}`)
  assert.equal(lines[2], `head: ${SHA.slice(0, 7)}`)
  assert.equal(io.state.err, '')

  // 外部调用只走 gh：一次 pr view（head + 改动文件），一次 pr diff
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 3)),
    [
      ['pr', 'view', '7'],
      ['pr', 'diff', '7'],
    ],
  )
  assert.deepEqual(calls[0].args.slice(3, 6), ['--repo', 'owner/repo', '--json'])
  assert.ok(calls[0].args[6].includes('headRefOid'), 'pr view 应请求 headRefOid')
  assert.ok(calls[0].args[6].includes('files'), 'pr view 应请求改动文件')
  assert.deepEqual(calls[1].args.slice(3), ['--repo', 'owner/repo'])

  // nonce 一次性：再跑一次必须换一个标记
  const again = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], again, { runner, cwd: root }), 0)
  const second = JSON.parse(readFileSync(file, 'utf8'))
  assert.notEqual(second.nonce, request.nonce)
})

test('review prepare：gh 没给 files 时从 diff 头还原改动文件，不让 files 空着', () => {
  const root = makeRoot()
  const { runner } = ghRunner({
    view: { number: 7, headRefOid: SHA },
    diff: 'diff --git a/x/y.js b/x/y.js\n--- a/x/y.js\n+++ b/x/y.js\n+1\n',
  })
  const io = makeIO()

  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner }), 0, io.state.err)
  assert.deepEqual(JSON.parse(readFileSync(requestPath(root), 'utf8')).files, ['x/y.js'])
})

test('review prepare：缺 --pr 报错退出 2，不发 gh 也不写文件', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  assert.equal(run(['review', 'prepare', '--root', root], io, { runner }), 2)
  assert.match(io.state.err, /缺少必填参数 --pr/)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(join(root, '.tmp')), false)
  assert.equal(io.state.out, '')
})

test('review prepare：--round / --model / --out 生效，缺省 root 取 cwd', () => {
  const root = makeRoot()
  const out = join(root, 'custom-request.json')
  const { runner } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  const code = run(
    ['review', 'prepare', '--pr', '7', '--round', '2', '--model', 'mimo-x', '--out', out],
    io,
    { runner, cwd: root },
  )
  assert.equal(code, 0, io.state.err)

  const request = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(request.round, 2)
  assert.equal(request.model, 'mimo-x')
  assert.equal(existsSync(requestPath(root)), false, '--out 指定后不再写默认路径')
  assert.match(io.state.out, new RegExp(`请求文件: ${out}`))
})

test('review prepare：未配置 repo 时退出 2，一个 gh 命令都不发', () => {
  const root = makeRoot({ repo: null })
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner }), 2)
  assert.match(io.state.err, /未配置仓库标识/)
  assert.equal(calls.length, 0)
})

test('review prepare：读不到 PR 或 diff 时退出 2，不写请求文件', () => {
  const root = makeRoot()
  const failing = ghRunner({ view: VIEW_OK, diff: DIFF, viewStatus: 1 })
  const io = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner: failing.runner }), 2)
  assert.match(io.state.err, /无法读取 PR #7/)
  assert.equal(existsSync(requestPath(root)), false)

  const diffFailing = ghRunner({ view: VIEW_OK, diff: DIFF, diffStatus: 1 })
  const io2 = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io2, { runner: diffFailing.runner }), 2)
  assert.match(io2.state.err, /diff/)
  assert.equal(existsSync(requestPath(root)), false)
})

// ---------- publish ----------

test('review publish：按默认路径读请求并落盘，轮次与提供方取自请求', () => {
  const root = makeRoot()
  writeRequest(root, { round: 2, provider: 'codebuddy', form: 'plugin' })
  const response = writeResponse(root, reviewText('APPROVE', SHA))
  const io = makeIO()

  const code = run(['review', 'publish', '--pr', '7', '--response', response, '--root', root], io, { cwd: root })
  assert.equal(code, 0, io.state.err)
  assert.match(io.state.out, /已写入审核记录: /)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.pr, 7)
  assert.equal(saved.round, 2)
  assert.equal(saved.verdict, 'APPROVE')
  assert.equal(saved.head_sha, SHA)
  assert.equal(saved.nonce, NONCE)
  assert.equal(saved.provider, 'codebuddy')
  assert.equal(saved.form, 'plugin')
})

test('review publish：--provider / --form / --model 覆盖请求里的值', () => {
  const root = makeRoot()
  writeRequest(root, { provider: 'codebuddy', form: 'plugin', model: '请求里的模型' })
  const response = writeResponse(root, reviewText('APPROVE', SHA))
  const io = makeIO()

  const code = run(
    [
      'review',
      'publish',
      '--pr',
      '7',
      '--response',
      response,
      '--root',
      root,
      '--provider',
      'openai',
      '--form',
      'cli',
      '--model',
      '覆盖模型',
    ],
    io,
    { cwd: root },
  )
  assert.equal(code, 0, io.state.err)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.provider, 'openai')
  assert.equal(saved.form, 'cli')
  assert.equal(saved.model, '覆盖模型')
})

test('review publish：判定行 nonce 与请求不符时仍落 ESCALATE/E_PARSE，退出 1', () => {
  const root = makeRoot()
  writeRequest(root)
  const response = writeResponse(root, reviewText('APPROVE', SHA, 'ZZZZZZZZZZZZ'))
  const io = makeIO()

  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root], io, { cwd: root }),
    1,
  )
  assert.match(io.state.err, /E_PARSE/)
  assert.match(io.state.err, /已按 ESCALATE 落盘/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_PARSE')
  assert.equal(saved.round, 1)
})

test('review publish：--round 与请求里的轮次不一致时报错退出 2，不落盘', () => {
  const root = makeRoot()
  writeRequest(root, { round: 1 })
  const response = writeResponse(root, reviewText('APPROVE', SHA))
  const io = makeIO()

  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root, '--round', '2'], io, {
      cwd: root,
    }),
    2,
  )
  assert.match(io.state.err, /轮次/)
  assert.equal(existsSync(reviewsDir(root)), false, '轮次对不上时不能落任何记录')

  // 轮次一致时照常落盘
  const ok = makeIO()
  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root, '--round', '1'], ok, {
      cwd: root,
    }),
    0,
    ok.state.err,
  )
  assert.equal(readRecord(recordFile(reviewsDir(root), 7, SHA)).round, 1)
})

test('review publish：响应缺判定行时仍落 ESCALATE/E_PARSE，退出 1', () => {
  const root = makeRoot()
  writeRequest(root)
  const response = writeResponse(root, '只有分析，没有判定行。')
  const io = makeIO()

  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root], io, { cwd: root }),
    1,
  )
  assert.match(io.state.err, /E_PARSE/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_PARSE')
  assert.deepEqual(saved.findings, [])
})

test('review publish：判定 sha 与请求不符时仍落 ESCALATE/E_SHA_MISMATCH，退出 1', () => {
  const root = makeRoot()
  writeRequest(root)
  const response = writeResponse(root, reviewText('APPROVE', OTHER_SHA))
  const io = makeIO()

  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root], io, { cwd: root }),
    1,
  )
  assert.match(io.state.err, /E_SHA_MISMATCH/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_SHA_MISMATCH')
  assert.equal(saved.head_sha, SHA)
})

test('review publish：参数校验一律退出 2，且不产生任何记录', () => {
  const root = makeRoot()
  writeRequest(root, { pr: 8 })
  const response = writeResponse(root, reviewText('APPROVE', SHA))

  const missingPr = makeIO()
  assert.equal(run(['review', 'publish', '--response', response, '--root', root], missingPr, { cwd: root }), 2)
  assert.match(missingPr.state.err, /缺少必填参数 --pr/)

  const missingResponse = makeIO()
  assert.equal(run(['review', 'publish', '--pr', '7', '--root', root], missingResponse, { cwd: root }), 2)
  assert.match(missingResponse.state.err, /缺少必填参数 --response/)

  const unknownFlag = makeIO()
  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root, '--json'], unknownFlag, {
      cwd: root,
    }),
    2,
  )
  assert.match(unknownFlag.state.err, /未知选项: --json/)

  const noRequest = makeIO()
  assert.equal(
    run(
      ['review', 'publish', '--pr', '9', '--response', response, '--root', mkdtempSync(join(tmpdir(), 'dsh-review-'))],
      noRequest,
      { cwd: root },
    ),
    2,
  )
  assert.match(noRequest.state.err, /无法读取请求文件/)

  const prMismatch = makeIO()
  assert.equal(
    run(['review', 'publish', '--pr', '7', '--response', response, '--root', root], prMismatch, { cwd: root }),
    2,
  )
  assert.match(prMismatch.state.err, /与请求中的 pr 8 不符/)

  assert.equal(existsSync(reviewsDir(root)), false, '参数错误时不许留下半条记录')
})

// ---------- 动作分发 ----------

test('review：缺动作、-- 开头的动作与未知动作一律退出 2', () => {
  const io = makeIO()
  assert.equal(run(['review'], io), 2)
  assert.match(io.state.err, /review <prepare\|publish>/)

  const flagFirst = makeIO()
  assert.equal(run(['review', '--pr', '7'], flagFirst), 2)
  assert.match(flagFirst.state.err, /review <prepare\|publish>/)

  const unknown = makeIO()
  assert.equal(run(['review', 'publishx'], unknown), 2)
  assert.match(unknown.state.err, /未知动作: publishx/)
})

test('review prepare：--pr 非法与未知选项退出 2', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })

  const badPr = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '0', '--root', root], badPr, { runner }), 2)
  assert.match(badPr.state.err, /--pr 必须是正整数/)

  const unknown = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root, '--findings', 'x'], unknown, { runner }), 2)
  assert.match(unknown.state.err, /未知选项: --findings/)

  const badRound = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root, '--round', '9'], badRound, { runner }), 2)
  assert.match(badRound.state.err, /--round 必须是 1\.\.3/)

  assert.equal(calls.length, 0, '参数没过校验时不许发 gh')
})
