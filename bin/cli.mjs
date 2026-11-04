#!/usr/bin/env node
/**
 * dsh-pipeline CLI：参数解析与子命令的编排。
 *
 * 判定、读写、执行全部复用 lib/，本文件不复制任何业务规则：
 * gate 走 decideGate()；merge 整条流程（闸门 → CI → squash 合并 → 清理现场）交给
 * lib/merge.mjs，合并方式由 gh.prMerge 固定为 --squash；
 * task / pr 的流程分别交给 lib/task.mjs 与 lib/pr.mjs；
 * review 的 publish 复用 runRecord（与 record 同一条落盘路径），prepare 只编排 gh 读取，
 * prompt 只读请求文件并复用 buildPrompt（不发外部命令、不写请求）。
 *
 * 输出约定：面向人的信息走 stdout，错误与警告走 stderr，全部中文。
 * 退出码：0 通过 / 1 闸门拒绝 / 2 参数或环境错误。
 * runner 可注入，测试用假 runner 断言实际发出的命令，不碰真实 gh/git。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.mjs'
import { evaluateGate } from '../lib/gate.mjs'
import { prChecks, prDiff, prMerge, prView } from '../lib/gh.mjs'
import {
  checkout,
  currentBranch,
  deleteBranch,
  fetch as gitFetch,
  headSha as gitHeadSha,
  mergeFF,
  statusPorcelain,
  worktreeList,
  worktreeRemove,
} from '../lib/git.mjs'
import { runMerge as runMergeFlow } from '../lib/merge.mjs'
import { mergePolicy } from '../lib/policy.mjs'
import { runPr as runPrFlow } from '../lib/pr.mjs'
import { NONCE_PATTERN, analyzeVerdict, buildPrompt, extractFindings, makeNonce } from '../lib/review.mjs'
import { resolveRoles } from '../lib/roles.mjs'
import {
  MAX_ROUND,
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  SHA_PATTERN,
  readRecord,
  reviewsDir,
  writeRecord,
  writeSkipAudit,
} from '../lib/record.mjs'
import { runTask as runTaskFlow } from '../lib/task.mjs'
import { describeBuild } from '../lib/build-info.mjs'
import { describeRow, diagnose } from '../lib/doctor.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const IMPLEMENTED = new Set(['doctor', 'gate', 'merge', 'record', 'status', 'task', 'pr', 'review'])
const SUBCOMMANDS = ['task', 'prepare', 'pr', 'merge', 'gate', 'record', 'status', 'doctor', 'review']

const HELP = `dsh-pipeline ${pkg.version} — 统一交付与审核流程的单一实现

用法: dsh-pipeline <子命令> [选项]

子命令:
  gate       审核闸门检查
  merge      闸门通过后合并 PR（固定 --squash）并清理现场
  record     把审核响应落盘为记录
  status     查看审核记录概况
  doctor     检查各仓装的共享包是不是同一个构建（比对 build.json）
  --repo <a,b>       要检查的仓库根（逗号分隔；缺省当前目录）
  --json             机器可读输出（退出码与人读模式一致）
  --expect <sha>     期望的构建 sha（可传 7 位短 sha；不一致则退出 1）
  task       从 issue 创建 task/<号>-<slug> 分支与 worktree
  prepare    准备交付（未实现）
  pr         推送当前 task 分支并创建 PR
  review     生成审核请求（prepare）、审核提示词（prompt）并把判定落成记录（publish）

task 用法:
  dsh-pipeline task <issue号> [--slug <slug>] [--root <dir>]
  --slug <slug>      手动指定分支/目录后缀（缺省由 issue 标题生成；中文标题会退化成哈希，可读性差时用它）。
                     会规范化：转小写、非字母数字折成 '-'、截断到 40 字符
  --root <dir>       仓库根目录（缺省取主工作区；在 worktree 里运行会自动上溯）
  幂等：worktree 已存在时只打印路径；路径被别的目录占用时报错退出 2。

pr 用法:
  dsh-pipeline pr [--issue <号>] [--root <dir>]
  --issue <号>       分支名不含 issue 号时（如 task/pipeline-gh）用它指定 PR 要关哪个 issue
  --root <dir>       仓库根目录（缺省取当前 task worktree 的顶层目录）
  当前分支必须是 task/<号>-<slug>；PR 已存在时只打印链接。

review 用法:
  dsh-pipeline review prepare --pr <n> [--root <dir>] [--model <m>] [--round <n>] [--out <file>]
                               [--facts <文件>] [--include <路径,路径,...>]
  dsh-pipeline review publish --pr <n> --response <file> [--request <file>] [--round <n>]
                               [--root <dir>] [--model <m>] [--provider <p>] [--form <f>]
  dsh-pipeline review prompt --request <file> [--out <file>] [--role <名>]

  prepare  用 gh 读 PR 的 head 提交、改动文件与 diff，生成请求 JSON（含 12 位 base32 nonce）
           到 <root>/.tmp/review/<pr>/request.json（--out 可改路径）；
           stdout 三行：请求文件路径、nonce、head 前 7 位。
           --facts <文件> 把文件内容作为纯文本写进请求的 facts 字段（缺省不加该字段）；
           --include <路径,路径,...> 逐个读文件写进请求的 includes 数组（每项 {path, content}，
           path 保持调用方给的原样）；任一路径读不到或取值为空即退出 2，不写请求文件。
  publish  读 --response 并落盘 <root>/.dsh-web/reviews/<pr>-<sha>.json，复用 record 的落盘逻辑；
           --request 缺省为 <root>/.tmp/review/<pr>/request.json；
           --round 与请求里的 round 不一致时报错退出 2，没给则沿用请求里的 round。
           判定行无法解析或提交不匹配时仍写一条 ESCALATE 记录，退出码 1（审计轨迹不丢）。
  prompt   读 --request 指定的请求 JSON，用 buildPrompt 组出审核提示词（不发任何外部命令）；
           --request 必填、没有缺省回退（拿错请求文件的代价是把错提示词发给 reviewer）；
           未给 --out 打到 stdout，给了就写文件并打印「已写入 <路径>」；
           --role <名> 取该角色的 instructions（默认角色 + .dsh/pipeline.json 的 roles 覆盖），未知角色退出 2。

gate / merge 选项:
  --pr <n>           PR 编号（必填）
  --root <dir>       仓库根目录（必填）
  --record <file>    审核记录文件
  --head-sha <sha>   指定 head 提交（缺省取 git HEAD）
  --no-review        跳过审核并写入跳过审计
  --reason <文本>    跳过审核的原因（必须与 --no-review 同用）

merge 额外选项:
  --check-only       只校验（闸门 + CI），不合并、不清理
  --checks-file <f>  用文件内容代替 gh pr checks（形如 {"state":"success"}）
  --force            CI 未过仍合并（闸门不受影响，仍强制生效）

record 选项:
  --request <file>   审核请求 JSON（插件信封 {request,stats} 或扁平请求均可）
  --response <file>  reviewer 响应文本
  --findings <file>  响应里没有 json 代码块时的兜底（{\"findings\":[...],\"evidence\":[...]}）
  --round <n>        审核轮次（1..${MAX_ROUND}，默认 1）
  --root <dir>       仓库根目录（默认当前工作目录），记录写入 <root>/.dsh-web/reviews
  --model <名>       产生判定的模型（缺省取请求里的 model）
  --name <文件名>    自定义落盘文件名（默认 <pr>-<sha>.json；分片审核用它直接写分片名，
                     避免「先写规范名再删除」的窗口）
  --provider <名>    产出判定的提供方（缺省 unknown）
  --form <名>        记录的形态标记（缺省 cli）
  --duration-ms <n>  本次审核耗时（毫秒，可选）
  --json             把写出的记录完整对象打到 stdout（不再打印「已写入审核记录」）

  判定行无法解析或提交不匹配时仍写一条 ESCALATE 记录，退出码 1（审计轨迹不丢）。

status 选项:
  --root <dir>       仓库根目录（必填）

全局选项:
  -h, --help     显示帮助
  -v, --version  显示版本

退出码: 0 通过 / 1 闸门拒绝 / 2 参数或环境错误`

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * 极简参数解析：只接受 --name value 与 --name=value。
 * 布尔参数不取值；重复参数、未知参数一律报错，不做猜测。
 */
