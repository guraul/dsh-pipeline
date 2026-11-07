import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import {
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  readRecord,
  recordFile,
  reviewsDir,
  validateRecord,
  writeRecord,
} from '../lib/record.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const NONCE = 'ABCDEFGHJKLM'
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-cli-'))
}

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

function recordFor(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: PACKAGE_VERSION,
    pr: 7,
    round: 1,
    verdict: 'APPROVE',
    head_sha: SHA,
    findings: [],
    evidence: ['cmd: node --test'],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

function writeApprovedRecord(root, overrides = {}) {
  return writeRecord(reviewsDir(root), recordFor(overrides))
}

function stubRunner(root = '/repo/main') {
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    if (command === 'git') {
      // 主工作区停在 main 且干净：merge 收尾不做 checkout / 不读 status
      if (args.includes('worktree') && args.includes('--porcelain')) {
        return {
          status: 0,
          stdout: `worktree ${root}\nHEAD ${SHA}\nbranch refs/heads/main\n\n`,
          stderr: '',
        }
      }
      if (args.includes('--abbrev-ref')) return { status: 0, stdout: 'main\n', stderr: '' }
      if (args.includes('status')) return { status: 0, stdout: '', stderr: '' }
      return { status: 0, stdout: `${SHA}\n`, stderr: '' }
    }
    // gh pr view 要返回 JSON（merge 用 headRefName 定位分支），其余 gh 命令给空输出
    if (args[0] === 'pr' && args[1] === 'view') {
      return {
        status: 0,
        stdout: JSON.stringify({ headRefName: 'task/7', state: 'OPEN' }),
        stderr: '',
      }
    }
    return { status: 0, stdout: 'merged\n', stderr: '' }
  }
  return { runner, calls }
}

function withRepo(root, repo = 'owner/repo') {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify({ repo }), 'utf8')
}

function reviewText(verdict, sha, { findings = [], evidence = [] } = {}) {
  return [
    '分析：变更符合验收依据。',
    '```json',
    JSON.stringify({ findings, evidence }),
    '```',
    `${NONCE} VERDICT: ${verdict} SHA: ${sha}`,
  ].join('\n')
}

test('--help 与 --version 行为保持不变', () => {
  const help = makeIO()
  assert.equal(run(['--help'], help), 0)
  assert.match(help.state.out, /用法: dsh-pipeline/)
  assert.equal(help.state.err, '')

  const version = makeIO()
  assert.equal(run(['--version'], version), 0)
  // 版本行现在带构建标识：「0.1.0 (源码运行)」或「0.1.0 (abc1234 2026-11-03T…)」
  const line = version.state.out.trim()
  assert.ok(line.startsWith(`${PACKAGE_VERSION} (`), `版本行应以「${PACKAGE_VERSION} (」开头，实际: ${line}`)
  assert.ok(line.endsWith(')'), `版本行应以「)」结尾，实际: ${line}`)
  assert.equal(version.state.err, '')
})

test('顶层 prepare 占位已删除：未知子命令 + HELP，退出 2', () => {
  const io = makeIO()
  assert.equal(run(['prepare'], io), 2)
  assert.match(io.state.err, /未知子命令/)
  assert.match(io.state.out + io.state.err, /用法: dsh-pipeline/)
})

test('gate: 有效记录放行，退出码 0', () => {
  const root = tmp()
  const file = writeApprovedRecord(root)
  const io = makeIO()

  assert.equal(run(['gate', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io), 0)
  assert.match(io.state.out, /审核闸门: PR #7 通过/)
  assert.equal(io.state.err, '')
})

test('gate: 未传 --head-sha 时通过 git.headSha 取当前提交', () => {
  const root = tmp()
  const file = writeApprovedRecord(root)
  const io = makeIO()
  const { runner, calls } = stubRunner()

  assert.equal(run(['gate', '--pr', '7', '--root', root, '--record', file], io, { runner }), 0)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].command, 'git')
  assert.deepEqual(calls[0].args, ['-C', root, 'rev-parse', 'HEAD'])
  assert.match(io.state.out, /通过/)
})

test('gate: head 不一致时拒绝，stderr 带原因，退出码 1', () => {
  const root = tmp()
  const file = writeApprovedRecord(root, { head_sha: OTHER_SHA })
  const io = makeIO()
  const { runner, calls } = stubRunner()

  assert.equal(run(['gate', '--pr', '7', '--root', root, '--record', file], io, { runner }), 1)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].args, ['-C', root, 'rev-parse', 'HEAD'])
  assert.match(io.state.err, /^审核闸门: /m)
  assert.match(io.state.err, /判定已作废/)
  assert.equal(io.state.out, '')
})

