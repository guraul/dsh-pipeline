/**
 * 契约测试：用真实子进程跑 bin/cli.mjs，不注入 runner。
 *
 * 目的（ADR-0003 决策 4 的「包自身门禁」）：
 *   1. 验证 CLI 作为独立可执行文件时的真实行为，包括 PATH 上的 gh/git 调用；
 *   2. 验证闸门在「合格记录 / REJECT / 无记录 / 跳过审核」四种输入下的退出码与副作用；
 *   3. 验证「闸门不通过时一个 gh 命令都不发」——这是包对外的唯一硬承诺。
 *
 * 隔离手段：临时目录造假消费仓 + 临时 bin 目录放假 gh / 假 git，
 * 假脚本只把 argv 追加到日志，不触网、不碰真实仓库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'bin', 'cli.mjs')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const PR = 42
const SHA = 'c'.repeat(40)
const OTHER_SHA = 'd'.repeat(40)

/** 假 gh：只记录 argv，永不触网；pr view 返回合并流程需要的 JSON。 */
const FAKE_GH = `#!/bin/sh
printf 'gh %s\\n' "$*" >> "$DSH_CONTRACT_LOG"
case "$*" in
  "pr view "*)
    printf '{"headRefName":"task/42","state":"OPEN","headRefOid":"%s"}\\n' "$DSH_CONTRACT_SHA" ;;
esac
exit 0
`

/** 假 git：记录 argv，并按子命令给出该子命令该有的输出。 */
const FAKE_GIT = `#!/bin/sh
printf 'git %s\\n' "$*" >> "$DSH_CONTRACT_LOG"
case "$*" in
  *"rev-parse HEAD"*)
    printf '%s\\n' "$DSH_CONTRACT_SHA" ;;
  *"worktree list --porcelain"*)
    printf 'worktree %s\\nHEAD %s\\nbranch refs/heads/main\\n\\n' "$DSH_CONTRACT_REPO" "$DSH_CONTRACT_SHA"
    printf 'worktree %s\\nHEAD %s\\nbranch refs/heads/task/42\\n\\n' "$DSH_CONTRACT_WT" "$DSH_CONTRACT_SHA" ;;
esac
exit 0
`