function parseArgs(argv, valueFlags, booleanFlags) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) return { error: `无法识别的参数: ${arg}` }
    const eq = arg.indexOf('=')
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)

    if (booleanFlags.has(name)) {
      if (eq !== -1) return { error: `--${name} 不接受取值` }
      if (options[name] !== undefined) return { error: `重复参数: --${name}` }
      options[name] = true
      continue
    }

    if (valueFlags.has(name)) {
      if (options[name] !== undefined) return { error: `重复参数: --${name}` }
      if (eq !== -1) {
        options[name] = arg.slice(eq + 1)
        continue
      }
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) return { error: `--${name} 缺少取值` }
      options[name] = next
      i += 1
      continue
    }

    return { error: `未知选项: --${name}` }
  }
  return { options }
}

function parsePr(value) {
  if (value === undefined) return { error: '缺少必填参数 --pr' }
  if (!/^[1-9][0-9]*$/.test(value)) return { error: `--pr 必须是正整数: ${value}` }
  return { value: Number(value) }
}

function requireRoot(value) {
  if (!nonEmpty(value)) return { error: '缺少必填参数 --root' }
  return { value }
}

function parseRound(value) {
  if (value === undefined) return { value: 1 }
  if (!/^[1-9][0-9]*$/.test(value)) {
    return { error: `--round 必须是 1..${MAX_ROUND} 的整数: ${value}` }
  }
  const round = Number(value)
  if (round < 1 || round > MAX_ROUND) {
    return { error: `--round 必须是 1..${MAX_ROUND} 的整数: ${value}` }
  }
  return { value: round }
}

/** gate / merge 共用同一份参数校验；merge 多三个开关（check-only / checks-file / force）。 */
function parseGateArgs(argv, { mergeOnly = false } = {}) {
  const valueFlags = mergeOnly ? MERGE_VALUE_FLAGS : GATE_VALUE_FLAGS
  const boolFlags = mergeOnly ? MERGE_BOOL_FLAGS : GATE_BOOL_FLAGS
  const parsed = parseArgs(argv, valueFlags, boolFlags)
  if (parsed.error) return { error: parsed.error }
  const options = parsed.options

  const pr = parsePr(options.pr)
  if (pr.error) return { error: pr.error }
  const root = requireRoot(options.root)
  if (root.error) return { error: root.error }

  if (options.record !== undefined && options['no-review'] === true) {
    return { error: '不能同时使用 --record 与 --no-review' }
  }
  if (options['no-review'] !== true && options.reason !== undefined) {
    return { error: '--reason 只能与 --no-review 一起使用' }
  }
  if (options['no-review'] === true && !nonEmpty(options.reason)) {
    return { error: '--no-review 必须配合 --reason 说明跳过原因' }
  }
  if (options.record !== undefined && !nonEmpty(options.record)) {
    return { error: '--record 必须是非空文件路径' }
  }

  const headSha = options['head-sha']
  if (headSha !== undefined && !SHA_PATTERN.test(headSha)) {
    return { error: `--head-sha 必须是 40 位小写十六进制: ${headSha}` }
  }

  const common = {
    pr: pr.value,
    root: root.value,
    record: options.record,
    noReview: options['no-review'] === true,
    reason: options.reason,
    headSha,
  }
  if (!mergeOnly) return common

  if (options['checks-file'] !== undefined && !nonEmpty(options['checks-file'])) {
    return { error: '--checks-file 必须是非空文件路径' }
  }

  return {
    ...common,
    checkOnly: options['check-only'] === true,
    checksFile: options['checks-file'],
    force: options.force === true,
  }
}

/**
 * gate / merge 的唯一判定入口：跳过审计、fail-closed、记录校验、head 解析、闸门判定。
 * 返回 { code, skipped, lines }，由调用方决定打印后是否继续合并。
 */
