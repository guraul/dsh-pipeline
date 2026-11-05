/**
 * review 子命令（prepare / publish / prompt）的行为测试。
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

/** 假 gh：pr view / pr diff / issue view 各给一份预设输出，其余命令一律失败。 */
function ghRunner({ view, diff, issue, viewStatus = 0, diffStatus = 0, issueStatus = 0 } = {}) {
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
    if (args[0] === 'issue' && args[1] === 'view') {
      return {
        status: issueStatus,
        stdout: JSON.stringify(issue ?? null),
        stderr: issueStatus === 0 ? '' : 'gh issue view 失败',
      }
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
  const { runner, calls } = ghRunner({
    view: { ...VIEW_OK, body: '背景说明\n\nCloses #42\n' },
    diff: DIFF,
    issue: { number: 42, title: '补回 issue 正文', body: '验收：reviewer 必须能看到这段' },
  })
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
  assert.deepEqual(request.issue, { number: 42, title: '补回 issue 正文', body: '验收：reviewer 必须能看到这段' })

  const lines = io.state.out.trim().split('\n')
  assert.equal(lines.length, 3, `取到 issue 正文时 stdout 应正好三行，实际: ${io.state.out}`)
  assert.equal(lines[0], `请求文件: ${file}`)
  assert.equal(lines[1], `nonce: ${request.nonce}`)
  assert.equal(lines[2], `head: ${SHA.slice(0, 7)}`)
  assert.equal(io.state.err, '')

  // 外部调用只走 gh：一次 pr view（head + 改动文件 + 正文），一次 pr diff，一次 issue view
  assert.deepEqual(
    calls.map((call) => call.args.slice(0, 3)),
    [
      ['pr', 'view', '7'],
      ['pr', 'diff', '7'],
      ['issue', 'view', '42'],
    ],
  )
  assert.deepEqual(calls[0].args.slice(3, 6), ['--repo', 'owner/repo', '--json'])
  assert.ok(calls[0].args[6].includes('headRefOid'), 'pr view 应请求 headRefOid')
  assert.ok(calls[0].args[6].includes('files'), 'pr view 应请求改动文件')
  assert.ok(calls[0].args[6].includes('body'), 'pr view 应请求 PR 正文（自动探测 issue 号用）')
  assert.deepEqual(calls[1].args.slice(3), ['--repo', 'owner/repo'])
  assert.deepEqual(calls[2].args.slice(3), ['--repo', 'owner/repo', '--json', 'number,title,state,url,body'])

  // nonce 一次性：再跑一次必须换一个标记
  const again = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], again, { runner, cwd: root }), 0)
  const second = JSON.parse(readFileSync(file, 'utf8'))
  assert.notEqual(second.nonce, request.nonce)
})

test('review prepare：--issue 显式指定时取该 issue 正文写进请求', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({
    view: VIEW_OK, // 正文里没有关闭关键字，只有显式 --issue 能取到号
    diff: DIFF,
    issue: { number: 42, title: '补回 issue 正文', body: '验收标准甲' },
  })
  const io = makeIO()

  const code = run(['review', 'prepare', '--pr', '7', '--issue', '42', '--root', root], io, { runner })
  assert.equal(code, 0, io.state.err)

  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.deepEqual(request.issue, { number: 42, title: '补回 issue 正文', body: '验收标准甲' })

  const lines = io.state.out.trim().split('\n')
  assert.equal(lines.length, 3, `取到 issue 正文时不该有提示行，实际: ${io.state.out}`)
  assert.equal(io.state.out.includes('未取到 issue 正文'), false)

  const issueCall = calls.find((call) => call.args[0] === 'issue')
  assert.ok(issueCall, '应发出 gh issue view')
  assert.deepEqual(issueCall.args, [
    'issue',
    'view',
    '42',
    '--repo',
    'owner/repo',
    '--json',
    'number,title,state,url,body',
  ])
})