test('gate: 过期记录拒绝，退出码 1', () => {
  const root = tmp()
  const createdAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
  const file = writeApprovedRecord(root, { createdAt })
  const io = makeIO()

  assert.equal(run(['gate', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io), 1)
  assert.match(io.state.err, /审核闸门: /)
  assert.match(io.state.err, /已过期/)
})

test('gate: 记录 PR 与 --pr 不符时拒绝', () => {
  const root = tmp()
  const file = writeRecord(reviewsDir(root), recordFor({ pr: 8 }))
  const io = makeIO()

  assert.equal(run(['gate', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io), 1)
  assert.match(io.state.err, /记录属于 PR #8，与 --pr #7 不符/)
})

test('gate: 缺记录且未跳过时 fail-closed，退出码 1', () => {
  const root = tmp()
  const io = makeIO()

  assert.equal(run(['gate', '--pr', '7', '--root', root], io), 1)
  assert.match(io.state.err, /审核闸门: /)
  assert.match(io.state.err, /失败关闭/)
  assert.equal(io.state.out, '')
})

test('gate: --no-review 写入跳过审计并警告，退出码 0', () => {
  const root = tmp()
  const io = makeIO()
  const reason = '紧急回滚，已人工确认'
  const { runner, calls } = stubRunner()

  assert.equal(
    run(['gate', '--pr', '7', '--root', root, '--no-review', '--reason', reason], io, { runner }),
    0,
  )
  assert.equal(calls.length, 0)
  assert.match(io.state.err, /警告: PR #7 已跳过审核/)
  assert.match(io.state.err, /审计记录: /)

  const skipDir = join(reviewsDir(root), 'skips')
  const files = readdirSync(skipDir).filter((name) => name.endsWith('.json'))
  assert.equal(files.length, 1)
  const audit = JSON.parse(readFileSync(join(skipDir, files[0]), 'utf8'))
  assert.equal(audit.pr, 7)
  assert.equal(audit.head_sha, null)
  assert.equal(audit.reason, reason)
  assert.equal(audit.policyVersion, PACKAGE_VERSION)
})

test('merge: 闸门通过后调用 gh pr merge 且固定 --squash，随后清理现场', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root)
  const io = makeIO()
  const { runner, calls } = stubRunner(root)

  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io, { runner }),
    0,
  )
  assert.match(io.state.out, /已合并 PR #7（--squash）/)

  const merge = calls.filter((call) => call.command === 'gh' && call.args[1] === 'merge')
  assert.equal(merge.length, 1)
  assert.deepEqual(merge[0].args, ['pr', 'merge', '7', '--repo', 'owner/repo', '--squash'])
  assert.ok(merge[0].args.includes('--squash'))

  // 合并之后必须继续收尾：列 worktree → fetch → 快进 → 删本地分支
  const gitArgs = calls.filter((call) => call.command === 'git').map((call) => call.args.slice(2))
  assert.deepEqual(gitArgs, [
    ['worktree', 'list', '--porcelain'],
    ['fetch', '--prune', 'origin'],
    ['merge', '--ff-only', 'origin/main'],
    ['branch', '-D', '--', 'task/7'],
  ])
})

test('merge 收尾删分支透传 force：实际执行的是 branch -D（回归 #12）', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root)
  const io = makeIO()
  const { runner, calls } = stubRunner(root)

  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io, { runner }),
    0,
  )

  // 断言真实发出的 git argv，而不是 lib 层收到的 options：
  // CLI 适配层吞掉 { force: true } 时，只有这里能看出来。
  const branchCalls = calls
    .filter((call) => call.command === 'git')
    .map((call) => call.args.slice(2))
    .filter((args) => args[0] === 'branch')

  assert.deepEqual(branchCalls, [['branch', '-D', '--', 'task/7']])
})

test('merge: 闸门拒绝时不调用 gh，退出码 1', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root, { head_sha: OTHER_SHA })
  const io = makeIO()
  const { runner, calls } = stubRunner()

  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io, { runner }),
    1,
  )
  assert.equal(calls.length, 0)
  assert.match(io.state.err, /审核闸门: /)
})

test('merge: 记录通过但未配置 repo 时退出码 2', () => {
  const root = tmp()
  const file = writeApprovedRecord(root)
  const io = makeIO()
  const { runner, calls } = stubRunner()

  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--record', file, '--head-sha', SHA], io, { runner }),
    2,
  )
  assert.match(io.state.err, /未配置仓库标识/)
  assert.equal(calls.length, 0)
})