function decideGate({ pr, root, record, noReview, reason, headSha, runner }) {
  if (noReview) {
    try {
      const file = writeSkipAudit(reviewsDir(root), { pr, headSha, reason })
      return {
        code: 0,
        skipped: true,
        lines: [
          {
            stream: 'err',
            text: `警告: PR #${pr} 已跳过审核（原因: ${reason}）；审计记录: ${file}`,
          },
        ],
      }
    } catch (error) {
      return {
        code: 2,
        skipped: false,
        lines: [{ stream: 'err', text: `跳过审核失败: ${messageOf(error)}` }],
      }
    }
  }

  if (record === undefined) {
    return {
      code: 1,
      skipped: false,
      lines: [
        { stream: 'err', text: '审核闸门: 未提供审核记录，且未声明 --no-review，按失败关闭处理' },
      ],
    }
  }

  let candidate
  try {
    candidate = readRecord(record)
  } catch (error) {
    return {
      code: 1,
      skipped: false,
      lines: [{ stream: 'err', text: `审核闸门: ${messageOf(error)}` }],
    }
  }

  if (candidate.pr !== pr) {
    return {
      code: 1,
      skipped: false,
      lines: [
        { stream: 'err', text: `审核闸门: 记录属于 PR #${String(candidate.pr)}，与 --pr #${pr} 不符` },
      ],
    }
  }

  let sha = headSha
  if (sha === undefined) {
    const current = gitHeadSha(root, { runner })
    if (!current.ok) {
      return {
        code: 2,
        skipped: false,
        lines: [{ stream: 'err', text: `无法获取当前 head 提交: ${current.error}` }],
      }
    }
    sha = current.data
  }

  const verdict = evaluateGate({
    record: candidate,
    headSha: sha,
    currentPolicyVersion: pkg.version,
  })
  if (!verdict.ok) {
    return {
      code: 1,
      skipped: false,
      lines: [{ stream: 'err', text: `审核闸门: ${verdict.reason}` }],
    }
  }

  return {
    code: 0,
    skipped: false,
    lines: [{ stream: 'out', text: `审核闸门: PR #${pr} 通过` }],
  }
}

const GATE_VALUE_FLAGS = new Set(['pr', 'root', 'record', 'reason', 'head-sha'])
const GATE_BOOL_FLAGS = new Set(['no-review'])
const MERGE_VALUE_FLAGS = new Set([...GATE_VALUE_FLAGS, 'checks-file'])
const MERGE_BOOL_FLAGS = new Set([...GATE_BOOL_FLAGS, 'check-only', 'force'])
const RECORD_VALUE_FLAGS = new Set([
  'request',
  'response',
  'findings',
  'round',
  'root',
  'model',
  'provider',
  'form',
  'duration-ms',
  'name',
])
const RECORD_BOOL_FLAGS = new Set(['json'])
const STATUS_VALUE_FLAGS = new Set(['root'])
const STATUS_BOOL_FLAGS = new Set()
const TASK_VALUE_FLAGS = new Set(['root', 'slug'])
const TASK_BOOL_FLAGS = new Set()
const PR_VALUE_FLAGS = new Set(['root', 'issue'])
const PR_BOOL_FLAGS = new Set()
const REVIEW_PREPARE_VALUE_FLAGS = new Set(['pr', 'root', 'model', 'round', 'out', 'facts', 'include'])
const REVIEW_PREPARE_BOOL_FLAGS = new Set()
const REVIEW_PUBLISH_VALUE_FLAGS = new Set([
  'pr',
  'root',
  'response',
  'request',
  'round',
  'model',
  'provider',
  'form',
])
const REVIEW_PUBLISH_BOOL_FLAGS = new Set()
const REVIEW_PROMPT_VALUE_FLAGS = new Set(['request', 'out', 'role'])
const REVIEW_PROMPT_BOOL_FLAGS = new Set()

function emit(io, lines) {
  for (const line of lines) {
    if (line.stream === 'err') io.err(line.text)
    else io.out(line.text)
  }
}

function argError(io, sub, message) {
  io.err(`${sub}: ${message}`)
  return 2
}

function runGate(argv, deps, io) {
  const parsed = parseGateArgs(argv)
  if (parsed.error) return argError(io, 'gate', parsed.error)
  const decision = decideGate({ ...parsed, runner: deps.runner })
  emit(io, decision.lines)
  return decision.code
}

/**
 * merge 只负责参数解析与输出：闸门、合并、清理的顺序与失败语义都在 lib/merge.mjs。
 * runner 在这里绑定到真实的 gh / git 封装上，lib 层保持与执行器无关。
 */
function runMerge(argv, deps, io) {
  const parsed = parseGateArgs(argv, { mergeOnly: true })
  if (parsed.error) return argError(io, 'merge', parsed.error)

  const runner = deps.runner
  const result = runMergeFlow({
    pr: parsed.pr,
    root: parsed.root,
    recordPath: parsed.record,
    noReview: parsed.noReview,
    reason: parsed.reason,
    headSha: parsed.headSha,
    checkOnly: parsed.checkOnly,
    checksFile: parsed.checksFile,
    force: parsed.force,
    deps: {
      gh: {
        prView: (pr, options = {}) => prView(pr, { ...options, runner }),
        prMerge: (pr, options = {}) => prMerge(pr, { ...options, runner }),
        prChecks: (pr, options = {}) => prChecks(pr, { ...options, runner }),
      },
      git: {
        headSha: (cwd) => gitHeadSha(cwd, { runner }),
        worktreeList: (cwd) => worktreeList(cwd, { runner }),
        worktreeRemove: (cwd, path) => worktreeRemove(cwd, path, { runner }),
        currentBranch: (cwd) => currentBranch(cwd, { runner }),
        statusPorcelain: (cwd) => statusPorcelain(cwd, { runner }),
        checkout: (cwd, options = {}) => checkout(cwd, { ...options, runner }),
        fetch: (cwd, options = {}) => gitFetch(cwd, { ...options, runner }),
        mergeFF: (cwd, options = {}) => mergeFF(cwd, { ...options, runner }),
        deleteBranch: (cwd, name, options = {}) => deleteBranch(cwd, name, { ...options, runner }),
      },
    },
  })

  // 跳过审核是「留痕的例外」，警告走 stderr，与 gate 子命令一致
  if (parsed.noReview && result.steps.some((step) => step.name === 'gate' && step.ok)) {
    io.err(`警告: PR #${parsed.pr} 已跳过审核（原因: ${parsed.reason}）`)
  }

  for (const step of result.steps) {
    if (step.ok) io.out(`${step.name}: ${step.detail}`)
    else io.err(`${step.name}: ${step.detail}`)
  }

  if (result.ok) {
    if (result.checkOnly === true) {
      io.out('审核闸门通过（仅校验，未合并）')
      return 0
    }
    const ffStep = result.steps.find((step) => step.name === 'ff')
    if (ffStep?.skipped === true) {
      // 快进没做成时不能说成「main 已快进」：原因与下一步动作在 ff 那一行里
      io.out(`已合并 PR #${parsed.pr}（--squash），但 main 未快进: ${ffStep.detail}`)
      return 0
    }
    io.out(`已合并 PR #${parsed.pr}（--squash），现场已清理，main 已快进`)
    return 0
  }
  io.err(`merge: 停在 ${String(result.step)} 步骤（${String(result.code)}）`)
  return result.step === 'gate' || result.step === 'ci' ? 1 : 2
}