test('review prepare：PR 正文里形如 Closes #N 的行自动探测 issue 号（取第一个号）', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({
    view: { ...VIEW_OK, body: '相关讨论见 #99\n\n这行没有关闭关键字 #88\nCloses #55 与 Fixes #34\n' },
    diff: DIFF,
    issue: { number: 55, title: '自动探测', body: '验收标准乙' },
  })
  const io = makeIO()

  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner }), 0, io.state.err)

  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.deepEqual(request.issue, { number: 55, title: '自动探测', body: '验收标准乙' })
  assert.equal(io.state.out.includes('未取到 issue 正文'), false, '探测成功不该有提示行')

  const issueCall = calls.find((call) => call.args[0] === 'issue')
  assert.ok(issueCall, '应发出 gh issue view')
  assert.deepEqual(issueCall.args.slice(0, 3), ['issue', 'view', '55'])
})

test('review prepare：探测不到 issue 号时不写该字段，退出 0 且补一行提示', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: { ...VIEW_OK, body: '本 PR 不关联任何 issue' }, diff: DIFF })
  const io = makeIO()

  const code = run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner })
  assert.equal(code, 0, io.state.err)
  assert.equal(io.state.err, '')

  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.equal('issue' in request, false, '取不到就不该有 issue 字段')
  assert.equal(calls.some((call) => call.args[0] === 'issue'), false, '没探测到号就不该发 issue view')

  const lines = io.state.out.trim().split('\n')
  assert.equal(lines.length, 4, `应为三行 + 一行提示，实际: ${io.state.out}`)
  assert.equal(lines[3], '提示: 未取到 issue 正文（reviewer 的验收依据会是空的）')
})

test('review prepare：gh issue view 失败不阻断，请求照常产出并提示', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({
    view: { ...VIEW_OK, body: 'Closes #42' },
    diff: DIFF,
    issueStatus: 1,
  })
  const io = makeIO()

  const code = run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner })
  assert.equal(code, 0, `gh 取 issue 失败不该阻断: ${io.state.err}`)
  assert.equal(existsSync(requestPath(root)), true, '请求文件照常产出')

  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.equal(request.pr, 7)
  assert.equal('issue' in request, false, 'gh 失败时不写 issue 字段')
  assert.ok(calls.some((call) => call.args[0] === 'issue'), '探测到号后确实尝试过 issue view')

  const lines = io.state.out.trim().split('\n')
  assert.equal(lines.length, 4, `应为三行 + 一行提示，实际: ${io.state.out}`)
  assert.equal(lines[3], '提示: 未取到 issue 正文（reviewer 的验收依据会是空的）')
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

test('review prepare：只有 diff --git 头的 diff（纯重命名 / 二进制）也能解析出路径', () => {
  const renamed = makeRoot()
  const renameRunner = ghRunner({
    view: { number: 7, headRefOid: SHA },
    diff:
      'diff --git a/lib/old.mjs b/lib/new.mjs\nsimilarity index 100%\nrename from lib/old.mjs\nrename to lib/new.mjs\n',
  })
  const renameIO = makeIO()

  assert.equal(
    run(['review', 'prepare', '--pr', '7', '--root', renamed], renameIO, { runner: renameRunner.runner }),
    0,
    renameIO.state.err,
  )
  assert.deepEqual(JSON.parse(readFileSync(requestPath(renamed), 'utf8')).files, ['lib/new.mjs'])

  const binary = makeRoot()
  const binaryRunner = ghRunner({
    view: { number: 7, headRefOid: SHA },
    diff: 'diff --git a/img/logo.png b/img/logo.png\nnew file mode 100644\nindex 0000000..abcd1234\nBinary files /dev/null and b/img/logo.png differ\n',
  })
  const binaryIO = makeIO()

  assert.equal(
    run(['review', 'prepare', '--pr', '7', '--root', binary], binaryIO, { runner: binaryRunner.runner }),
    0,
    binaryIO.state.err,
  )
  assert.deepEqual(JSON.parse(readFileSync(requestPath(binary), 'utf8')).files, ['img/logo.png'])
})