function recordFor(overrides = {}) {
  return {
    schemaVersion: 1,
    policyVersion: PKG.version,
    pr: PR,
    round: 1,
    verdict: 'APPROVE',
    head_sha: SHA,
    findings: [],
    evidence: ['cmd: node --test'],
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

/**
 * 造一个假消费仓：
 *   <base>/repo/.dsh/pipeline.json         消费仓配置
 *   <base>/repo/.dsh-web/reviews/<pr>-<sha>.json   审核记录（可选）
 *   <base>/bin/{gh,git}                    假命令，PATH 前缀指向这里
 *   <base>/cwd                             子进程工作目录（与 --root 刻意不同）
 *   <base>/calls.log                       假命令的 argv 日志
 */
function makeFixture({ record } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-contract-'))
  const repo = join(base, 'repo')
  const binDir = join(base, 'bin')
  const cwd = join(base, 'cwd')
  const logFile = join(base, 'calls.log')

  mkdirSync(join(repo, '.dsh'), { recursive: true })
  mkdirSync(join(repo, '.dsh-web', 'reviews'), { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(cwd, { recursive: true })
  writeFileSync(logFile, '', 'utf8')

  writeFileSync(
    join(repo, '.dsh', 'pipeline.json'),
    `${JSON.stringify({ repo: 'o/r', ci: ['node --test'], highRisk: ['lib/'] }, null, 2)}\n`,
    'utf8',
  )

  if (record !== undefined) {
    writeFileSync(
      join(repo, '.dsh-web', 'reviews', `${PR}-${record.head_sha}.json`),
      `${JSON.stringify(record, null, 2)}\n`,
      'utf8',
    )
  }

  for (const [name, body] of [
    ['gh', FAKE_GH],
    ['git', FAKE_GIT],
  ]) {
    const file = join(binDir, name)
    writeFileSync(file, body, 'utf8')
    chmodSync(file, 0o755)
  }

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    DSH_CONTRACT_LOG: logFile,
    DSH_CONTRACT_SHA: SHA,
    DSH_CONTRACT_REPO: repo,
    DSH_CONTRACT_WT: join(base, 'wt-task-42'),
  }

  return { base, repo, binDir, cwd, logFile, env }
}

function recordPath(fixture, sha) {
  return join(fixture.repo, '.dsh-web', 'reviews', `${PR}-${sha}.json`)
}

/** 真实子进程调用 CLI，返回 { status, stdout, stderr }。 */
function runMerge(fixture, extraArgs, recordFile) {
  const args = [CLI, 'merge', '--pr', String(PR), '--root', fixture.repo]
  if (recordFile !== undefined) args.push('--record', recordFile)
  args.push(...extraArgs)
  const result = spawnSync(process.execPath, args, {
    cwd: fixture.cwd,
    env: fixture.env,
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

/** 假命令日志里的 gh 调用（不含 git）。 */
/** 只关心写操作：读 PR 元信息是闸门前必须发生的只读调用。 */
function mutations(fixture) {
  return ghCalls(fixture).filter((line) => /\bpr (merge|review|comment|close|edit)\b/.test(line))
}

function ghCalls(fixture) {
  return readFileSync(fixture.logFile, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('gh '))
}

const MERGE_CALL = `gh pr merge ${PR} --repo o/r --squash`

/** 合并恰好发生一次，且是闸门之后的最后一个 gh 动作。 */
function assertMergedOnce(fixture) {
  const calls = ghCalls(fixture)
  assert.equal(calls.filter((line) => line === MERGE_CALL).length, 1, calls.join('\n'))
  assert.equal(calls[calls.length - 1], MERGE_CALL)
  assert.match(calls[0], new RegExp(`^gh pr view ${PR} --repo o/r `))
  return calls
}

function cleanup(t, fixture) {
  t.after(() => rmSync(fixture.base, { recursive: true, force: true }))
  return fixture
}

test('合格记录：退出 0，且真实发出 gh pr merge --squash', (t) => {
  const fixture = cleanup(t, makeFixture({ record: recordFor() }))
  const result = runMerge(fixture, [], recordPath(fixture, SHA))

  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.match(result.stdout, new RegExp(`已合并 PR #${PR}`))
  assertMergedOnce(fixture)
})

test('记录判定为 REJECT：退出 1，且没有任何写操作', (t) => {
  const fixture = cleanup(t, makeFixture({ record: recordFor({ verdict: 'REJECT' }) }))
  const result = runMerge(fixture, [], recordPath(fixture, SHA))

  assert.equal(result.status, 1, `stderr: ${result.stderr}`)
  assert.match(result.stderr, /REJECT/)
  assert.deepEqual(mutations(fixture), [], '闸门不过时不允许任何写操作')
})

test('无审核记录且未声明跳过：退出 1，且没有任何写操作', (t) => {
  const fixture = cleanup(t, makeFixture())
  const result = runMerge(fixture, [])

  assert.equal(result.status, 1, `stderr: ${result.stderr}`)
  assert.match(result.stderr, /未提供审核记录/)
  assert.deepEqual(mutations(fixture), [], '闸门不过时不允许任何写操作')
})

test('--no-review：退出 0，跳审审计落盘且照常合并', (t) => {
  const fixture = cleanup(t, makeFixture())
  const skipsDir = join(fixture.repo, '.dsh-web', 'reviews', 'skips')
  const result = runMerge(fixture, ['--no-review', '--reason', '紧急热修'])

  assert.equal(result.status, 0, `stderr: ${result.stderr}`)
  assert.match(result.stderr, /已跳过审核/)
  assertMergedOnce(fixture)

  const audits = readdirSync(skipsDir)
  assert.equal(audits.length, 1)
  assert.match(audits[0], new RegExp(`^\\d{8}T\\d{6}Z-${PR}\\.json$`))
  assert.equal(JSON.parse(readFileSync(join(skipsDir, audits[0]), 'utf8')).reason, '紧急热修')
})

test('记录 head 与 PR head 不符：退出 1，且没有任何写操作', (t) => {
  const fixture = cleanup(t, makeFixture({ record: recordFor({ head_sha: OTHER_SHA }) }))
  const result = runMerge(fixture, [], recordPath(fixture, OTHER_SHA))

  assert.equal(result.status, 1, `stderr: ${result.stderr}`)
  assert.match(result.stderr, /判定已作废/)
  assert.deepEqual(mutations(fixture), [], '闸门不过时不允许任何写操作')
})