function readTextFile(file, label) {
  try {
    return { text: readFileSync(file, 'utf8') }
  } catch {
    return { error: `无法读取${label}: ${file}` }
  }
}

/** 响应里是否出现 ```json 块（只要围栏在就算，内容是否可解析交给 extractFindings 判断）。 */
function hasJsonFence(text) {
  return /```json[ \t]*\r?\n/.test(String(text ?? ''))
}

/**
 * 读取 --findings 兜底文件：形如 {"findings":[...],"evidence":[...]}。
 * 文件不可读、非法 JSON、缺 findings 数组一律返回中文错误（不向上抛 SyntaxError）。
 */
function readFindingsFile(file) {
  const raw = readTextFile(file, 'findings 文件')
  if (raw.error) return { error: raw.error }

  let payload
  try {
    payload = JSON.parse(raw.text)
  } catch {
    return { error: `findings 文件不是合法 JSON: ${file}` }
  }
  if (!isPlainObject(payload)) return { error: `findings 文件必须是 JSON 对象: ${file}` }
  if (!Array.isArray(payload.findings)) {
    return { error: `findings 文件缺少 findings 数组: ${file}` }
  }
  if (payload.evidence !== undefined && !Array.isArray(payload.evidence)) {
    return { error: `findings 文件里的 evidence 必须是数组: ${file}` }
  }

  return {
    findings: payload.findings,
    evidence: payload.evidence ?? [],
  }
}

/** 插件 prepare 写的是信封 {request, stats}；扁平请求则直接用顶层字段。 */
function requestOf(payload) {
  return isPlainObject(payload.request) ? payload.request : payload
}

/** issue 可能是号、也可能是 {number,...}（prepare 的形态）；取不到就是 null，不猜。 */
function issueNumberOf(issue) {
  if (Number.isInteger(issue) && issue > 0) return issue
  if (isPlainObject(issue) && Number.isInteger(issue.number) && issue.number > 0) return issue.number
  return null
}

/**
 * 请求没带 files 时从 diff 还原改动文件，避免高风险判定因缺文件列表而静默放行。
 * 优先取 `+++ b/<path>`；纯重命名 / 二进制变更这类没有 `+++` 行的 diff，
 * 兜底取 `diff --git a/<old> b/<new>` 头里 b/ 后的那段（新路径）。
 */
function diffPaths(diff) {
  const paths = new Set()
  for (const line of String(diff ?? '').split('\n')) {
    const plus = /^\+\+\+ b\/(.+)$/.exec(line)
    if (plus) {
      paths.add(plus[1])
      continue
    }
    const header = /^diff --git "?a\/(.+?)"? "?b\/(.+?)"?$/.exec(line)
    if (header) paths.add(header[2])
  }
  return [...paths]
}

function changedFiles(request) {
  return Array.isArray(request.files) ? request.files : diffPaths(request.diff)
}

/** 变更行数（增删合计），忽略 diff 的 +++/--- 文件头。 */
function countChangedLines(diff) {
  let count = 0
  for (const line of String(diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') || line.startsWith('-')) count += 1
  }
  return count
}

function parseDuration(value) {
  if (value === undefined) return { value: undefined }
  if (!/^[0-9]+$/.test(value)) return { error: `--duration-ms 必须是非负整数: ${value}` }
  return { value: Number(value) }
}

function runRecord(argv, deps, io) {
  const parsed = parseArgs(argv, RECORD_VALUE_FLAGS, RECORD_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'record', parsed.error)
  const options = parsed.options

  if (!nonEmpty(options.request)) return argError(io, 'record', '缺少必填参数 --request')
  if (!nonEmpty(options.response)) return argError(io, 'record', '缺少必填参数 --response')
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, 'record', '--root 必须是非空目录路径')
  }
  if (options.model !== undefined && !nonEmpty(options.model)) {
    return argError(io, 'record', '--model 必须是非空字符串')
  }
  if (options.provider !== undefined && !nonEmpty(options.provider)) {
    return argError(io, 'record', '--provider 必须是非空字符串')
  }
  if (options.form !== undefined && !nonEmpty(options.form)) {
    return argError(io, 'record', '--form 必须是非空字符串')
  }
  if (options.findings !== undefined && !nonEmpty(options.findings)) {
    return argError(io, 'record', '--findings 必须是非空文件路径')
  }
  const round = parseRound(options.round)
  if (round.error) return argError(io, 'record', round.error)
  const duration = parseDuration(options['duration-ms'])
  if (duration.error) return argError(io, 'record', duration.error)

  const requestFile = readTextFile(options.request, '请求文件')
  if (requestFile.error) return argError(io, 'record', requestFile.error)
  let payload
  try {
    payload = JSON.parse(requestFile.text)
  } catch {
    return argError(io, 'record', `请求文件不是合法 JSON: ${options.request}`)
  }
  if (!isPlainObject(payload)) return argError(io, 'record', '请求内容必须是 JSON 对象')
  const request = requestOf(payload)

  if (!Number.isInteger(request.pr) || request.pr <= 0) {
    return argError(io, 'record', `请求中的 pr 必须是正整数: ${String(request.pr)}`)
  }
  if (typeof request.head_sha !== 'string' || !SHA_PATTERN.test(request.head_sha)) {
    return argError(io, 'record', `请求中的 head_sha 必须是 40 位小写十六进制: ${String(request.head_sha)}`)
  }
  if (typeof request.nonce !== 'string' || !NONCE_PATTERN.test(request.nonce)) {
    return argError(io, 'record', `请求中的 nonce 必须是 12 位 base32 标记: ${String(request.nonce)}`)
  }

  const responseFile = readTextFile(options.response, '响应文件')
  if (responseFile.error) return argError(io, 'record', responseFile.error)
  const response = responseFile.text

  // 兜底文件先读先校验：传了坏文件就明确失败，不静默忽略。
  // 它是「参数/环境错误」，必须先于判定失败处理，否则一条坏路径会被误当成判定问题。
  const fallback = options.findings === undefined ? null : readFindingsFile(options.findings)
  if (fallback !== null && fallback.error) return argError(io, 'record', fallback.error)

  const analysis = analyzeVerdict(response, { nonce: request.nonce, diff: request.diff })
  // 判定不可用不阻断落盘：审计轨迹不能因为「模型没按格式回答」而断掉。
  // 记录写成 ESCALATE，退出码仍是 1（闸门拒绝）；只有落盘失败才是 2。
  let escalation = null
  if (!analysis.ok) {
    escalation = { errorCode: 'E_PARSE', reason: analysis.reason }
  } else if (analysis.sha !== request.head_sha) {
    escalation = {
      errorCode: 'E_SHA_MISMATCH',
      reason: `判定针对提交 ${analysis.sha}，与请求提交 ${request.head_sha} 不一致`,
    }
  }

  const extracted = extractFindings(response)

  // 只有响应里根本没有 ```json 块时才走兜底；有块但解析失败仍按解析失败处理。
  const usedFallback = fallback !== null && !hasJsonFence(response)
  if (usedFallback) {
    extracted.findings = fallback.findings
    extracted.evidence = fallback.evidence
    extracted.warn = null
  }
  if (escalation === null && extracted.warn !== null) io.err(`record: 提示: ${extracted.warn}`)

  let findings = extracted.findings
  let evidence = extracted.evidence
  if (escalation !== null) {
    if (escalation.errorCode === 'E_PARSE') {
      // 解析失败意味着响应内容不可信：不保留从它里面抽出的任何结论，只留解析器给的原因。
      findings = []
      evidence = [escalation.reason]
    } else {
      // 提交不匹配时响应本身可解析，findings/evidence 保留，另追加不匹配原因。
      evidence = [...evidence, escalation.reason]
    }
  }

  const root = nonEmpty(options.root) ? options.root : nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  let policy
  try {
    const { config } = loadConfig(root)
    policy = mergePolicy({ highRiskAppend: config.highRisk }).hit(
      changedFiles(request),
      countChangedLines(request.diff),
      { diff: request.diff },
    )
  } catch (error) {
    // 策略算不出来就写不了可信记录：宁可失败，也不写一条 policy 缺失的记录。
    io.err(`record: 高风险判定失败: ${messageOf(error)}`)
    return 2
  }

  const record = {
    schemaVersion: SCHEMA_VERSION,
    policyVersion: PACKAGE_VERSION,
    pr: request.pr,
    round: round.value,
    verdict: escalation === null ? analysis.verdict : 'ESCALATE',
    head_sha: request.head_sha,
    nonce: request.nonce,
    findings,
    evidence,
    form: nonEmpty(options.form) ? options.form : 'cli',
    provider: nonEmpty(options.provider) ? options.provider : 'unknown',
    model: nonEmpty(options.model)
      ? options.model
      : nonEmpty(request.model)
        ? request.model
        : 'unknown',
    request: {
      issue: issueNumberOf(request.issue),
      diffChars: String(request.diff ?? '').length,
    },
    policy,
    createdAt: new Date().toISOString(),
  }
  if (duration.value !== undefined) record.durationMs = duration.value
  // 命中高风险不改判定（判定是 reviewer 的结论），只标注合并必须人工放行；
  // 但判定本身不可用时错误码以解析/不一致为准，那才是这条记录的成因。
  if (escalation !== null) record.errorCode = escalation.errorCode
  else if (policy.hit) record.errorCode = 'E_POLICY'
  if (typeof request.traceId === 'string' && request.traceId.length > 0) {
    record.traceId = request.traceId
  }

  try {
    const file = writeRecord(reviewsDir(root), record, { name: options.name })
    // 插件端要薄转发：--json 时只输出记录本体，便于调用方直接 JSON.parse。
    if (options.json === true) {
      io.out(JSON.stringify(JSON.parse(readFileSync(file, 'utf8'))))
    } else {
      io.out(`已写入审核记录: ${file}`)
    }
    // 记录已落盘但判定不可用：退出 1，让调用方走人工，而不是把审计轨迹丢掉。
    if (escalation !== null) {
      io.err(`record: ${escalation.errorCode}: ${escalation.reason}；已按 ESCALATE 落盘`)
      return 1
    }
    return 0
  } catch (error) {
    io.err(`record: 写入失败: ${messageOf(error)}`)
    return 2
  }
}