test('review prepare：diff 非空却解析不出改动文件时退出 2，不写 request.json', () => {
  const root = makeRoot()
  const { runner } = ghRunner({ view: { number: 7, headRefOid: SHA }, diff: '没有文件头的正文\n+1\n' })
  const io = makeIO()

  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], io, { runner }), 2)
  assert.match(io.state.err, /无法从 diff 解析改动文件/)
  assert.match(io.state.err, /拒绝写出空 files 的请求/)
  assert.equal(io.state.out, '')
  assert.equal(existsSync(requestPath(root)), false, '解析不出改动文件时不许落 request.json')
  assert.equal(existsSync(join(root, '.tmp')), false, '连 .tmp 目录都不该创建')
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

test('review prepare：--facts 写进请求的 facts 字段，缺省不加该字段', () => {
  const root = makeRoot()
  const factsFile = join(root, 'facts.txt')
  writeFileSync(factsFile, '背景：本 PR 只改 CLI 与测试。\n第二行事实。', 'utf8')
  const { runner } = ghRunner({ view: VIEW_OK, diff: DIFF })

  const withFacts = makeIO()
  assert.equal(
    run(['review', 'prepare', '--pr', '7', '--root', root, '--facts', factsFile], withFacts, { runner }),
    0,
    withFacts.state.err,
  )
  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.equal(request.facts, '背景：本 PR 只改 CLI 与测试。\n第二行事实。')

  const withoutFacts = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root], withoutFacts, { runner }), 0)
  const plain = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.equal('facts' in plain, false, '没给 --facts 时请求里不该有 facts 字段')
})

test('review prepare：--include 多路径逐个读入，path 保持调用方给的原样', () => {
  const root = makeRoot()
  writeFileSync(join(root, 'spec.md'), '# 规格\n- A\n', 'utf8')
  writeFileSync(join(root, 'notes.txt'), '备注内容', 'utf8')
  const { runner } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  const code = run(
    ['review', 'prepare', '--pr', '7', '--root', root, '--include', `${join(root, 'spec.md')},${join(root, 'notes.txt')}`],
    io,
    { runner },
  )
  assert.equal(code, 0, io.state.err)

  const request = JSON.parse(readFileSync(requestPath(root), 'utf8'))
  assert.deepEqual(request.includes, [
    { path: join(root, 'spec.md'), content: '# 规格\n- A\n' },
    { path: join(root, 'notes.txt'), content: '备注内容' },
  ])
  assert.equal('facts' in request, false, '没给 --facts 时不该有 facts 字段')
})

test('review prepare：--include 有路径读不到时退出 2，不发 gh 也不写请求文件', () => {
  const root = makeRoot()
  const exists = join(root, 'exists.txt')
  writeFileSync(exists, '存在', 'utf8')
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  const code = run(
    ['review', 'prepare', '--pr', '7', '--root', root, '--include', `${exists},${join(root, 'missing.txt')}`],
    io,
    { runner },
  )
  assert.equal(code, 2)
  assert.match(io.state.err, /--include 指定的文件读不到/)
  assert.match(io.state.err, /missing\.txt/)
  assert.equal(io.state.out, '')
  assert.equal(calls.length, 0, '证据读不到时一个 gh 命令都不该发')
  assert.equal(existsSync(requestPath(root)), false, '读不到文件时不许落 request.json')
  assert.equal(existsSync(join(root, '.tmp')), false, '连 .tmp 目录都不该创建')
})

test('review prepare：--include= 空值退出 2，不发 gh 也不写请求文件', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })

  for (const empty of ['', ',,,']) {
    const io = makeIO()
    const code = run(['review', 'prepare', '--pr', '7', '--root', root, `--include=${empty}`], io, { runner })
    assert.equal(code, 2, `--include=${empty} 应退出 2，实际 ${code}`)
    assert.match(io.state.err, /--include 需要一个或多个文件路径/)
    assert.equal(io.state.out, '')
    assert.equal(existsSync(requestPath(root)), false)
  }
  assert.equal(calls.length, 0, '参数没过校验时不许发 gh')
  assert.equal(existsSync(join(root, '.tmp')), false)
})

