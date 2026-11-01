import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runCli } from '../bin/cli.mjs'
import {
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  readRecord,
  recordFile,
  reviewsDir,
  writeRecord,
} from '../lib/record.mjs'

const SHA = 'a'.repeat(40)
const OTHER_SHA = 'b'.repeat(40)
const NONCE = 'ABCDEFGHJKLM'

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

function stubRunner() {
  const calls = []
  const runner = (command, args) => {
    calls.push({ command, args: [...args] })
    if (command === 'git') return { status: 0, stdout: `${SHA}\n`, stderr: '' }
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
  assert.equal(version.state.out.trim(), PACKAGE_VERSION)
  assert.equal(version.state.err, '')
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
  const { runner, calls } = stubRunner()

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
    ['branch', '-d', '--', 'task/7'],
  ])
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

test('record: 响应缺少判定行时退出码 2 且不落盘', () => {
  const root = tmp()
  const request = join(root, 'request.json')
  const response = join(root, 'response.txt')
  writeFileSync(request, JSON.stringify({ pr: 7, head_sha: SHA, nonce: NONCE }), 'utf8')
  writeFileSync(response, '只有分析，没有判定行。', 'utf8')

  const io = makeIO()
  assert.equal(run(['record', '--request', request, '--response', response], io, { cwd: root }), 2)
  assert.match(io.state.err, /判定行/)
  assert.equal(readdirSync(root).includes('.dsh-web'), false)
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