/** review 两个动作共用的根目录口径：--root > 注入的 cwd > 当前工作目录。 */
function resolveReviewRoot(value, deps) {
  if (value !== undefined) return value
  return nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
}

/**
 * review prepare：从 gh 取 PR 的 head 提交、改动文件与 diff，生成审核请求 JSON。
 * 外部调用只走 lib/gh.mjs 的具名操作（prView / prDiff），本函数不直接 spawn。
 */
function runReviewPrepare(argv, deps, io) {
  const sub = 'review prepare'
  const parsed = parseArgs(argv, REVIEW_PREPARE_VALUE_FLAGS, REVIEW_PREPARE_BOOL_FLAGS)
  if (parsed.error) return argError(io, sub, parsed.error)
  const options = parsed.options

  const pr = parsePr(options.pr)
  if (pr.error) return argError(io, sub, pr.error)
  const round = parseRound(options.round)
  if (round.error) return argError(io, sub, round.error)
  if (options.model !== undefined && !nonEmpty(options.model)) {
    return argError(io, sub, '--model 必须是非空字符串')
  }
  if (options.out !== undefined && !nonEmpty(options.out)) {
    return argError(io, sub, '--out 必须是非空文件路径')
  }
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, sub, '--root 必须是非空目录路径')
  }
  const root = resolveReviewRoot(options.root, deps)

  // 证据包先读、后发 gh：读不到是调用方的参数错误，要在打网络之前就失败，
  // 更不能落盘一个缺证据的请求文件。相对路径按 --root 解析（与消费仓口径一致）。
  const readEvidence = (file, label) => {
    const target = isAbsolute(file) ? file : join(root, file)
    try {
      return { text: readFileSync(target, 'utf8') }
    } catch {
      return { error: `${label} 指定的文件读不到: ${target}` }
    }
  }

  let facts
  if (options.facts !== undefined) {
    if (!nonEmpty(options.facts)) return argError(io, sub, '--facts 必须是非空文件路径')
    const read = readEvidence(options.facts, '--facts')
    if (read.error) return argError(io, sub, read.error)
    facts = read.text
  }

  let includes
  if (options.include !== undefined) {
    // 空值不是「没有」，是写错了：--include= / --include=,, 一律拒绝，不静默跳过。
    const paths = options.include.split(',').map((item) => item.trim())
    if (paths.some((path) => path.length === 0)) {
      return argError(io, sub, '--include 需要一个或多个文件路径（逗号分隔）')
    }
    includes = []
    for (const path of paths) {
      const read = readEvidence(path, '--include')
      if (read.error) return argError(io, sub, read.error)
      includes.push({ path, content: read.text })
    }
  }

  let config
  try {
    config = loadConfig(root).config
  } catch (error) {
    return argError(io, sub, `读取配置失败: ${messageOf(error)}`)
  }
  const repo = config.repo
  if (typeof repo !== 'string' || repo.length === 0) {
    return argError(io, sub, '未配置仓库标识（.dsh/pipeline.json 缺少 repo）')
  }

  const runner = deps.runner
  const view = prView(pr.value, { repo, runner })
  if (!view.ok) return argError(io, sub, `无法读取 PR #${pr.value}: ${view.error}`)
  const headSha = view.data?.headRefOid
  if (typeof headSha !== 'string' || !SHA_PATTERN.test(headSha)) {
    return argError(io, sub, `PR #${pr.value} 没有可用的 head 提交: ${String(headSha)}`)
  }

  const diffResult = prDiff(pr.value, { repo, runner })
  if (!diffResult.ok) return argError(io, sub, `无法读取 PR #${pr.value} 的 diff: ${diffResult.error}`)
  const diff = typeof diffResult.data === 'string' ? diffResult.data : ''

  // gh 给了改动文件就用它；没给时从 diff 的 `+++ b/<path>` 头还原——
  // files 空着会让高风险判定静默放行，这层兜底不能省。
  const fromGh = Array.isArray(view.data.files)
    ? view.data.files
        .map((item) => item?.path)
        .filter((path) => typeof path === 'string' && path.length > 0)
    : []
  const files = fromGh.length > 0 ? fromGh : diffPaths(diff)

  // files 空着会让高风险判定静默放行：diff 有内容却一个文件都解析不出来，
  // 说明解析口径跟不上这份 diff，宁可拒绝也不落盘请求文件。
  if (files.length === 0 && diff.length > 0) {
    return argError(io, sub, '无法从 diff 解析改动文件，拒绝写出空 files 的请求')
  }

  const request = {
    pr: pr.value,
    head_sha: headSha,
    round: round.value,
    nonce: makeNonce(),
    model: nonEmpty(options.model) ? options.model : null,
    // provider / form 由 publish 的同名参数决定，prepare 只占位留空
    provider: null,
    form: null,
    files,
    diff,
  }
  // 证据包是可选字段：没给参数就一个键都不加，旧消费方读到的请求逐字节不变。
  if (facts !== undefined) request.facts = facts
  if (includes !== undefined) request.includes = includes

  const target =
    options.out !== undefined ? options.out : join(root, '.tmp', 'review', String(pr.value), 'request.json')
  try {
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, `${JSON.stringify(request, null, 2)}\n`, 'utf8')
  } catch (error) {
    return argError(io, sub, `写入请求文件失败: ${messageOf(error)}`)
  }

  io.out(`请求文件: ${target}`)
  io.out(`nonce: ${request.nonce}`)
  io.out(`head: ${headSha.slice(0, 7)}`)
  return 0
}