test('review prepare：--facts 文件读不到时退出 2，不发 gh 也不写请求文件', () => {
  const root = makeRoot()
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })
  const io = makeIO()

  const code = run(
    ['review', 'prepare', '--pr', '7', '--root', root, '--facts', join(root, 'no-such-facts.txt')],
    io,
    { runner },
  )
  assert.equal(code, 2)
  assert.match(io.state.err, /--facts 指定的文件读不到/)
  assert.equal(calls.length, 0)
  assert.equal(existsSync(requestPath(root)), false)
})

test('review prepare：--include 重复路径去重，只留首见条目且保持首次出现的顺序', () => {
  const root = makeRoot()
  const a = join(root, 'a.txt')
  const b = join(root, 'b.txt')
  writeFileSync(a, '甲内容', 'utf8')
  writeFileSync(b, '乙内容', 'utf8')
  const { runner } = ghRunner({ view: VIEW_OK, diff: DIFF })

  const repeated = makeIO()
  const code = run(
    ['review', 'prepare', '--pr', '7', '--root', root, '--include', `${a},${b},${a},${b}`],
    repeated,
    { runner },
  )
  assert.equal(code, 0, repeated.state.err)
  assert.deepEqual(
    JSON.parse(readFileSync(requestPath(root), 'utf8')).includes,
    [
      { path: a, content: '甲内容' },
      { path: b, content: '乙内容' },
    ],
    '重复路径应只留首见条目且保持首次出现的顺序',
  )

  const duplicated = makeIO()
  const code2 = run(['review', 'prepare', '--pr', '7', '--root', root, '--include', `${a},${a}`], duplicated, {
    runner,
  })
  assert.equal(code2, 0, duplicated.state.err)
  assert.deepEqual(JSON.parse(readFileSync(requestPath(root), 'utf8')).includes, [
    { path: a, content: '甲内容' },
  ])
})

