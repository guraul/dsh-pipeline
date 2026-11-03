#!/usr/bin/env node
/**
 * dsh-pipeline CLI：参数解析与子命令的编排。
 *
 * 判定、读写、执行全部复用 lib/，本文件不复制任何业务规则：
 * gate 走 decideGate()；merge 整条流程（闸门 → CI → squash 合并 → 清理现场）交给
 * lib/merge.mjs，合并方式由 gh.prMerge 固定为 --squash；
 * task / pr 的流程分别交给 lib/task.mjs 与 lib/pr.mjs。
 *
 * 输出约定：面向人的信息走 stdout，错误与警告走 stderr，全部中文。
 * 退出码：0 通过 / 1 闸门拒绝 / 2 参数或环境错误。
 * runner 可注入，测试用假 runner 断言实际发出的命令，不碰真实 gh/git。
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from '../lib/config.mjs'
import { evaluateGate } from '../lib/gate.mjs'
import { prChecks, prMerge, prView } from '../lib/gh.mjs'
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
import { NONCE_PATTERN, analyzeVerdict, extractFindings } from '../lib/review.mjs'
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

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const IMPLEMENTED = new Set(['gate', 'merge', 'record', 'status', 'task', 'pr'])
const SUBCOMMANDS = ['task', 'prepare', 'pr', 'merge', 'gate', 'record', 'status']

const HELP = `dsh-pipeline ${pkg.version} — 统一交付与审核流程的单一实现

用法: dsh-pipeline <子命令> [选项]

子命令:
  gate       审核闸门检查
  merge      闸门通过后合并 PR（固定 --squash）并清理现场
  record     把审核响应落盘为记录
  status     查看审核记录概况
  task       从 issue 创建 task/<号>-<slug> 分支与 worktree
  prepare    准备交付（未实现）
  pr         推送当前 task 分支并创建 PR

task 用法:
  dsh-pipeline task <issue号> [--root <dir>]
  --root <dir>       仓库根目录（缺省取主工作区；在 worktree 里运行会自动上溯）
  幂等：worktree 已存在时只打印路径；路径被别的目录占用时报错退出 2。

pr 用法:
  dsh-pipeline pr [--root <dir>]
  --root <dir>       仓库根目录（缺省取当前 task worktree 的顶层目录）
  当前分支必须是 task/<号>-<slug>；PR 已存在时只打印链接。

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
const TASK_VALUE_FLAGS = new Set(['root'])
const TASK_BOOL_FLAGS = new Set()
const PR_VALUE_FLAGS = new Set(['root'])
const PR_BOOL_FLAGS = new Set()

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
        deleteBranch: (cwd, name) => deleteBranch(cwd, name, { runner }),
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

/** 请求没带 files 时从 diff 的 `+++ b/<path>` 头还原，避免高风险判定因缺文件列表而静默放行。 */
function diffPaths(diff) {
  const paths = new Set()
  for (const line of String(diff ?? '').split('\n')) {
    const match = /^\+\+\+ b\/(.+)$/.exec(line)
    if (match) paths.add(match[1])
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

  const result = runPrFlow({
    root: parsed.options.root,
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
    io.out(pkg.version)
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