test('merge: --review-record 与 --record 等价（空格 / = 两种写法都放行合并）', () => {
  const forms = [
    (file) => ['--review-record', file],
    (file) => [`--review-record=${file}`],
    (file) => ['--record', file],
  ]
  for (const build of forms) {
    const root = tmp()
    withRepo(root)
    const file = writeApprovedRecord(root)
    const io = makeIO()
    const { runner, calls } = stubRunner(root)

    assert.equal(
      run(['merge', '--pr', '7', '--root', root, ...build(file), '--head-sha', SHA], io, { runner }),
      0,
      io.state.err,
    )
    assert.match(io.state.out, /已合并 PR #7（--squash）/)
    assert.equal(calls.filter((call) => call.command === 'gh' && call.args[1] === 'merge').length, 1)
  }
})

test('merge: --review-record 的取值就是审核记录（head 不符照样闸门拒绝）', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root, { head_sha: OTHER_SHA })
  const io = makeIO()
  const { runner, calls } = stubRunner(root)

  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--review-record', file, '--head-sha', SHA], io, { runner }),
    1,
  )
  assert.equal(calls.length, 0, '闸门拒绝时不发任何 gh / git 命令')
  assert.match(io.state.err, /判定已作废/)
})

test('merge: --record 与 --review-record 取值不同 → 退 2 报两个参数冲突', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root)
  const io = makeIO()
  const { runner, calls } = stubRunner(root)

  assert.equal(
    run(
      ['merge', '--pr', '7', '--root', root, '--record', file, '--review-record', 'other.json', '--head-sha', SHA],
      io,
      { runner },
    ),
    2,
  )
  assert.match(io.state.err, /两个参数冲突/)
  assert.equal(io.state.out, '')
  assert.equal(calls.length, 0, '参数错误不发出任何 gh / git 命令')
})

test('merge: 两个 flag 给同一取值不算冲突；--review-record 与 --no-review 仍互斥', () => {
  const root = tmp()
  withRepo(root)
  const file = writeApprovedRecord(root)

  const same = makeIO()
  const { runner } = stubRunner(root)
  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--record', file, '--review-record', file, '--head-sha', SHA], same, {
      runner,
    }),
    0,
    same.state.err,
  )
  assert.match(same.state.out, /已合并 PR #7（--squash）/)

  const denied = makeIO()
  const { runner: other, calls } = stubRunner(root)
  assert.equal(
    run(['merge', '--pr', '7', '--root', root, '--review-record', file, '--no-review', '--reason', 'x'], denied, {
      runner: other,
    }),
    2,
  )
  assert.match(denied.state.err, /不能同时使用 --record 与 --no-review/)
  assert.equal(calls.length, 0)
})