/**
 * review publish：读审核响应并落盘。判定解析、审计兜底与写盘全部交给 runRecord——
 * 与 `record` 是同一条代码路径，不是第二套实现；错误前缀沿用 record 也正因如此。
 * 这里只做请求文件定位与轮次 / 提供方口径的前置校验。
 */
function runReviewPublish(argv, deps, io) {
  const sub = 'review publish'
  const parsed = parseArgs(argv, REVIEW_PUBLISH_VALUE_FLAGS, REVIEW_PUBLISH_BOOL_FLAGS)
  if (parsed.error) return argError(io, sub, parsed.error)
  const options = parsed.options

  const pr = parsePr(options.pr)
  if (pr.error) return argError(io, sub, pr.error)
  if (!nonEmpty(options.response)) return argError(io, sub, '缺少必填参数 --response')
  if (options.request !== undefined && !nonEmpty(options.request)) {
    return argError(io, sub, '--request 必须是非空文件路径')
  }
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, sub, '--root 必须是非空目录路径')
  }
  if (options.model !== undefined && !nonEmpty(options.model)) {
    return argError(io, sub, '--model 必须是非空字符串')
  }
  if (options.provider !== undefined && !nonEmpty(options.provider)) {
    return argError(io, sub, '--provider 必须是非空字符串')
  }
  if (options.form !== undefined && !nonEmpty(options.form)) {
    return argError(io, sub, '--form 必须是非空字符串')
  }
  const explicitRound = options.round === undefined ? null : parseRound(options.round)
  if (explicitRound !== null && explicitRound.error) return argError(io, sub, explicitRound.error)

  const root = resolveReviewRoot(options.root, deps)
  const requestFile =
    options.request !== undefined
      ? options.request
      : join(root, '.tmp', 'review', String(pr.value), 'request.json')

  const raw = readTextFile(requestFile, '请求文件')
  if (raw.error) return argError(io, sub, raw.error)
  let payload
  try {
    payload = JSON.parse(raw.text)
  } catch {
    return argError(io, sub, `请求文件不是合法 JSON: ${requestFile}`)
  }
  if (!isPlainObject(payload)) return argError(io, sub, '请求内容必须是 JSON 对象')
  const request = requestOf(payload)

  if (Number.isInteger(request.pr) && request.pr !== pr.value) {
    return argError(io, sub, `--pr ${pr.value} 与请求中的 pr ${request.pr} 不符`)
  }

  // 轮次口径：显式 --round 必须与请求一致——拿错请求文件要当场失败，
  // 不能把第 2 轮的判定静默写成第 1 轮（或反过来）。
  let round
  if (explicitRound !== null) {
    if (request.round !== undefined && request.round !== explicitRound.value) {
      return argError(io, sub, `--round ${explicitRound.value} 与请求中的轮次 ${String(request.round)} 不一致`)
    }
    round = explicitRound.value
  } else if (request.round === undefined) {
    round = 1
  } else if (Number.isInteger(request.round) && request.round >= 1 && request.round <= MAX_ROUND) {
    round = request.round
  } else {
    return argError(io, sub, `请求中的 round 必须是 1..${MAX_ROUND} 的整数: ${String(request.round)}`)
  }

  const forward = [
    '--request',
    requestFile,
    '--response',
    options.response,
    '--root',
    root,
    '--round',
    String(round),
  ]
  if (nonEmpty(options.model)) forward.push('--model', options.model)
  // provider / form：publish 参数优先，缺省取请求里的值，都没有才落到 record 的默认值
  const provider = nonEmpty(options.provider) ? options.provider : request.provider
  if (nonEmpty(provider)) forward.push('--provider', provider)
  const form = nonEmpty(options.form) ? options.form : request.form
  if (nonEmpty(form)) forward.push('--form', form)

  return runRecord(forward, deps, io)
}