test('review prepare：--facts / --include 指向空文件或纯空白文件时退出 2，不发 gh 也不写请求文件', () => {
  const root = makeRoot()
  const emptyFile = join(root, 'empty.txt')
  const blankFile = join(root, 'blank.txt')
  writeFileSync(emptyFile, '', 'utf8')
  writeFileSync(blankFile, '  \n\t \n', 'utf8')
  const { runner, calls } = ghRunner({ view: VIEW_OK, diff: DIFF })

  for (const flag of ['--facts', '--include']) {
    for (const file of [emptyFile, blankFile]) {
      const io = makeIO()
      const code = run(['review', 'prepare', '--pr', '7', '--root', root, flag, file], io, { runner })
      assert.equal(code, 2, `${flag} 指向 ${file} 应退出 2，实际 ${code}`)
      assert.match(io.state.err, new RegExp(`${flag} 指定的文件内容为空`))
      assert.equal(io.state.out, '')
      assert.equal(existsSync(requestPath(root)), false, '内容为空时不许落 request.json')
    }
  }
  assert.equal(calls.length, 0, '证据内容为空时一个 gh 命令都不该发')
  assert.equal(existsSync(join(root, '.tmp')), false, '连 .tmp 目录都不该创建')
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

// ---------- prompt ----------

test('review prompt：未给 --out 时提示词打到 stdout，退出 0', () => {
  const root = makeRoot()
  const file = writeRequest(root, {
    facts: '事实甲：本 PR 只改 CLI 与测试',
    includes: [{ path: 'docs/spec.md', content: '随附正文不该出现在提示词里' }],
  })
  const io = makeIO()

  const code = run(['review', 'prompt', '--request', file], io, { cwd: root })
  assert.equal(code, 0, io.state.err)
  assert.equal(io.state.err, '')

  const out = io.state.out
  assert.ok(out.includes('<<<DIFF_BEGIN'))
  assert.ok(out.includes('<<<DIFF_END>>>'))
  assert.ok(out.includes('证据包（控制面补充的事实，可信）:'))
  assert.ok(out.includes('事实甲：本 PR 只改 CLI 与测试'))
  assert.ok(out.includes('随附文件: docs/spec.md'))
  assert.ok(!out.includes('随附正文不该出现在提示词里'), '随附文件只列路径，不贴内容')
  assert.ok(out.includes(`${NONCE} VERDICT: <APPROVE|REJECT|ESCALATE> SHA: ${SHA}`))
})

test('review prompt：--out 写文件并打印「已写入 <路径>」', () => {
  const root = makeRoot()
  const file = writeRequest(root)
  const out = join(root, 'nested', 'prompt.md')
  const io = makeIO()

  const code = run(['review', 'prompt', '--request', file, '--out', out], io, { cwd: root })
  assert.equal(code, 0, io.state.err)
  assert.equal(io.state.out.trim(), `已写入 ${out}`)
  assert.equal(io.state.err, '')

  const written = readFileSync(out, 'utf8')
  assert.ok(written.includes('<<<DIFF_BEGIN'))
  assert.ok(written.includes('输出要求（必须逐字遵守）:'))
})

test('review prompt：缺 --request 退出 2，不读文件也不写提示词', () => {
  const root = makeRoot()
  writeRequest(root)

  const missing = makeIO()
  assert.equal(run(['review', 'prompt'], missing, { cwd: root }), 2)
  assert.match(missing.state.err, /缺少必填参数 --request/)
  assert.equal(missing.state.out, '')

  const empty = makeIO()
  assert.equal(run(['review', 'prompt', '--request', ''], empty, { cwd: root }), 2)
  assert.match(empty.state.err, /缺少必填参数 --request/)

  const out = join(root, 'never.md')
  const withOut = makeIO()
  assert.equal(run(['review', 'prompt', '--out', out], withOut, { cwd: root }), 2)
  assert.match(withOut.state.err, /缺少必填参数 --request/)
  assert.equal(existsSync(out), false, '参数没过校验时不许写文件')
})

test('review prompt：请求没有 facts/includes 时不出现那两段', () => {
  const root = makeRoot()
  const plain = writeRequest(root)
  const io = makeIO()

  assert.equal(run(['review', 'prompt', '--request', plain], io, { cwd: root }), 0, io.state.err)
  assert.ok(!io.state.out.includes('证据包（控制面补充的事实，可信）:'))
  assert.ok(!io.state.out.includes('随附文件:'))
  assert.ok(io.state.out.includes('<<<DIFF_END>>>'))
  assert.ok(io.state.out.includes('输出要求（必须逐字遵守）:'))
})

test('review prompt：有 facts 时两段排在 diff 之后、输出要求之前', () => {
  const root = makeRoot()
  const file = writeRequest(root, {
    facts: '事实甲',
    includes: [
      { path: 'docs/spec.md', content: 'x' },
      { path: 'docs/api.md', content: 'y' },
    ],
  })
  const io = makeIO()

  assert.equal(run(['review', 'prompt', '--request', file], io, { cwd: root }), 0, io.state.err)
  const out = io.state.out
  const diffEnd = out.indexOf('<<<DIFF_END>>>')
  const facts = out.indexOf('证据包（控制面补充的事实，可信）:')
  const includes = out.indexOf('随附文件: docs/spec.md, docs/api.md')
  const output = out.indexOf('输出要求（必须逐字遵守）:')
  assert.ok(diffEnd !== -1 && facts !== -1 && includes !== -1 && output !== -1)
  assert.ok(diffEnd < facts, '证据包必须排在 diff 之后')
  assert.ok(facts < includes, '随附文件排在证据包之后')
  assert.ok(includes < output, '两段都必须排在输出要求之前')
})

test('review prompt：--role 取仓库配置里该角色的 instructions，未知角色退出 2', () => {
  const root = makeRoot()
  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    JSON.stringify({ repo: 'owner/repo', roles: { reviewer: { instructions: '按验收依据逐条核对' } } }),
    'utf8',
  )
  const file = writeRequest(root)

  const ok = makeIO()
  assert.equal(
    run(['review', 'prompt', '--request', file, '--role', 'reviewer'], ok, { cwd: root }),
    0,
    ok.state.err,
  )
  assert.ok(ok.state.out.includes('按验收依据逐条核对'))

  const bad = makeIO()
  assert.equal(run(['review', 'prompt', '--request', file, '--role', 'admin'], bad, { cwd: root }), 2)
  assert.match(bad.state.err, /未知角色: admin/)
  assert.equal(bad.state.out, '')
})

test('review prompt：请求带 issue 正文时渲染验收依据段，取不到时输出 (空)', () => {
  const root = makeRoot()
  const heading = '验收依据（issue 正文）:'

  const withIssue = writeRequest(root, { issue: { number: 42, title: '补回 issue 正文', body: '验收标准甲' } })
  const ok = makeIO()
  assert.equal(run(['review', 'prompt', '--request', withIssue], ok, { cwd: root }), 0, ok.state.err)
  assert.ok(ok.state.out.includes(`${heading}\n验收标准甲`), `应贴进 issue 正文，实际:\n${ok.state.out}`)

  const withoutIssue = writeRequest(root)
  const empty = makeIO()
  assert.equal(run(['review', 'prompt', '--request', withoutIssue], empty, { cwd: root }), 0, empty.state.err)
  assert.ok(empty.state.out.includes(`${heading}\n(空)`), `没有 issue 正文时应输出 (空)，实际:\n${empty.state.out}`)
  assert.equal(empty.state.out.includes('验收标准甲'), false)
})

test('review prompt：请求缺 nonce 或 head_sha 时退出 2，提示缺哪个字段且不渲染提示词', () => {
  const root = makeRoot()
  const base = { pr: 7, round: 1, model: null, provider: null, form: null, files: ['lib/a.mjs'], diff: DIFF }
  const noNonce = join(root, 'req-no-nonce.json')
  const noSha = join(root, 'req-no-head-sha.json')
  writeFileSync(noNonce, JSON.stringify({ ...base, head_sha: SHA }), 'utf8')
  writeFileSync(noSha, JSON.stringify({ ...base, nonce: NONCE }), 'utf8')

  const nonceIO = makeIO()
  assert.equal(run(['review', 'prompt', '--request', noNonce], nonceIO, { cwd: root }), 2)
  assert.match(nonceIO.state.err, /请求缺少字段: nonce/)
  assert.equal(nonceIO.state.out, '')

  const shaIO = makeIO()
  assert.equal(run(['review', 'prompt', '--request', noSha], shaIO, { cwd: root }), 2)
  assert.match(shaIO.state.err, /请求缺少字段: head_sha/)
  assert.equal(shaIO.state.out, '')

  const out = join(root, 'never-prompt.md')
  const withOut = makeIO()
  assert.equal(run(['review', 'prompt', '--request', noNonce, '--out', out], withOut, { cwd: root }), 2)
  assert.match(withOut.state.err, /请求缺少字段: nonce/)
  assert.equal(existsSync(out), false, '请求缺字段时不许写提示词文件')
})

// ---------- 动作分发 ----------

test('review：缺动作、-- 开头的动作与未知动作一律退出 2', () => {
  const io = makeIO()
  assert.equal(run(['review'], io), 2)
  assert.match(io.state.err, /review <prepare\|publish\|prompt>/)

  const flagFirst = makeIO()
  assert.equal(run(['review', '--pr', '7'], flagFirst), 2)
  assert.match(flagFirst.state.err, /review <prepare\|publish\|prompt>/)

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

  const badIssue = makeIO()
  assert.equal(run(['review', 'prepare', '--pr', '7', '--root', root, '--issue', 'abc'], badIssue, { runner }), 2)
  assert.match(badIssue.state.err, /--issue 必须是正整数/)
  assert.equal(badIssue.state.out, '')

  assert.equal(calls.length, 0, '参数没过校验时不许发 gh')
})