test('record: 解析响应并落盘，文件名与字段正确', () => {
  const root = tmp()
  const request = join(root, 'request.json')
  const response = join(root, 'response.txt')
  writeFileSync(
    request,
    JSON.stringify({ pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x' }),
    'utf8',
  )
  const finding = { severity: 'minor', file: 'lib/a.mjs', line: 12, message: '命名可再明确' }
  writeFileSync(
    response,
    reviewText('APPROVE', SHA, { findings: [finding], evidence: ['cmd: node --test'] }),
    'utf8',
  )

  const io = makeIO()
  const code = run(['record', '--request', request, '--response', response, '--round', '2'], io, {
    cwd: root,
  })
  assert.equal(code, 0)
  assert.match(io.state.out, /已写入审核记录: /)

  const file = recordFile(reviewsDir(root), 7, SHA)
  const saved = readRecord(file)
  assert.equal(saved.pr, 7)
  assert.equal(saved.round, 2)
  assert.equal(saved.verdict, 'APPROVE')
  assert.equal(saved.head_sha, SHA)
  assert.deepEqual(saved.findings, [finding])
  assert.deepEqual(saved.evidence, ['cmd: node --test'])
  assert.equal(saved.schemaVersion, SCHEMA_VERSION)
  assert.equal(saved.policyVersion, PACKAGE_VERSION)
  assert.ok(!Number.isNaN(Date.parse(saved.createdAt)))
})

test('record: 响应缺少判定行时落一条 ESCALATE/E_PARSE，退出码 1', () => {
  const root = tmp()
  const request = join(root, 'request.json')
  const response = join(root, 'response.txt')
  writeFileSync(request, JSON.stringify({ pr: 7, head_sha: SHA, nonce: NONCE }), 'utf8')
  writeFileSync(response, '只有分析，没有判定行。', 'utf8')

  const io = makeIO()
  assert.equal(run(['record', '--request', request, '--response', response], io, { cwd: root }), 1)
  assert.match(io.state.err, /E_PARSE/)
  assert.match(io.state.err, /判定行/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_PARSE')
  assert.equal(saved.head_sha, SHA)
  assert.deepEqual(saved.findings, [])
  assert.equal(saved.evidence.length, 1)
  assert.match(saved.evidence[0], /判定行/)
})

test('record: 响应有两个判定行时落一条 ESCALATE/E_PARSE，退出码 1', () => {
  const root = tmp()
  const lines = [
    `${NONCE} VERDICT: APPROVE SHA: ${SHA}`,
    `${NONCE} VERDICT: REJECT SHA: ${SHA}`,
  ].join('\n')
  const inputs = writeInputs(root, { pr: 7, head_sha: SHA, nonce: NONCE }, `${lines}\n`)

  const io = makeIO()
  assert.equal(
    run(['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--root', root], io, {
      cwd: root,
    }),
    1,
  )
  assert.match(io.state.err, /E_PARSE/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_PARSE')
  assert.match(saved.evidence[0], /2 条判定行/)
})

test('record: 判定 sha 与请求不一致时落 ESCALATE/E_SHA_MISMATCH，退出码 1', () => {
  const root = tmp()
  const inputs = writeInputs(
    root,
    { pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x\n+1' },
    plainReviewText('APPROVE', OTHER_SHA),
  )

  const io = makeIO()
  assert.equal(
    run(['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--root', root], io, {
      cwd: root,
    }),
    1,
  )
  assert.match(io.state.err, /E_SHA_MISMATCH/)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.verdict, 'ESCALATE')
  assert.equal(saved.errorCode, 'E_SHA_MISMATCH')
  assert.equal(saved.head_sha, SHA)
  assert.ok(saved.evidence.some((item) => item.includes(OTHER_SHA)))
})

test('record: 响应文件不存在时退出码 2 且不产生记录', () => {
  const root = tmp()
  const requestFile = join(root, 'request.json')
  writeFileSync(requestFile, JSON.stringify({ pr: 7, head_sha: SHA, nonce: NONCE }), 'utf8')

  const io = makeIO()
  const code = run(
    ['record', '--request', requestFile, '--response', join(root, 'missing.txt'), '--root', root],
    io,
    { cwd: root },
  )
  assert.equal(code, 2)
  assert.match(io.state.err, /无法读取响应文件/)
  assert.equal(existsSync(reviewsDir(root)), false)
})

/** 造一份请求 + 响应；envelope 为 true 时按插件 prepare 的 {request, stats} 写。 */
function recordInputs(dir, request, { envelope = true, verdict = 'APPROVE' } = {}) {
  const requestFile = join(dir, 'request.json')
  const responseFile = join(dir, 'response.txt')
  const diffChars = String(request.diff ?? '').length
  const payload = envelope
    ? { request, stats: { diffChars, addedLines: 1, diffSha256: 'sha256:x' } }
    : request
  writeFileSync(requestFile, JSON.stringify(payload), 'utf8')
  writeFileSync(responseFile, reviewText(verdict, request.head_sha), 'utf8')
  return { requestFile, responseFile }
}

function runRecordWith(root, request, { cwd = root, envelope = true, extra = [] } = {}) {
  const inputs = recordInputs(root, request, { envelope })
  const io = makeIO()
  const code = run(
    ['record', '--request', inputs.requestFile, '--response', inputs.responseFile, ...extra],
    io,
    { cwd },
  )
  return { code, io }
}

test('record: --root 决定落盘位置，不污染 cwd', () => {
  const root = tmp()
  const cwd = tmp()
  const request = { pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x\n+1' }

  const { code } = runRecordWith(root, request, { cwd, extra: ['--root', root] })
  assert.equal(code, 0)
  assert.ok(existsSync(recordFile(reviewsDir(root), 7, SHA)), '记录应落在 --root 下')
  assert.equal(readdirSync(cwd).includes('.dsh-web'), false, 'cwd 不该被写入运行态')
})

test('record: 缺省根目录仍是 cwd（--root 可省略）', () => {
  const cwd = tmp()
  const request = { pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x\n+1' }

  const { code } = runRecordWith(cwd, request, { cwd })
  assert.equal(code, 0)
  assert.ok(existsSync(recordFile(reviewsDir(cwd), 7, SHA)))
})

test('record: 写出的记录能通过包自己的 validateRecord', () => {
  const root = tmp()
  const request = { pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x\n+1' }

  const { code } = runRecordWith(root, request, { extra: ['--root', root, '--duration-ms', '1200'] })
  assert.equal(code, 0)

  const file = recordFile(reviewsDir(root), 7, SHA)
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  const result = validateRecord(saved)
  assert.equal(result.ok, true, `记录不合规: ${JSON.stringify(result.errors)}`)
  assert.equal(saved.schemaVersion, SCHEMA_VERSION)
  assert.equal(saved.nonce, NONCE)
  assert.equal(saved.form, 'cli')
  assert.equal(typeof saved.model, 'string')
  assert.equal(saved.durationMs, 1200)
  assert.equal(saved.request.diffChars, request.diff.length)
  assert.equal(saved.request.issue, null)
})

test('record: 信封与扁平两种请求都能处理', () => {
  const root = tmp()

  const envelope = runRecordWith(
    root,
    {
      pr: 7,
      head_sha: SHA,
      nonce: NONCE,
      diff: 'diff --git a/.env b/.env\n+A=1',
      issue: { number: 217, title: 't', body: 'b' },
    },
    { extra: ['--root', root] },
  )
  assert.equal(envelope.code, 0, envelope.io.state.err)
  const fromEnvelope = JSON.parse(readFileSync(recordFile(reviewsDir(root), 7, SHA), 'utf8'))
  assert.equal(fromEnvelope.pr, 7)
  assert.equal(fromEnvelope.request.issue, 217)

  const flatRoot = tmp()
  const flat = runRecordWith(
    flatRoot,
    {
      pr: 8,
      head_sha: OTHER_SHA,
      nonce: NONCE,
      diff: 'diff --git a/x b/x\n+1',
      issue: 219,
    },
    { envelope: false, extra: ['--root', flatRoot] },
  )
  assert.equal(flat.code, 0, flat.io.state.err)
  const fromFlat = JSON.parse(readFileSync(recordFile(reviewsDir(flatRoot), 8, OTHER_SHA), 'utf8'))
  assert.equal(fromFlat.pr, 8)
  assert.equal(fromFlat.request.issue, 219)
})

test('record: 命中 .env 高风险时 policy.hit=true、errorCode=E_POLICY，且 verdict 不变', () => {
  const root = tmp()
  const request = {
    pr: 7,
    head_sha: SHA,
    nonce: NONCE,
    files: ['.env'],
    diff: 'diff --git a/.env b/.env\n+SECRET=1\n',
  }

  const { code } = runRecordWith(root, request, { extra: ['--root', root] })
  assert.equal(code, 0)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.policy.hit, true)
  assert.ok(saved.policy.reasons.length > 0)
  assert.equal(saved.errorCode, 'E_POLICY')
  assert.equal(saved.verdict, 'APPROVE', '高风险只标注错误码，不改判定')
})

test('record: 请求没带 files 时从 diff 头还原路径，高风险不漏判', () => {
  const root = tmp()
  const request = {
    pr: 7,
    head_sha: SHA,
    nonce: NONCE,
    diff: '--- a/conf/.env.production\n+++ b/conf/.env.production\n+TOKEN=1\n',
  }

  const { code } = runRecordWith(root, request, { extra: ['--root', root] })
  assert.equal(code, 0)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.policy.hit, true)
  assert.equal(saved.errorCode, 'E_POLICY')
})

test('record: 高风险追加规则来自 <root>/.dsh/pipeline.json，policyVersion 等于 package.json 版本', () => {
  const root = tmp()
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    JSON.stringify({ repo: 'owner/repo', highRisk: ['deploy/**'] }),
    'utf8',
  )
  const request = {
    pr: 7,
    head_sha: SHA,
    nonce: NONCE,
    files: ['deploy/prod.sh'],
    diff: 'diff --git a/deploy/prod.sh b/deploy/prod.sh\n+rm -rf /\n',
  }

  const { code } = runRecordWith(root, request, { extra: ['--root', root] })
  assert.equal(code, 0)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.policy.hit, true)
  assert.ok(saved.policy.reasons.some((reason) => reason.includes('deploy/prod.sh')))
  assert.equal(saved.policyVersion, PKG.version)
  assert.equal(saved.policyVersion, PACKAGE_VERSION)
})

/** 只是分析 + 判定行，没有 ```json 块——插件薄转发时的典型响应。 */
function plainReviewText(verdict = 'APPROVE', sha = SHA) {
  return ['分析：变更符合验收依据。', `${NONCE} VERDICT: ${verdict} SHA: ${sha}`, ''].join('\n')
}

/** 直接写请求/响应文件，用于控制响应里有没有 json 块。 */
function writeInputs(dir, request, response) {
  const requestFile = join(dir, 'request.json')
  const responseFile = join(dir, 'response.txt')
  writeFileSync(requestFile, JSON.stringify(request), 'utf8')
  writeFileSync(responseFile, response, 'utf8')
  return { requestFile, responseFile }
}

const RECORD_REQUEST = { pr: 7, head_sha: SHA, nonce: NONCE, diff: 'diff --git a/x b/x\n+1' }

test('record: 响应无 ```json 块时用 --findings 兜底', () => {
  const root = tmp()
  const findings = [
    { severity: 'major', file: 'lib/a.mjs', line: 3, message: '缺少边界检查' },
  ]
  const evidence = ['cmd: node --test']
  const inputs = writeInputs(root, RECORD_REQUEST, plainReviewText())
  const findingsFile = join(root, 'findings.json')
  writeFileSync(findingsFile, JSON.stringify({ findings, evidence }), 'utf8')

  const io = makeIO()
  const code = run(
    ['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--findings', findingsFile, '--root', root],
    io,
    { cwd: root },
  )
  assert.equal(code, 0, io.state.err)

  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.deepEqual(saved.findings, findings)
  assert.deepEqual(saved.evidence, evidence)
})

test('record: --findings 文件不是合法 JSON 时退出 2 且给出中文错误', () => {
  const root = tmp()
  const inputs = writeInputs(root, RECORD_REQUEST, plainReviewText())
  const findingsFile = join(root, 'broken.json')
  writeFileSync(findingsFile, '{"findings": [', 'utf8')

  const io = makeIO()
  const code = run(
    ['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--findings', findingsFile, '--root', root],
    io,
    { cwd: root },
  )
  assert.equal(code, 2)
  assert.match(io.state.err, /findings 文件不是合法 JSON/)
  assert.doesNotMatch(io.state.err, /SyntaxError/)
  assert.equal(existsSync(reviewsDir(root)), false)
})

test('record: --findings 文件缺 findings 数组时退出 2', () => {
  const root = tmp()
  const inputs = writeInputs(root, RECORD_REQUEST, plainReviewText())
  const findingsFile = join(root, 'findings.json')
  writeFileSync(findingsFile, JSON.stringify({ evidence: ['cmd: node --test'] }), 'utf8')

  const io = makeIO()
  const code = run(
    ['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--findings', findingsFile, '--root', root],
    io,
    { cwd: root },
  )
  assert.equal(code, 2)
  assert.match(io.state.err, /缺少 findings 数组/)
  assert.equal(existsSync(reviewsDir(root)), false)
})

test('record: --provider / --form 落盘，缺省为 unknown / cli', () => {
  const root = tmp()
  const inputs = writeInputs(root, RECORD_REQUEST, plainReviewText())
  const explicit = makeIO()
  assert.equal(
    run(
      ['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--root', root, '--provider', 'codebuddy', '--form', 'plugin'],
      explicit,
      { cwd: root },
    ),
    0,
    explicit.state.err,
  )
  const saved = readRecord(recordFile(reviewsDir(root), 7, SHA))
  assert.equal(saved.provider, 'codebuddy')
  assert.equal(saved.form, 'plugin')

  const defaultRoot = tmp()
  const defaultInputs = writeInputs(defaultRoot, RECORD_REQUEST, plainReviewText())
  const io = makeIO()
  assert.equal(
    run(['record', '--request', defaultInputs.requestFile, '--response', defaultInputs.responseFile, '--root', defaultRoot], io, {
      cwd: defaultRoot,
    }),
    0,
    io.state.err,
  )
  const fallback = readRecord(recordFile(reviewsDir(defaultRoot), 7, SHA))
  assert.equal(fallback.provider, 'unknown')
  assert.equal(fallback.form, 'cli')
})

test('record: --json 输出可被 JSON.parse，含 verdict，且不打印「已写入审核记录」', () => {
  const root = tmp()
  const inputs = writeInputs(root, RECORD_REQUEST, plainReviewText('REJECT'))
  const io = makeIO()

  assert.equal(
    run(['record', '--request', inputs.requestFile, '--response', inputs.responseFile, '--root', root, '--json'], io, {
      cwd: root,
    }),
    0,
    io.state.err,
  )
  assert.doesNotMatch(io.state.out, /已写入审核记录/)

  const printed = JSON.parse(io.state.out)
  assert.equal(printed.verdict, 'REJECT')
  assert.equal(printed.pr, 7)
  assert.equal(printed.head_sha, SHA)
  assert.deepEqual(printed, JSON.parse(readFileSync(recordFile(reviewsDir(root), 7, SHA), 'utf8')))
})

test('status: 输出记录数与最近一条结论', () => {
  const root = tmp()
  writeRecord(
    reviewsDir(root),
    recordFor({ pr: 7, createdAt: '2026-10-31T10:00:00.000Z', verdict: 'APPROVE' }),
  )
  writeRecord(
    reviewsDir(root),
    recordFor({
      pr: 8,
      head_sha: OTHER_SHA,
      createdAt: '2026-10-31T12:00:00.000Z',
      verdict: 'REJECT',
    }),
  )

  const io = makeIO()
  assert.equal(run(['status', '--root', root], io), 0)
  assert.match(io.state.out, /审核记录: 2 条/)
  assert.match(io.state.out, /最近一条: PR #8 第 1 轮 结论 REJECT/)
})

test('status: 没有记录时输出 0 条与「无」', () => {
  const root = tmp()
  const io = makeIO()

  assert.equal(run(['status', '--root', root], io), 0)
  assert.match(io.state.out, /审核记录: 0 条/)
  assert.match(io.state.out, /最近一条: 无/)
})

function runGit(cwd, args) {
  const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  assert.equal(result.status, 0, `git ${args.join(' ')} 失败: ${result.stderr}`)
}

test('status: 不传 --root 时自行定位（临时 git 仓，退出 0）', () => {
  const repo = mkdtempSync(join(tmpdir(), 'dsh-status-root-'))
  runGit(repo, ['init'])

  const io = makeIO()
  assert.equal(run(['status'], io, { cwd: repo }), 0)
  assert.match(io.state.out, /审核记录/)
  assert.match(io.state.out, /审核记录: 0 条/)
  assert.match(io.state.out, /最近一条: 无/)
})

test('status: 在 linked worktree 里不传 --root，读的是主工作区的记录', () => {
  const main = mkdtempSync(join(tmpdir(), 'dsh-status-main-'))
  runGit(main, ['init'])
  runGit(main, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=test',
    'commit',
    '--allow-empty',
    '-m',
    'init',
  ])
  const worktree = join(main, 'wt')
  runGit(main, ['worktree', 'add', worktree])
  writeRecord(
    reviewsDir(main),
    recordFor({ pr: 9, head_sha: OTHER_SHA, createdAt: '2026-11-01T00:00:00.000Z', verdict: 'REJECT' }),
  )

  const io = makeIO()
  assert.equal(run(['status'], io, { cwd: worktree }), 0)
  assert.match(io.state.out, /审核记录: 1 条/)
  assert.match(io.state.out, /最近一条: PR #9 第 1 轮 结论 REJECT/)
})

test('record: 在 linked worktree 里不传 --root，记录落主工作区（不随 worktree 被删）', () => {
  const main = tmp()
  runGit(main, ['init'])
  runGit(main, ['-c', 'user.email=test@example.com', '-c', 'user.name=test', 'commit', '--allow-empty', '-m', 'init'])
  const worktree = join(main, 'wt')
  runGit(main, ['worktree', 'add', worktree])

  const request = join(worktree, 'request.json')
  const response = join(worktree, 'response.txt')
  writeFileSync(request, JSON.stringify({ pr: 11, head_sha: SHA, nonce: NONCE, diff: '' }), 'utf8')
  writeFileSync(response, reviewText('APPROVE', SHA), 'utf8')

  const io = makeIO()
  assert.equal(run(['record', '--request', request, '--response', response], io, { cwd: worktree }), 0, io.state.err)
  assert.equal(existsSync(recordFile(reviewsDir(main), 11, SHA)), true, '记录应落在主工作区')
  assert.equal(existsSync(recordFile(reviewsDir(worktree), 11, SHA)), false, '记录不应落在 worktree')
})

test('status: 显式 --root 优先于 cwd，空值退出 2', () => {
  const cwdRoot = tmp()
  const target = tmp()
  writeRecord(
    reviewsDir(target),
    recordFor({ pr: 11, createdAt: '2026-11-02T00:00:00.000Z', verdict: 'APPROVE' }),
  )

  const io = makeIO()
  assert.equal(run(['status', '--root', target], io, { cwd: cwdRoot }), 0)
  assert.match(io.state.out, /审核记录: 1 条/)
  assert.match(io.state.out, /最近一条: PR #11 第 1 轮 结论 APPROVE/)

  const empty = makeIO()
  assert.equal(run(['status', '--root', ''], empty, { cwd: cwdRoot }), 2)
  assert.match(empty.state.err, /--root 必须是非空目录路径/)
})

/** 造一个有提交、还带一棵 linked worktree 的临时 git 仓，返回分支名。 */
function makeGitRepo(prefix) {
  const repo = mkdtempSync(join(tmpdir(), prefix))
  runGit(repo, ['init'])
  runGit(repo, [
    '-c',
    'user.email=test@example.com',
    '-c',
    'user.name=test',
    'commit',
    '--allow-empty',
    '-m',
    'init commit',
  ])
  const branch = spawnSync('git', ['-C', repo, 'branch', '--show-current'], { encoding: 'utf8' })
  assert.equal(branch.status, 0, branch.stderr)
  return { repo, branch: branch.stdout.trim() }
}

test('status: 仓库概览打出根目录 / 分支 / HEAD / worktree 列表，且排在审核记录段之前', () => {
  const { repo, branch } = makeGitRepo('dsh-status-overview-')
  const wt = join(repo, 'wt')
  runGit(repo, ['worktree', 'add', wt])

  const io = makeIO()
  assert.equal(run(['status', '--root', repo], io), 0, io.state.err)

  const out = io.state.out
  const overviewAt = out.indexOf('仓库概览:')
  const recordsAt = out.indexOf('审核记录:')
  assert.ok(overviewAt !== -1, `缺少仓库概览段:\n${out}`)
  assert.ok(recordsAt > overviewAt, `仓库概览段应在审核记录段之前:\n${out}`)

  assert.ok(branch.length > 0, '临时仓应停在某个分支上')
  assert.ok(out.includes(`  根目录:   ${repo}`), out)
  assert.ok(out.includes(`  当前分支: ${branch}`), out)
  assert.match(out, /  HEAD:\s+\S+ init commit/)

  const lines = out.split('\n')
  // git worktree list 会把路径解析成真实路径（macOS 的 /var 是指向 /private/var 的符号链接），
  // 并把路径列补齐到同一宽度，所以只断言「4 空格缩进 + 路径开头」
  const realRepo = realpathSync(repo)
  assert.ok(lines.some((line) => line.startsWith(`    ${realRepo}`)), `worktree 列表应逐行缩进:\n${out}`)
  assert.ok(
    lines.some((line) => line.startsWith(`    ${realRepo}/wt`)),
    `worktree 列表应含 linked worktree:\n${out}`,
  )

  assert.ok(out.includes('审核记录: 0 条'), out)
  assert.equal(io.state.err, '')
})

test('status: 非 git 目录只把概览段换成提示行，审核记录段照常、退出 0', () => {
  const root = tmp()
  const io = makeIO()

  assert.equal(run(['status', '--root', root], io), 0, io.state.err)
  assert.match(io.state.out, /仓库概览:\n（非 git 仓库或 git 不可用）/)
  assert.match(io.state.out, /审核记录: 0 条/)
  assert.match(io.state.out, /最近一条: 无/)
  assert.equal(io.state.err, '')
})

test('status --json: payload 含 repo {root, branch, head, worktrees}；非 git 时降级为 null', () => {
  const { repo, branch } = makeGitRepo('dsh-status-json-')

  const io = makeIO()
  assert.equal(run(['status', '--root', repo, '--json'], io), 0, io.state.err)
  const payload = JSON.parse(io.state.out)
  assert.equal(payload.repo.root, repo)
  assert.equal(payload.repo.branch, branch)
  assert.match(payload.repo.head, /init commit/)
  assert.equal(Array.isArray(payload.repo.worktrees), true)
  assert.ok(payload.repo.worktrees.length >= 1)
  assert.equal(payload.records, 0)
  assert.equal(payload.latest, null)
  assert.equal(payload.invalid, 0)
  assert.doesNotMatch(io.state.out, /审核记录:/)

  const plainRoot = tmp()
  const plain = makeIO()
  assert.equal(run(['status', '--root', plainRoot, '--json'], plain), 0, plain.state.err)
  assert.deepEqual(JSON.parse(plain.state.out).repo, {
    root: plainRoot,
    branch: null,
    head: null,
    worktrees: [],
  })
})

test('参数错误退出码 2', () => {
  const io = makeIO()
  assert.equal(run(['gate', '--root', tmp()], io), 2)
  assert.match(io.state.err, /--pr/)

  const conflict = makeIO()
  assert.equal(
    run(['gate', '--pr', '7', '--root', tmp(), '--record', 'x.json', '--no-review', '--reason', 'x'], conflict),
    2,
  )
  assert.match(conflict.state.err, /不能同时使用/)

  const missingReason = makeIO()
  assert.equal(run(['gate', '--pr', '7', '--root', tmp(), '--no-review'], missingReason), 2)
  assert.match(missingReason.state.err, /--reason/)
})