/**
 * review prompt：只读请求 JSON，用 buildPrompt 组出审核提示词，不发任何外部命令。
 *
 * --request 必须显式给，不做 .tmp/review/<pr>/request.json 的缺省回退：
 * 提示词一旦发给 reviewer 就收不回来，「拿错文件」的代价远高于多打一个参数。
 * --role 从仓库配置里取该角色的 instructions（默认角色 + roles 覆盖），未知角色退出 2。
 */
function runReviewPrompt(argv, deps, io) {
  const sub = 'review prompt'
  const parsed = parseArgs(argv, REVIEW_PROMPT_VALUE_FLAGS, REVIEW_PROMPT_BOOL_FLAGS)
  if (parsed.error) return argError(io, sub, parsed.error)
  const options = parsed.options

  if (!nonEmpty(options.request)) return argError(io, sub, '缺少必填参数 --request')
  if (options.out !== undefined && !nonEmpty(options.out)) {
    return argError(io, sub, '--out 必须是非空文件路径')
  }
  if (options.role !== undefined && !nonEmpty(options.role)) {
    return argError(io, sub, '--role 必须是非空角色名')
  }

  const raw = readTextFile(options.request, '请求文件')
  if (raw.error) return argError(io, sub, raw.error)
  let payload
  try {
    payload = JSON.parse(raw.text)
  } catch {
    return argError(io, sub, `请求文件不是合法 JSON: ${options.request}`)
  }
  if (!isPlainObject(payload)) return argError(io, sub, '请求内容必须是 JSON 对象')

  let role = {}
  if (options.role !== undefined) {
    try {
      const { config } = loadConfig(resolveReviewRoot(undefined, deps))
      const roles = resolveRoles(config)
      if (!Object.hasOwn(roles, options.role)) {
        return argError(io, sub, `未知角色: ${options.role}`)
      }
      role = roles[options.role]
    } catch (error) {
      return argError(io, sub, messageOf(error))
    }
  }

  const prompt = buildPrompt({ request: requestOf(payload), role })

  if (options.out === undefined) {
    io.out(prompt)
    return 0
  }
  try {
    mkdirSync(dirname(options.out), { recursive: true })
    writeFileSync(options.out, `${prompt}\n`, 'utf8')
  } catch (error) {
    return argError(io, sub, `写入提示词失败: ${messageOf(error)}`)
  }
  io.out(`已写入 ${options.out}`)
  return 0
}

/** review：动作是位置参数（prepare / publish / prompt），选项交给各自的解析。 */
function runReview(argv, deps, io) {
  const [action, ...rest] = argv
  if (action === undefined || action.startsWith('--')) {
    return argError(io, 'review', '用法: dsh-pipeline review <prepare|publish|prompt> [选项]')
  }
  if (action === 'prepare') return runReviewPrepare(rest, deps, io)
  if (action === 'publish') return runReviewPublish(rest, deps, io)
  if (action === 'prompt') return runReviewPrompt(rest, deps, io)
  return argError(io, 'review', `未知动作: ${action}（允许 prepare / publish / prompt）`)
}

/** 读取 <root>/.dsh-web/reviews 下的有效记录及无法解析的数量。 */
function collectRecords(root) {
  const dir = reviewsDir(root)
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return { records: [], invalid: 0 }
    throw error
  }

  const records = []
  let invalid = 0
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    const file = join(dir, entry.name)
    try {
      const record = readRecord(file)
      const created = Date.parse(record.createdAt)
      let mtime = 0
      try {
        mtime = statSync(file).mtimeMs
      } catch {
        mtime = 0
      }
      records.push({
        record,
        time: Number.isNaN(created) ? mtime : created,
        mtime,
      })
    } catch {
      invalid += 1
    }
  }

  records.sort((a, b) => b.time - a.time || b.mtime - a.mtime)
  return { records, invalid }
}

/** doctor：检查各仓装的共享包是不是同一个构建。 */
function runDoctor(argv, deps, io) {
  const parsed = parseArgs(argv, new Set(['repo', 'expect']), new Set(['json']))
  if (parsed.error) return argError(io, 'doctor', parsed.error)

  const raw = parsed.options.repo
  // 逗号分隔多值（parseArgs 不接受重复参数，保持其它子命令的口径一致）；
  // 缺省用当前目录，与其他子命令一致（deps.cwd 可能没传）。
  const cwd = nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  const roots =
    raw === undefined
      ? [cwd]
      : String(raw)
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
  if (roots.length === 0) return argError(io, 'doctor', '--repo 至少需要一个非空目录路径')

  const { rows, baseline, drift } = diagnose(roots)
  const allSource = rows.length > 0 && rows.every((row) => row.source === true)

  if (parsed.options.json === true) {
    io.out(
      JSON.stringify(
        {
          baseline,
          drift,
          rows: rows.map((row) => ({
            root: row.root,
            installed: row.installed,
            source: row.source === true,
            build: row.build,
          })),
        },
        null,
        2,
      ),
    )
  } else {
    for (const row of rows) io.out(`${row.root}\t${describeRow(row)}`)
    if (baseline === null && !allSource) {
      io.out('doctor: 没有任何仓装的包带构建标识（旧版本包，需重新打包并刷新）')
    }
  }

  // 退出码在两种输出模式之间必须一致：CI 常用 --json，不能因为换了输出格式就当成功
  if (allSource) return 0
  if (baseline === null) return 1

  const expected = nonEmpty(parsed.options.expect) ? String(parsed.options.expect).toLowerCase() : null
  if (expected !== null && !buildMatchesExpected(baseline, expected)) {
    io.err(`doctor: 基准构建 ${baseline.slice(0, 7)} 与期望 ${expected.slice(0, 7)} 不一致`)
    return 1
  }
  if (drift.length > 0) {
    io.err(`doctor: 以下仓装的不是同一构建（基准 ${baseline.slice(0, 7)}）: ${drift.join(', ')}`)
    return 1
  }
  return 0
}

