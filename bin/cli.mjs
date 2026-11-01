#!/usr/bin/env node
/**
 * dsh-pipeline CLI：参数解析与四个子命令的编排。
 *
 * 判定、读写、执行全部复用 lib/，本文件不复制任何业务规则：
 * gate 走 decideGate()；merge 整条流程（闸门 → CI → squash 合并 → 清理现场）交给
 * lib/merge.mjs，合并方式由 gh.prMerge 固定为 --squash。
 *
 * 输出约定：面向人的信息走 stdout，错误与警告走 stderr，全部中文。
 * 退出码：0 通过 / 1 闸门拒绝 / 2 参数或环境错误。
 * runner 可注入，测试用假 runner 断言实际发出的命令，不碰真实 gh/git。
 */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { evaluateGate } from '../lib/gate.mjs'
import { prChecks, prMerge, prView } from '../lib/gh.mjs'
import {
  deleteBranch,
  fetch as gitFetch,
  headSha as gitHeadSha,
  mergeFF,
  worktreeList,
  worktreeRemove,
} from '../lib/git.mjs'
import { runMerge as runMergeFlow } from '../lib/merge.mjs'
import { NONCE_PATTERN, extractFindings, parseVerdict } from '../lib/review.mjs'
import {
  MAX_ROUND,
  SHA_PATTERN,
  readRecord,
  reviewsDir,
  writeRecord,
  writeSkipAudit,
} from '../lib/record.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const IMPLEMENTED = new Set(['gate', 'merge', 'record', 'status'])
const SUBCOMMANDS = ['task', 'prepare', 'pr', 'merge', 'gate', 'record', 'status']

const HELP = `dsh-pipeline ${pkg.version} — 统一交付与审核流程的单一实现

用法: dsh-pipeline <子命令> [选项]

子命令:
  gate       审核闸门检查
  merge      闸门通过后合并 PR（固定 --squash）并清理现场
  record     把审核响应落盘为记录
  status     查看审核记录概况
  task       任务生命周期（未实现）
  prepare    准备交付（未实现）
  pr         创建/更新 PR（未实现）

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
  --request <file>   审核请求 JSON
  --response <file>  reviewer 响应文本
  --round <n>        审核轮次（1..${MAX_ROUND}，默认 1）
  记录写入当前工作目录的 .dsh-web/reviews

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
const RECORD_VALUE_FLAGS = new Set(['request', 'response', 'round'])
const RECORD_BOOL_FLAGS = new Set()
const STATUS_VALUE_FLAGS = new Set(['root'])
const STATUS_BOOL_FLAGS = new Set()

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

function runRecord(argv, deps, io) {
  const parsed = parseArgs(argv, RECORD_VALUE_FLAGS, RECORD_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'record', parsed.error)
  const options = parsed.options

  if (!nonEmpty(options.request)) return argError(io, 'record', '缺少必填参数 --request')
  if (!nonEmpty(options.response)) return argError(io, 'record', '缺少必填参数 --response')
  const round = parseRound(options.round)
  if (round.error) return argError(io, 'record', round.error)

  const requestFile = readTextFile(options.request, '请求文件')
  if (requestFile.error) return argError(io, 'record', requestFile.error)
  let request
  try {
    request = JSON.parse(requestFile.text)
  } catch {
    return argError(io, 'record', `请求文件不是合法 JSON: ${options.request}`)
  }
  if (!isPlainObject(request)) return argError(io, 'record', '请求内容必须是 JSON 对象')
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

  const verdict = parseVerdict(response, { nonce: request.nonce, diff: request.diff })
  if (!verdict.ok) {
    return argError(io, 'record', '无法从响应中解析出唯一且带正确标记的判定行')
  }
  if (verdict.sha !== request.head_sha) {
    return argError(
      io,
      'record',
      `判定针对提交 ${verdict.sha}，与请求提交 ${request.head_sha} 不一致`,
    )
  }

  const extracted = extractFindings(response)
  if (extracted.warn !== null) io.err(`record: 提示: ${extracted.warn}`)

  const record = {
    pr: request.pr,
    round: round.value,
    verdict: verdict.verdict,
    head_sha: request.head_sha,
    findings: extracted.findings,
    evidence: extracted.evidence,
    createdAt: new Date().toISOString(),
  }
  if (typeof request.traceId === 'string' && request.traceId.length > 0) {
    record.traceId = request.traceId
  }

  const cwd = nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  try {
    const file = writeRecord(reviewsDir(cwd), record)
    io.out(`已写入审核记录: ${file}`)
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