/** --expect 允许传短 sha（输出里都是 7 位），任一方向前缀匹配即算一致。 */
function buildMatchesExpected(actual, expected) {
  if (actual === expected) return true
  return actual.startsWith(expected) || expected.startsWith(actual)
}

function runStatus(argv, deps, io) {
  const parsed = parseArgs(argv, STATUS_VALUE_FLAGS, STATUS_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'status', parsed.error)
  const root = requireRoot(parsed.options.root)
  if (root.error) return argError(io, 'status', root.error)

  let collected
  try {
    collected = collectRecords(root.value)
  } catch (error) {
    io.err(`status: 读取审核记录失败: ${messageOf(error)}`)
    return 2
  }

  io.out(`审核记录: ${collected.records.length} 条`)
  if (collected.records.length === 0) {
    io.out('最近一条: 无')
  } else {
    const { record } = collected.records[0]
    const sha = typeof record.head_sha === 'string' ? record.head_sha.slice(0, 8) : '未知'
    io.out(
      `最近一条: PR #${record.pr} 第 ${record.round} 轮 结论 ${record.verdict}（提交 ${sha}）`,
    )
  }
  if (collected.invalid > 0) io.out(`无法解析的记录: ${collected.invalid} 条`)
  return 0
}

/**
 * task：issue 号是位置参数（唯一一个），其余走 --root。
 * 参数错误一律 2，流程失败也一律 2——task 没有「闸门拒绝」这种中间态。
 */
function runTask(argv, deps, io) {
  const [first, ...rest] = argv
  if (first === undefined) return argError(io, 'task', '用法: dsh-pipeline task <issue号> [--root <dir>]')
  if (first.startsWith('--')) return argError(io, 'task', `缺少 issue 号（用法: dsh-pipeline task <issue号>）`)
  if (!/^[1-9][0-9]*$/.test(first)) return argError(io, 'task', `issue 号必须是正整数: ${first}`)

  const parsed = parseArgs(rest, TASK_VALUE_FLAGS, TASK_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'task', parsed.error)
  if (parsed.options.root !== undefined && !nonEmpty(parsed.options.root)) {
    return argError(io, 'task', '--root 必须是非空目录路径')
  }

  const result = runTaskFlow({
    issue: Number(first),
    slug: parsed.options.slug,
    root: parsed.options.root,
    cwd: nonEmpty(deps.cwd) ? deps.cwd : process.cwd(),
    runner: deps.runner,
    sleep: deps.sleep,
    exists: deps.exists,
  })
  if (!result.ok) {
    io.err(`task: ${result.error}`)
    return 2
  }
  result.lines.forEach((line, index) => io.out(index === 0 ? `task: ${line}` : line))
  return 0
}

/** pr：没有位置参数；分支名与 issue 号都由当前分支推导。 */
function runPr(argv, deps, io) {
  const parsed = parseArgs(argv, PR_VALUE_FLAGS, PR_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'pr', parsed.error)
  if (parsed.options.root !== undefined && !nonEmpty(parsed.options.root)) {
    return argError(io, 'pr', '--root 必须是非空目录路径')
  }
  if (parsed.options.issue !== undefined && !/^[1-9][0-9]*$/.test(String(parsed.options.issue))) {
    return argError(io, 'pr', `--issue 必须是正整数: ${String(parsed.options.issue)}`)
  }

  const result = runPrFlow({
    root: parsed.options.root,
    issue: parsed.options.issue === undefined ? undefined : Number(parsed.options.issue),
    cwd: nonEmpty(deps.cwd) ? deps.cwd : process.cwd(),
    runner: deps.runner,
  })
  if (!result.ok) {
    io.err(`pr: ${result.error}`)
    return 2
  }
  result.lines.forEach((line, index) => io.out(index === 0 ? `pr: ${line}` : line))
  return 0
}

/**
 * CLI 主入口。deps 可注入 runner 与输出流，便于测试；缺省走真实实现。
 * @param {string[]} argv
 * @param {{ runner?: Function, cwd?: string, stdout?: Function, stderr?: Function }} [deps]
 * @returns {number} 退出码
 */
export function runCli(argv, deps = {}) {
  const writeOut = typeof deps.stdout === 'function' ? deps.stdout : (text) => process.stdout.write(text)
  const writeErr = typeof deps.stderr === 'function' ? deps.stderr : (text) => process.stderr.write(text)
  const io = {
    out: (text) => writeOut(`${text}\n`),
    err: (text) => writeErr(`${text}\n`),
  }

  const [first, ...rest] = argv

  if (first === '-h' || first === '--help' || first === undefined) {
    io.out(HELP)
    return 0
  }
  if (first === '-v' || first === '--version') {
    io.out(`${pkg.version} (${describeBuild()})`)
    return 0
  }
  if (!IMPLEMENTED.has(first)) {
    if (SUBCOMMANDS.includes(first)) {
      io.err(`dsh-pipeline ${first}: 未实现`)
      return 2
    }
    io.err(`dsh-pipeline: 未知子命令 "${first}"`)
    io.err(HELP)
    return 2
  }

  try {
    if (first === 'gate') return runGate(rest, deps, io)
    if (first === 'merge') return runMerge(rest, deps, io)
    if (first === 'record') return runRecord(rest, deps, io)
    if (first === 'task') return runTask(rest, deps, io)
    if (first === 'pr') return runPr(rest, deps, io)
    if (first === 'review') return runReview(rest, deps, io)
    if (first === 'doctor') return runDoctor(rest, deps, io)
    return runStatus(rest, deps, io)
  } catch (error) {
    io.err(`dsh-pipeline ${first}: ${messageOf(error)}`)
    return 2
  }
}

/** 仅在作为可执行文件直接运行时自动执行；被 import 时不产生副作用。 */
function invokedDirectly() {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  process.exit(runCli(process.argv.slice(2)))
}
