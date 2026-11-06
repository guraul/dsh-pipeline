#!/usr/bin/env node
/**
 * dsh-pipeline CLI：参数解析与子命令的编排。
 *
 * 判定、读写、执行全部复用 lib/，本文件不复制任何业务规则：
 * gate 走 decideGate()；merge 整条流程（闸门 → CI → squash 合并 → 清理现场）交给
 * lib/merge.mjs，合并方式由 gh.prMerge 固定为 --squash；
 * task / pr 的流程分别交给 lib/task.mjs 与 lib/pr.mjs；
 * review 的 publish 复用 runRecord（与 record 同一条落盘路径），prepare 只编排 gh 读取，
 * --post-review 在落盘成功后把判定发成 GitHub review（幂等，见 sendReview），
 * prompt 只读请求文件并复用 buildPrompt（不发外部命令、不写请求）；
 * selftest 只做参数编排与输出，检查逻辑在 lib/selftest.mjs（契约 §9，已实现 --shims / --config / --repos）；
 * shim 的渲染 / 写入 / 比对全在 lib/shim.mjs（契约 §8），这里只做动作与参数解析；
 * check-all 的逐包执行与汇总在 lib/check-all.mjs，这里只做包发现与参数解析；
 * deploy 的骨架渲染、生成区提取与逐字节比对全在 lib/deploy.mjs（契约 §10），这里只做动作与参数解析。
 *
 * 输出约定：面向人的信息走 stdout，错误与警告走 stderr，全部中文。
 * 退出码：0 通过 / 1 闸门拒绝 / 2 参数或环境错误 / 3 环境错误（--post-review 的 gh 调用失败）。
 * runner 可注入，测试用假 runner 断言实际发出的命令，不碰真实 gh/git。
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverPackages, runCheckAll as runCheckAllFlow } from '../lib/check-all.mjs'
import { loadConfig } from '../lib/config.mjs'
import {
  DEPLOY_WORKFLOW_FILE,
  DeployError,
  REGION_BEGIN,
  REGION_END,
  extractRegion,
  firstDifference,
  renderRegion,
  replaceRegion,
} from '../lib/deploy.mjs'
import { evaluateGate } from '../lib/gate.mjs'
import { issueView, prChecks, prDiff, prMerge, prView } from '../lib/gh.mjs'
import { checkHook, installHook } from '../lib/hooks.mjs'
import {
  branchShow,
  checkout,
  currentBranch,
  deleteBranch,
  fetch as gitFetch,
  gitCommonDir,
  headOneline,
  headSha as gitHeadSha,
  mergeFF,
  statusPorcelain,
  toplevel,
  worktreeList,
  worktreeListPlain,
  worktreeRemove,
} from '../lib/git.mjs'
import { runMerge as runMergeFlow } from '../lib/merge.mjs'
import { mergePolicy } from '../lib/policy.mjs'
import { runPr as runPrFlow } from '../lib/pr.mjs'
import { resolveMainRoot } from '../lib/repo.mjs'
import { PENDING_CHECKS, checkRepos, runChecks } from '../lib/selftest.mjs'
import { SHIM_ENTRIES, checkShims, installShims } from '../lib/shim.mjs'
import {
  NONCE_PATTERN,
  analyzeVerdict,
  buildPrompt,
  buildReviewBody,
  createPullReview,
  detectIssueFromBody,
  extractFindings,
  listPullReviews,
  makeNonce,
  reviewEvent,
  reviewMarker,
} from '../lib/review.mjs'
import { resolveRoles } from '../lib/roles.mjs'
import {
  MAX_ROUND,
  PACKAGE_VERSION,
  SCHEMA_VERSION,
  SHA_PATTERN,
  readRecord,
  recordFile,
  reviewsDir,
  writeRecord,
  writeSkipAudit,
} from '../lib/record.mjs'
import { runTask as runTaskFlow } from '../lib/task.mjs'
import { describeBuild, readBuildInfo } from '../lib/build-info.mjs'
import { describeRow, diagnose } from '../lib/doctor.mjs'
import { checkProfile } from '../lib/profile-check.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const IMPLEMENTED = new Set([
  'check-all',
  'deploy',
  'doctor',
  'gate',
  'hooks',
  'merge',
  'record',
  'selftest',
  'shim',
  'status',
  'task',
  'pr',
  'review',
])
const SUBCOMMANDS = [
  'task',
  'prepare',
  'pr',
  'merge',
  'gate',
  'record',
  'status',
  'doctor',
  'review',
  'selftest',
  'shim',
  'check-all',
  'hooks',
  'deploy',
]

const HELP = `dsh-pipeline ${pkg.version} — 统一交付与审核流程的单一实现

用法: dsh-pipeline <子命令> [选项]

子命令:
  gate       审核闸门检查
  merge      闸门通过后合并 PR（固定 --squash）并清理现场
  record     把审核响应落盘为记录
  status     查看仓库概览与审核记录概况
  doctor     检查各仓装的共享包是不是同一个构建（比对 build.json）
  --repo <a,b>       要检查的仓库根（逗号分隔；缺省当前目录）
  --json             机器可读输出（退出码与人读模式一致）
  --expect <sha>     期望的构建 sha（可传 7 位短 sha；不一致则退出 1）
  --profile <dir>    可选：额外体检 profile——包声明（旧包已无 / 新包已有）、插件软链有效性、
                     dsh --dump-config 可见性（dsh 不可用时跳过不算失败）、cordis.patch.yml、
                     审核记录目录可写；逐项 ✓/✗，任一 ✗ 退出 1。不给该 flag 则只比构建，
                     行为与现状一致
  selftest   一致性自检（契约 §9；已实现 --shims / --config / --repos，--peer/--exit-codes 未实现）
  shim       生成 / 校验入口 shim（契约 §8）
  hooks      安装 / 校验 pre-push 直推拦截钩子
  check-all  逐包跑 test / check / typecheck 并汇总（缺 node_modules 跳过不算失败）
  deploy     生成 / 校验部署 caller workflow 骨架（契约 §10）
  task       从 issue 创建 task/<号>-<slug> 分支与 worktree
  prepare    准备交付（未实现）
  pr         推送当前 task 分支并创建 PR
  review     生成审核请求（prepare）、审核提示词（prompt）并把判定落成记录（publish）

selftest 用法:
  dsh-pipeline selftest [--shims | --config | --fast | --repos <a,b,c>] [--json] [--root <dir>]
  --shims            6 个入口 == 按当前包版本渲染后的模板（<root>/scripts/pipeline 不存在即失败）
  --config           校验 <root>/.dsh/pipeline.json：能被 schema 接受、没有未声明字段
  --fast             等价于 --shims --config（契约 §9 的 pre-push 用法；不含 --repos）
  --repos <a,b,c>    比对多个仓装的共享包是不是同一构建（读各自 build.json 的 gitSha/builtAt）。
                     绝对路径直接用、相对路径按 --root（缺省当前目录）解析、前导 ~/ 展开成家目录；
                     目录不存在或未装包的仓跳过并列出，可比对的仓不足 2 个则跳过退出 0；
                     与 --shims / --config / --fast 互斥
  --json             输出 {"ok":true|false,"root":"…","checks":[{"name":"…","ok":…,"detail":"…"}]}；
                     带 --repos 时改为 {"ok":…,"baseline":"…","repos":[{"path","sha","builtAt","ok"}],"skipped":[{"path","reason"}]}
                     （退出码与人读模式一致）
  --root <dir>       仓库根目录（缺省主工作区；git 定位不到时退回当前目录）；--repos 用它解析相对路径
  --peer / --exit-codes  已识别但尚未实现：传入即报「尚未实现」并退出 2，不静默忽略
  退出码: 0 通过（没有配置文件也退 0）/ 1 检查不通过 / 2 用法错误或检查项未实现

shim 用法:
  dsh-pipeline shim install [--root <dir>] [--force]
  在 <root>/scripts/pipeline/ 生成 6 个入口（权限 0755）；已存在且内容相同则跳过，
  内容不同且没给 --force 时报错退出 1。成功每个文件打一行「写入: <相对路径>」。
  dsh-pipeline shim check [--root <dir>]
  用当前包版本渲染模板后与磁盘逐字节比对（契约 §8）；不一致退出 1，
  <root>/scripts/pipeline 不存在时提示先跑 shim install。
  --root <dir>       仓库根目录（缺省主工作区；git 定位不到时退回当前目录）
  --force            仅 install：覆盖内容不同的已存在文件
  退出码: 0 一致 / 1 不一致或内容冲突 / 2 用法错误

hooks 用法:
  dsh-pipeline hooks install [--root <dir>] [--force] [--allow-main]
  把 pre-push 钩子装进主仓 git 目录的 hooks/pre-push（用 rev-parse --git-common-dir 定位，
  worktree 里也装到所有 worktree 共用的那一份；目录不存在则创建，权限 0755）。
  钩子拦截直推 main / master：stdin 的 remote_ref 是 refs/heads/main（或 master）时
  stderr 打一行拒绝原因并退出 1，其余放行。
  已存在且内容不同：不是本工具装的（没有标记行）默认拒绝覆盖并退出 1，加 --force 才覆盖；
  带标记行的旧版本直接覆盖（幂等）。新装打「hooks: 已安装 <路径>」，覆盖打「hooks: 已更新 <路径>」。
  --allow-main       装一个不拦截的版本（确实需要直推的仓）
  dsh-pipeline hooks check [--root <dir>]
  校验已装钩子与本包当前版本生成的内容一致；未装退出 1 并提示 hooks install。
  --root <dir>       仓库根目录（缺省主工作区；git 定位不到时退回当前目录）
  退出码: 0 一致 / 1 未装、不一致或拒绝覆盖 / 2 用法或环境错误

check-all 用法:
  dsh-pipeline check-all [--root <dir>] [--packages a,b,c] [--json]
  --root <dir>       仓库根目录（缺省当前工作目录）
  --packages a,b,c   要检查的包目录（逗号分隔，相对 <root>）；缺省读配置 checks.packages
                     （非空时按给定顺序，不自动发现）；再缺省自动发现：<root> 下
                     每个含 package.json 的子目录（跳过 node_modules 与 . 开头的目录），
                     并按配置 checks.exclude 过滤
  --json             输出 {"ok":…,"packages":[{"dir":"…","checks":[{"name":"…","ok":…,"skipped":…,"code":…}]}]}
                     （退出码与人读模式一致）
  每项一行 <包目录> | <检查> | <结果>，末行 check-all: N 个包，X 通过 / Y 失败 / Z 跳过；
  缺 node_modules 的包三项都记「跳过（未安装依赖）」，不算失败；包目录不存在记失败。
  退出码: 0 全部通过（含全跳过）/ 1 有失败 / 2 用法错误 / 3 找不到 pnpm

deploy 用法:
  dsh-pipeline deploy init --root <dir> [--write]
  按 <root>/.dsh/pipeline.json 的 deploy 段生成 <root>/.github/workflows/deploy-web.yml 骨架：
  生成区 = name / on / concurrency + 单个 job 的 uses + with + secrets，首尾用注释标记包裹；
  uses pin 当前安装包 build.json 的 gitSha（源码运行没有 build.json → 退 2）。
  mode 由 artifact 推导（static-dir → releases）。node-standalone / oci-image 现在只收配置，
  生成骨架时明确报「尚未实现」退 2（deploy.yml 的构建步骤尚未参数化）。
  不带 --write 只把骨架打印到 stdout；--write 时：文件不存在则创建，
  已有生成区则只替换生成区、保留标记之后本仓追加的后置 job，
  已存在但缺标记（手写文件）则拒绝覆盖并退 1。
  dsh-pipeline deploy check --root <dir>
  取出生成区与按配置渲染的期望值逐字节比对：一致退 0；
  不一致打印第一处差异（行号 + 期望 / 实际两行）退 1；
  缺标记报「不是生成的骨架」退 1；文件不存在提示先跑 deploy init（退 1）。
  --root <dir>       仓库根目录（必填）
  退出码: 0 一致 / 1 不一致、缺标记或拒绝覆盖 / 2 用法、配置错误或 artifact 尚未实现

task 用法:
  dsh-pipeline task <issue号> [--slug <slug>] [--root <dir>] [--worktrees-dir <dir>]
  --slug <slug>      手动指定分支/目录后缀（缺省由 issue 标题生成；中文标题会退化成哈希，可读性差时用它）。
                     会规范化：转小写、非字母数字折成 '-'、截断到 40 字符
  --root <dir>       仓库根目录（缺省取主工作区；在 worktree 里运行会自动上溯）
  --worktrees-dir <dir>  worktree 的父目录，内部仍拼 <号>-<slug>；缺省读配置 worktreesDir，再缺省 <root>/.worktrees。
                     flag 优先于配置；相对路径按 --root 解析成绝对路径，前导 ~/ 展开为家目录；
                     目录不存在会自动创建（mkdir -p），已存在则复用。
                     为什么需要它：宿主会从主仓加载源码（如 memx 在仓内切分支会让宿主加载到未合并代码），
                     用它把 worktree 建在仓库外即可避开。
  幂等：worktree 已存在时只打印路径；路径被别的目录占用时报错退出 2。

pr 用法:
  dsh-pipeline pr [--issue <号>] [--root <dir>]
  --issue <号>       分支名不含 issue 号时（如 task/pipeline-gh）用它指定 PR 要关哪个 issue
  --root <dir>       仓库根目录（缺省取当前 task worktree 的顶层目录）
  当前分支必须是 task/<号>-<slug>；PR 已存在时只打印链接。

review 用法:
  dsh-pipeline review prepare --pr <n> [--issue <号>] [--root <dir>] [--model <m>] [--round <n>] [--out <file>]
                               [--facts <文件>] [--include <路径,路径,...>]
  dsh-pipeline review publish --pr <n> --response <file> [--request <file>] [--round <n>]
                               [--root <dir>] [--model <m>] [--provider <p>] [--form <f>]
                               [--post-review] [--dry-run]
  dsh-pipeline review prompt --request <file> [--out <file>] [--role <名>]

  prepare  用 gh 读 PR 的 head 提交、改动文件与 diff，生成请求 JSON（含 12 位 base32 nonce）
           到 <root>/.tmp/review/<pr>/request.json（--out 可改路径）；
           stdout 三行：请求文件路径、nonce、head 前 7 位（取不到 issue 时末尾再补一行提示）。
           --issue <号> 指定被审 PR 对应的 issue，用 gh issue view 取 {number, title, body}
           写进请求的 issue 字段，供 review prompt 渲染「验收依据（issue 正文）」；
           缺省自动探测：用 gh pr view 的 body 拿 PR 正文，从形如 Closes #123 / Fixes #123 /
           Resolved #123 的行里取第一个号；
           探测不到或 gh 取失败时不写 issue 字段、不失败（请求照常产出），
           并在 stdout 三行之后补一行「提示: 未取到 issue 正文（reviewer 的验收依据会是空的）」。
           --facts <文件> 把文件内容作为纯文本写进请求的 facts 字段（缺省不加该字段）；
           --include <路径,路径,...> 逐个读文件写进请求的 includes 数组（每项 {path, content}，
           path 保持调用方给的原样）；任一路径读不到或取值为空即退出 2，不写请求文件。
  publish  读 --response 并落盘 <root>/.dsh-web/reviews/<pr>-<sha>.json，复用 record 的落盘逻辑；
           --request 缺省为 <root>/.tmp/review/<pr>/request.json；
           --round 与请求里的 round 不一致时报错退出 2，没给则沿用请求里的 round。
           判定行无法解析或提交不匹配时仍写一条 ESCALATE 记录，退出码 1（审计轨迹不丢）。
           --post-review 落盘成功后再把判定发成 GitHub review（幂等：同 SHA + 同标记只发一次），
           event 按判定映射 APPROVE→APPROVE、REJECT→REQUEST_CHANGES、ESCALATE→COMMENT，
           repo 取 .dsh/pipeline.json 的 repo（缺 repo 退 2）；发失败退 3，记录不回滚；
           身份（GH_CONFIG_DIR 等）由 gh 自己读环境变量，本命令只透传、不处理。
           --dry-run 不写盘、不发请求，只打印将要发送的 event 与 body 前 200 字。
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
  --review-record <f>  --record 的旧写法，等价于 --record，后续将弃用（两者同时给且取值不同则报错）

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
  --root <dir>       仓库根目录（缺省主工作区；git 定位不到时退回当前目录）
  --json             输出 {"repo":{"root","branch","head","worktrees"},"records":…,"latest":…,"invalid":…}；
                     git 取不到时 repo 的 branch / head 为 null、worktrees 为空数组（退出码与人读模式一致）

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

  // --review-record 是 --record 的旧写法（各仓文档仍在用），两者等价：
  // 只给一个就用那个；同时给且取值不同直接报冲突，不做「谁覆盖谁」的猜测。
  const alias = options['review-record']
  if (alias !== undefined && options.record !== undefined && options.record !== alias) {
    return { error: '--record 与 --review-record 两个参数冲突（取值不同）' }
  }
  const record = options.record !== undefined ? options.record : alias

  if (record !== undefined && options['no-review'] === true) {
    return { error: '不能同时使用 --record 与 --no-review' }
  }
  if (options['no-review'] !== true && options.reason !== undefined) {
    return { error: '--reason 只能与 --no-review 一起使用' }
  }
  if (options['no-review'] === true && !nonEmpty(options.reason)) {
    return { error: '--no-review 必须配合 --reason 说明跳过原因' }
  }
  if (record !== undefined && !nonEmpty(record)) {
    return { error: options.record !== undefined ? '--record 必须是非空文件路径' : '--review-record 必须是非空文件路径' }
  }

  const headSha = options['head-sha']
  if (headSha !== undefined && !SHA_PATTERN.test(headSha)) {
    return { error: `--head-sha 必须是 40 位小写十六进制: ${headSha}` }
  }

  const common = {
    pr: pr.value,
    root: root.value,
    record,
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
// review-record 只给 merge：它是 --record 的旧写法（文档里还在用），gate 不认
const MERGE_VALUE_FLAGS = new Set([...GATE_VALUE_FLAGS, 'checks-file', 'review-record'])
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
const STATUS_BOOL_FLAGS = new Set(['json'])
const TASK_VALUE_FLAGS = new Set(['root', 'slug', 'worktrees-dir'])
const TASK_BOOL_FLAGS = new Set()
const PR_VALUE_FLAGS = new Set(['root', 'issue'])
const PR_BOOL_FLAGS = new Set()
const REVIEW_PREPARE_VALUE_FLAGS = new Set(['pr', 'issue', 'root', 'model', 'round', 'out', 'facts', 'include'])
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
const REVIEW_PUBLISH_BOOL_FLAGS = new Set(['post-review', 'dry-run'])
const REVIEW_PROMPT_VALUE_FLAGS = new Set(['request', 'out', 'role'])
const REVIEW_PROMPT_BOOL_FLAGS = new Set()
const SELFTEST_VALUE_FLAGS = new Set(['root', 'repos'])
// --peer / --exit-codes 只是「被识别」：传了要报尚未实现退 2，不能落进未知选项
const SELFTEST_BOOL_FLAGS = new Set([
  'config',
  'fast',
  'json',
  'shims',
  'peer',
  'exit-codes',
])
const SHIM_INSTALL_VALUE_FLAGS = new Set(['root'])
const SHIM_INSTALL_BOOL_FLAGS = new Set(['force'])
const SHIM_CHECK_VALUE_FLAGS = new Set(['root'])
const SHIM_CHECK_BOOL_FLAGS = new Set()
const HOOKS_INSTALL_VALUE_FLAGS = new Set(['root'])
const HOOKS_INSTALL_BOOL_FLAGS = new Set(['force', 'allow-main'])
const HOOKS_CHECK_VALUE_FLAGS = new Set(['root'])
const HOOKS_CHECK_BOOL_FLAGS = new Set()
const CHECK_ALL_VALUE_FLAGS = new Set(['root', 'packages'])
const CHECK_ALL_BOOL_FLAGS = new Set(['json'])
const DEPLOY_VALUE_FLAGS = new Set(['root'])
const DEPLOY_INIT_BOOL_FLAGS = new Set(['write'])
const DEPLOY_CHECK_BOOL_FLAGS = new Set()

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
  // --issue 可选但给了就必须是正整数：空值 / 0 / abc 当场拒绝，不静默退回自动探测
  if (options.issue !== undefined && !/^[1-9][0-9]*$/.test(options.issue)) {
    return argError(io, sub, `--issue 必须是正整数: ${options.issue}`)
  }
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
      const text = readFileSync(target, 'utf8')
      // 空内容与读不到同口径：没有证据却写成 content: ""，会让 reviewer 以为证据看过是空的
      if (text.trim().length === 0) {
        return { error: `${label} 指定的文件内容为空: ${target}` }
      }
      return { text }
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
    // 重复路径只读一次、只留首见条目（Set 保持插入顺序），不产生两条相同 includes
    const uniquePaths = [...new Set(paths)]
    includes = []
    for (const path of uniquePaths) {
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

  // issue 号：显式 --issue 优先；缺省从 PR 正文的 Closes / Fixes / Resolved #N 行探测。
  // 探测不出号不是错误——请求照常产出，只在 stdout 末尾提示验收依据会是空的。
  const issueNumber =
    options.issue !== undefined ? Number(options.issue) : detectIssueFromBody(view.data?.body)

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

  // issue 正文是 reviewer 的验收依据：取到号后用 gh issue view 取 {number, title, body}。
  // 探测不到号或 gh 取失败都不阻断——不写该字段，末尾提示一行即可。
  let issue = null
  if (issueNumber !== null) {
    const result = issueView(issueNumber, { repo, runner })
    if (result.ok && isPlainObject(result.data)) {
      const data = result.data
      issue = {
        number: Number.isInteger(data.number) && data.number > 0 ? data.number : issueNumber,
        title: typeof data.title === 'string' ? data.title : '',
        body: typeof data.body === 'string' ? data.body : '',
      }
    }
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
  // issue 同样是可选字段：取不到正文就一个键都不加，buildPrompt 那段输出 (空)
  if (issue !== null) request.issue = issue

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
  // 取不到 issue 正文不是失败，但必须让调用方看见：reviewer 的验收依据会是空的
  if (issue === null) io.out('提示: 未取到 issue 正文（reviewer 的验收依据会是空的）')
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

  // --dry-run：只预览将要发送的 event 与 body，不写盘、不发任何请求。
  if (options['dry-run'] === true) {
    return previewPostReview({ root, pr: pr.value, request, responseFile: options.response, io })
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

  const code = runRecord(forward, deps, io)
  if (options['post-review'] !== true) return code
  // 记录写了但判定不可用（退 1）：解析出来的结论不可信，没有可发的 event，
  // 审计留盘即可——不能把 E_PARSE 的兜底 ESCALATE 当成 reviewer 的真实意见发出去。
  if (code !== 0) return code
  return sendReview({ root, pr: pr.value, headSha: request.head_sha, io, runner: deps.runner })
}

/**
 * review publish --dry-run：判定解析与正式落盘同一条口径，但不写盘、不发请求，
 * 只打印将要发送的 event 与 body 前 200 字。
 *
 * 判定不可用时按 ESCALATE 预览，但**不会**真的发 COMMENT：正式路径在
 * `runReviewPublish` 里遇到 `code !== 0`（E_PARSE / E_SHA_MISMATCH 的兜底 ESCALATE）
 * 会直接返回、只留审计记录——预览把这点说清楚，别让人以为真跑会发一条 COMMENT。
 */
function previewPostReview({ root, pr, request, responseFile, io }) {
  // 与 runRecord 同一套前置校验：缺字段在预览阶段就退 2，别让用户等到真跑才发现。
  if (!Number.isInteger(request.pr) || request.pr <= 0) {
    return argError(io, 'review publish', `请求中的 pr 必须是正整数: ${String(request.pr)}`)
  }
  if (typeof request.head_sha !== 'string' || !SHA_PATTERN.test(request.head_sha)) {
    return argError(io, 'review publish', `请求中的 head_sha 必须是 40 位小写十六进制: ${String(request.head_sha)}`)
  }
  if (typeof request.nonce !== 'string' || !NONCE_PATTERN.test(request.nonce)) {
    return argError(io, 'review publish', `请求中的 nonce 必须是 12 位 base32 标记: ${String(request.nonce)}`)
  }

  const raw = readTextFile(responseFile, '响应文件')
  if (raw.error) return argError(io, 'review publish', raw.error)

  const analysis = analyzeVerdict(raw.text, { nonce: request.nonce, diff: request.diff })
  const mismatch = analysis.ok && analysis.sha !== request.head_sha
  const verdict = analysis.ok && !mismatch ? analysis.verdict : 'ESCALATE'
  // 口径对齐 record：解析失败不保留响应里的任何结论；提交不匹配只丢判定、留 findings。
  const findings = analysis.ok ? extractFindings(raw.text).findings : []

  const event = reviewEvent(verdict)
  const body = buildReviewBody({
    nonce: request.nonce,
    verdict,
    headSha: request.head_sha,
    findings,
    recordPath: relative(root, recordFile(reviewsDir(root), pr, request.head_sha)),
  })

  io.out('review publish: --dry-run，不写盘、不发请求')
  io.out(`event: ${event}`)
  io.out(`body（前 200 字）:\n${body.slice(0, 200)}`)
  return 0
}

/**
 * review publish --post-review 的发送段：记录已落盘，把判定发成 GitHub review。
 *
 * 顺序固定：读回记录（拿 verdict / findings）→ 校验配置里的 repo → 列已有 review（幂等）→ POST。
 * 任何一步的 gh 失败都是环境错误：退 3、记录不回滚，并明确告知「记录已写，review 未发出」；
 * 没有 repo 是用法 / 配置错误：退 2。GH_CONFIG_DIR 等身份环境变量只透传给 gh，这里不处理。
 */
function sendReview({ root, pr, headSha, io, runner }) {
  const file = recordFile(reviewsDir(root), pr, headSha)
  let record
  try {
    record = readRecord(file)
  } catch (error) {
    io.err(`review publish: 读取审核记录失败: ${messageOf(error)}（review 未发出）`)
    return 2
  }

  let repo
  try {
    repo = loadConfig(root).config.repo
  } catch (error) {
    io.err(`review publish: 读取配置失败: ${messageOf(error)}（记录已写入，review 未发出）`)
    return 2
  }
  if (!nonEmpty(repo)) {
    io.err('review publish: 配置 .dsh/pipeline.json 缺少 repo，无法发送 review（记录已写入，review 未发出）')
    return 2
  }

  const marker = reviewMarker(headSha)
  const listed = listPullReviews({ repo, pr, runner })
  if (!listed.ok) {
    io.err(listed.error)
    io.err('review publish: 记录已写，review 未发出（读取已有 review 失败）')
    return 3
  }
  const alreadyPosted = listed.data.some(
    (item) =>
      isPlainObject(item) && item.commit_id === headSha && String(item.body ?? '').includes(marker),
  )
  if (alreadyPosted) {
    io.out('review publish: 已存在同 SHA 的 review，跳过发送')
    return 0
  }

  const event = reviewEvent(record.verdict)
  const body = buildReviewBody({
    nonce: record.nonce,
    verdict: record.verdict,
    headSha,
    findings: record.findings,
    recordPath: relative(root, file),
  })

  const posted = createPullReview({ repo, pr, event, body, runner })
  if (!posted.ok) {
    io.err(posted.error)
    io.err('review publish: 记录已写，review 未发出')
    return 3
  }
  io.out(`review publish: 已发送 GitHub review（event=${event}）`)
  return 0
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

  // 残缺请求渲染出来是 undefined VERDICT… SHA: undefined：缺字段当场拒绝，说清缺哪个
  const request = requestOf(payload)
  const missing = ['nonce', 'head_sha'].filter((field) => {
    const value = request[field]
    return typeof value !== 'string' || value.length === 0
  })
  if (missing.length > 0) return argError(io, sub, `请求缺少字段: ${missing.join(', ')}`)

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

  const prompt = buildPrompt({ request, role })

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

/** doctor：检查各仓装的共享包是不是同一个构建；--profile 时额外逐项体检 profile。 */
function runDoctor(argv, deps, io) {
  const parsed = parseArgs(argv, new Set(['repo', 'expect', 'profile']), new Set(['json']))
  if (parsed.error) return argError(io, 'doctor', parsed.error)
  if (parsed.options.profile !== undefined && !nonEmpty(parsed.options.profile)) {
    return argError(io, 'doctor', '--profile 必须是非空目录路径')
  }

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

  // profile 体检（可选）：给了 --profile 才跑；先算好——--json 的载荷与退出码都要用它。
  const wantProfile = parsed.options.profile !== undefined
  const env = deps.env !== undefined ? deps.env : process.env
  const profile = wantProfile
    ? checkProfile(String(parsed.options.profile), { env, repos: roots, runner: deps.runner })
    : null

  if (parsed.options.json === true) {
    const payload = {
      baseline,
      drift,
      rows: rows.map((row) => ({
        root: row.root,
        installed: row.installed,
        source: row.source === true,
        build: row.build,
      })),
    }
    if (profile !== null) payload.profile = profile
    io.out(JSON.stringify(payload, null, 2))
  } else {
    for (const row of rows) io.out(`${row.root}\t${describeRow(row)}`)
    if (baseline === null && !allSource) {
      io.out('doctor: 没有任何仓装的包带构建标识（旧版本包，需重新打包并刷新）')
    }
  }

  // 退出码在两种输出模式之间必须一致：CI 常用 --json，不能因为换了输出格式就当成功
  let failed = false
  if (allSource) {
    // 全是源码目录：没有可比的安装，构建视为通过（与旧行为一致，不看 --expect / 漂移）
  } else if (baseline === null) {
    failed = true
  } else {
    const expected = nonEmpty(parsed.options.expect) ? String(parsed.options.expect).toLowerCase() : null
    if (expected !== null && !buildMatchesExpected(baseline, expected)) {
      io.err(`doctor: 基准构建 ${baseline.slice(0, 7)} 与期望 ${expected.slice(0, 7)} 不一致`)
      failed = true
    } else if (drift.length > 0) {
      io.err(`doctor: 以下仓装的不是同一构建（基准 ${baseline.slice(0, 7)}）: ${drift.join(', ')}`)
      failed = true
    }
  }

  // profile 段接在构建段之后：逐项 ✓/✗（✓ 走 stdout、✗ 走 stderr，与本仓输出约定一致），
  // 跳过项打 '-'；任一项 ✗ → 整体退出 1（构建不一致也是 1）；--json 模式不逐行打，
  // 结果在 payload.profile 里（退出码与人读模式一致）
  if (profile !== null && parsed.options.json !== true) {
    for (const item of profile.checks) {
      const mark = item.skipped === true ? '-' : item.ok ? '✓' : '✗'
      const line = `${mark} ${item.desc}`
      if (item.ok) io.out(line)
      else io.err(line)
    }
  }
  if (profile !== null && profile.failed) failed = true

  return failed ? 1 : 0
}

/** --expect 允许传短 sha（输出里都是 7 位），任一方向前缀匹配即算一致。 */
function buildMatchesExpected(actual, expected) {
  if (actual === expected) return true
  return actual.startsWith(expected) || expected.startsWith(actual)
}

/**
 * 根目录口径（selftest / shim / hooks / status 共用）：显式 --root 直接用；缺省先定位
 * 主工作区（契约 §9 的门禁查的是仓库配置，在 task worktree 里跑也该查主工作区那一份；
 * status 同理——审核记录只落在主仓 .dsh-web/reviews），git 定位不到
 * （非仓库 / git 失败）时退回当前目录，与 record / review 的口径一致。
 */
function resolveSelftestRoot(value, deps) {
  if (nonEmpty(value)) return value
  const cwd = nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  const resolved = resolveMainRoot({
    cwd,
    git: {
      commonDir: (dir) => gitCommonDir(dir, { runner: deps.runner }),
      toplevel: (dir) => toplevel(dir, { runner: deps.runner }),
    },
  })
  return resolved.ok ? resolved.root : cwd
}

/**
 * selftest：契约 §9 的一致性门禁。
 * --shims / --config 已实现（--fast 等价于 --shims --config）；--repos 是独立的多仓比对模式，
 * 与前三者互斥（--json 形态不同，合起来没有单一会话能同时表达两种结构）；
 * 其余检查项只识别不执行，明确报错退 2。检查逻辑在 lib/selftest.mjs，--shims 的比对复用 lib/shim.mjs。
 * 退出码：0 通过（含「无配置文件跳过」「--repos 可比对的仓不足 2 个」）/ 1 检查不通过 / 2 用法错误或检查项未实现。
 */
function runSelftest(argv, deps, io) {
  const parsed = parseArgs(argv, SELFTEST_VALUE_FLAGS, SELFTEST_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'selftest', parsed.error)
  const options = parsed.options

  for (const name of PENDING_CHECKS) {
    if (options[name] === true) return argError(io, 'selftest', `尚未实现: --${name}`)
  }
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, 'selftest', '--root 必须是非空目录路径')
  }

  // --repos 是独立模式（自己的输出形态与退出码语义），不掺进检查项那一组
  if (options.repos !== undefined) {
    if (!nonEmpty(options.repos)) return argError(io, 'selftest', '--repos 必须是非空的逗号分隔路径')
    if (options.shims === true || options.config === true || options.fast === true) {
      return argError(io, 'selftest', '--repos 不能与 --shims / --config / --fast 同时使用')
    }
    return runReposCheck(String(options.repos), options, deps, io)
  }

  // --fast 就是「--shims --config」这一组（不含 --repos）；没有检查项就报用法错误，不静默退 0
  const checks =
    options.fast === true
      ? ['shims', 'config']
      : [...(options.shims === true ? ['shims'] : []), ...(options.config === true ? ['config'] : [])]
  if (checks.length === 0) {
    return argError(io, 'selftest', '未指定检查项（当前可用 --shims / --config / --fast / --repos）')
  }

  const root = resolveSelftestRoot(options.root, deps)
  const result = runChecks(root, checks)

  // 失败原文始终走 stderr：--json 只改 stdout 的形态，不改退出码也不吞错误
  for (const check of result.checks) {
    if (!check.ok) io.err(`selftest: ${check.detail}`)
    else if (options.json !== true) io.out(`${root}: ${check.detail}`)
  }
  if (options.json === true) io.out(JSON.stringify({ ok: result.ok, root, checks: result.checks }))
  return result.ok ? 0 : 1
}

/**
 * --repos 的单条路径：前导 ~/ 展开成家目录，其余交给 resolve（相对路径按 base 解析，
 * 绝对路径原样返回并顺带去掉结尾斜杠），保证同一条路径无论怎么写都解析成同一个仓。
 */
function resolveRepoEntry(entry, base) {
  if (entry === '~') return homedir()
  if (entry.startsWith('~/')) return resolve(homedir(), entry.slice(2))
  return resolve(base, entry)
}

/**
 * selftest --repos：比对多个仓装的共享包是不是同一构建（契约 §9）。
 * 路径口径：绝对路径直接用；相对路径按 --root（缺省当前目录）解析；前导 ~/ 展开成家目录。
 * 比对语义（纳入 / 跳过 / 不足 2 个 / 判据）在 lib/selftest.mjs 的 checkRepos，这里只做编排与输出。
 * 退出码：0 一致或可比对的仓不足 2 个 / 1 有仓与基准不一致 / 2 用法错误。
 */
function runReposCheck(raw, options, deps, io) {
  const entries = String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  if (entries.length === 0) return argError(io, 'selftest', '--repos 至少需要一个仓路径')

  // 相对路径的基准：显式 --root 优先，否则当前目录（--repos 查的是兄弟仓，不是本仓配置）
  const base = nonEmpty(options.root) ? options.root : nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  // 同一个仓写两遍只算一个，否则重复路径会把「不足 2 个」骗成可比对
  const paths = [...new Set(entries.map((entry) => resolveRepoEntry(entry, base)))]
  const result = checkRepos(paths)

  if (options.json === true) {
    // --json 只给规格里的四个字段：跳过信息进 skipped，人读的跳过行与结论行不再打
    io.out(
      JSON.stringify({ ok: result.ok, baseline: result.baseline, repos: result.repos, skipped: result.skipped }),
    )
  } else {
    for (const repo of result.repos) io.out(`${repo.path}\t${repo.sha.slice(0, 7)} ${repo.builtAt}`)
    for (const skip of result.skipped) io.out(`${skip.path}\t跳过（${skip.reason}）`)
    if (!result.enough) io.out('跳过（可比对的仓不足 2 个）')
    else if (result.ok) io.out(`构建一致：${result.repos.length} 个仓`)
  }

  if (!result.ok) {
    // GitHub annotation 风格，CI 能直接把它标成注解；--json 模式下照样进 stderr
    const drift = result.repos.filter((repo) => !repo.ok).map((repo) => repo.path)
    io.err(`::error::基准 ${result.baseline.slice(0, 7)}，不一致的仓：${drift.join(', ')}`)
    return 1
  }
  return 0
}

/**
 * shim：动作是位置参数（install / check），渲染与比对逻辑在 lib/shim.mjs。
 * 根目录口径与 selftest 一致（显式 --root > 主工作区 > 当前目录）。
 * 退出码：0 成功 / 1 内容冲突或不一致 / 2 用法错误。
 */
function runShim(argv, deps, io) {
  const [action, ...rest] = argv
  if (action === undefined || action.startsWith('--')) {
    return argError(io, 'shim', '用法: dsh-pipeline shim <install|check> [--root <dir>] [--force]')
  }
  if (action !== 'install' && action !== 'check') {
    return argError(io, 'shim', `未知动作: ${action}（允许 install / check）`)
  }

  const valueFlags = action === 'install' ? SHIM_INSTALL_VALUE_FLAGS : SHIM_CHECK_VALUE_FLAGS
  const boolFlags = action === 'install' ? SHIM_INSTALL_BOOL_FLAGS : SHIM_CHECK_BOOL_FLAGS
  const parsed = parseArgs(rest, valueFlags, boolFlags)
  if (parsed.error) return argError(io, 'shim', parsed.error)
  const options = parsed.options
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, 'shim', '--root 必须是非空目录路径')
  }
  const root = resolveSelftestRoot(options.root, deps)

  if (action === 'install') {
    const result = installShims(root, { force: options.force === true })
    if (!result.ok) {
      for (const name of result.conflicts) {
        io.err(`shim: 已存在且内容不同: ${name}（确认后加 --force 覆盖）`)
      }
      return 1
    }
    for (const rel of result.written) io.out(`写入: ${rel}`)
    io.out(`shim: 已生成 ${SHIM_ENTRIES.length} 个入口`)
    return 0
  }

  const result = checkShims(root)
  if (result.missingDir) {
    io.err(`shim: ${result.dir} 不存在或不是目录，请先运行 shim install`)
    return 1
  }
  if (!result.ok) {
    for (const name of result.mismatches) io.err(`shim: 与模板不一致: ${name}`)
    return 1
  }
  io.out(`shim: ${SHIM_ENTRIES.length} 个入口与模板一致`)
  return 0
}

/**
 * hooks：动作是位置参数（install / check），生成、安装与比对在 lib/hooks.mjs。
 * 根目录口径与 shim / selftest 一致（显式 --root > 主工作区 > 当前目录）。
 * 退出码：0 成功 / 1 业务拒绝（未装、不一致、拒绝覆盖）/ 2 用法或环境错误。
 */
function runHooks(argv, deps, io) {
  const [action, ...rest] = argv
  if (action === undefined || action.startsWith('--')) {
    return argError(io, 'hooks', '用法: dsh-pipeline hooks <install|check> [--root <dir>]')
  }
  if (action !== 'install' && action !== 'check') {
    return argError(io, 'hooks', `未知动作: ${action}（允许 install / check）`)
  }

  const valueFlags = action === 'install' ? HOOKS_INSTALL_VALUE_FLAGS : HOOKS_CHECK_VALUE_FLAGS
  const boolFlags = action === 'install' ? HOOKS_INSTALL_BOOL_FLAGS : HOOKS_CHECK_BOOL_FLAGS
  const parsed = parseArgs(rest, valueFlags, boolFlags)
  if (parsed.error) return argError(io, 'hooks', parsed.error)
  const options = parsed.options
  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, 'hooks', '--root 必须是非空目录路径')
  }
  const root = resolveSelftestRoot(options.root, deps)

  if (action === 'install') {
    const result = installHook(root, {
      force: options.force === true,
      allowMain: options['allow-main'] === true,
      runner: deps.runner,
    })
    if (!result.ok) {
      io.err(`hooks: ${result.error}`)
      return result.code
    }
    io.out(`hooks: ${result.status === 'updated' ? '已更新' : '已安装'} ${result.path}`)
    return 0
  }

  const result = checkHook(root, { runner: deps.runner })
  if (!result.ok) {
    io.err(`hooks: ${result.error}`)
    return result.code
  }
  io.out(`hooks: 钩子与本包一致: ${result.path}`)
  return 0
}

/**
 * check-all：参数编排与输出，逐包执行逻辑在 lib/check-all.mjs（串行，失败不中断）。
 * 包来源：--packages 显式指定 > 配置 checks.packages（按给定顺序）>
 * 自动发现 <root> 下含 package.json 的子目录并按 checks.exclude 过滤。
 * 退出码：0 全部通过（含全跳过）/ 1 有失败 / 2 用法错误 / 3 找不到 pnpm。
 */
function runCheckAllCommand(argv, deps, io) {
  const parsed = parseArgs(argv, CHECK_ALL_VALUE_FLAGS, CHECK_ALL_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'check-all', parsed.error)
  const options = parsed.options

  if (options.root !== undefined && !nonEmpty(options.root)) {
    return argError(io, 'check-all', '--root 必须是非空目录路径')
  }
  let names
  if (options.packages !== undefined) {
    names = [
      ...new Set(
        String(options.packages)
          .split(',')
          .map((item) => item.trim())
          .filter((item) => item.length > 0),
      ),
    ]
    if (names.length === 0) return argError(io, 'check-all', '--packages 至少需要一个包名')
  }

  const root = nonEmpty(options.root) ? options.root : nonEmpty(deps.cwd) ? deps.cwd : process.cwd()
  let rootStat
  try {
    rootStat = statSync(root)
  } catch {
    return argError(io, 'check-all', `目录不存在: ${root}`)
  }
  if (!rootStat.isDirectory()) return argError(io, 'check-all', `不是目录: ${root}`)

  if (names === undefined) {
    // flag 没给才读配置：--packages 覆盖 checks.packages，读不了 / 不合规当场退 2。
    let config
    try {
      config = loadConfig(root).config
    } catch (error) {
      return argError(io, 'check-all', `读取配置失败: ${messageOf(error)}`)
    }
    const checks = config.checks
    const configured = isPlainObject(checks) && Array.isArray(checks.packages) ? checks.packages : []
    if (configured.length > 0) {
      names = [...new Set(configured)]
    } else {
      try {
        names = discoverPackages(root)
      } catch (error) {
        return argError(io, 'check-all', `读取目录失败: ${messageOf(error)}`)
      }
      const exclude = isPlainObject(checks) && Array.isArray(checks.exclude) ? new Set(checks.exclude) : null
      if (exclude !== null) names = names.filter((name) => !exclude.has(name))
    }
  }

  const json = options.json === true
  const result = runCheckAllFlow({
    root,
    names,
    onRow: json
      ? undefined
      : (row) => {
          io.out(`${row.dir} | ${row.name} | ${row.detail}`)
          // 失败时把命令输出打出来（缩进两格），否则排查只能手工重跑
          if (row.failureOutput) {
            for (const line of row.failureOutput.split('\n')) io.out(`  ${line}`)
          }
        },
  })

  if (result.missingPnpm) {
    io.err('check-all: 找不到 pnpm（请安装 pnpm 并加入 PATH）')
    return 3
  }
  if (json) {
    io.out(
      JSON.stringify({
        ok: result.ok,
        packages: result.packages.map((entry) => ({
          dir: entry.dir,
          checks: entry.checks.map((check) => ({
            name: check.name,
            ok: check.ok,
            skipped: check.skipped,
            code: check.code,
          })),
        })),
      }),
    )
    return result.ok ? 0 : 1
  }
  const { summary } = result
  io.out(`check-all: ${summary.total} 个包，${summary.pass} 通过 / ${summary.fail} 失败 / ${summary.skip} 跳过`)
  return result.ok ? 0 : 1
}

/**
 * deploy：动作是位置参数（init / check），渲染与生成区比对全在 lib/deploy.mjs（契约 §10）。
 * --root 必填：生成 / 校验必须显式指向目标仓，不猜当前目录。
 * 退出码：0 成功 / 1 不一致、缺标记或拒绝覆盖 / 2 用法、配置错误或 artifact 尚未实现。
 * deps.buildInfo 可注入（测试用），缺省读本包 build.json——源码运行没有它，拒绝生成假 pin。
 */
function runDeploy(argv, deps, io) {
  const [action, ...rest] = argv
  if (action === undefined || action.startsWith('--')) {
    return argError(io, 'deploy', '用法: dsh-pipeline deploy <init|check> [--root <dir>] [--write]')
  }
  if (action !== 'init' && action !== 'check') {
    return argError(io, 'deploy', `未知动作: ${action}（允许 init / check）`)
  }

  const boolFlags = action === 'init' ? DEPLOY_INIT_BOOL_FLAGS : DEPLOY_CHECK_BOOL_FLAGS
  const parsed = parseArgs(rest, DEPLOY_VALUE_FLAGS, boolFlags)
  if (parsed.error) return argError(io, 'deploy', parsed.error)
  const options = parsed.options
  if (!nonEmpty(options.root)) return argError(io, 'deploy', '缺少必填参数 --root')

  let config
  try {
    config = loadConfig(options.root).config
  } catch (error) {
    return argError(io, 'deploy', `读取配置失败: ${messageOf(error)}`)
  }
  if (!isPlainObject(config.deploy)) {
    return argError(io, 'deploy', '配置缺少 deploy 段（契约 §7.1），无法生成 / 校验部署骨架')
  }

  const buildInfo = isPlainObject(deps.buildInfo) ? deps.buildInfo : readBuildInfo()
  if (!nonEmpty(buildInfo?.gitSha)) {
    return argError(io, 'deploy', '当前包没有 build.json（源码运行），无法 pin uses 的 gitSha；请在已安装包内运行')
  }

  let region
  try {
    region = renderRegion(config.deploy, buildInfo.gitSha)
  } catch (error) {
    if (error instanceof DeployError) {
      io.err(`deploy ${action}: ${error.message}`)
      return error.code
    }
    throw error
  }
  const skeleton = `${REGION_BEGIN}\n${region}\n${REGION_END}`

  if (action === 'init') {
    if (options.write !== true) {
      io.out(skeleton)
      return 0
    }
    const file = join(options.root, DEPLOY_WORKFLOW_FILE)
    let existing = null
    try {
      existing = readFileSync(file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') return argError(io, 'deploy', `读取 ${DEPLOY_WORKFLOW_FILE} 失败: ${messageOf(error)}`)
    }
    if (existing === null) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, `${skeleton}\n`, 'utf8')
      io.out(`deploy init: 已写入 ${DEPLOY_WORKFLOW_FILE}`)
      return 0
    }
    // 已有文件只替换生成区，标记之后的追加内容原样保留；缺标记 = 手写文件，拒绝覆盖
    const merged = replaceRegion(existing, skeleton)
    if (merged === null) {
      io.err(`deploy init: ${DEPLOY_WORKFLOW_FILE} 已存在且不是生成的骨架（缺标记），拒绝覆盖`)
      return 1
    }
    writeFileSync(file, merged, 'utf8')
    io.out(`deploy init: 已更新 ${DEPLOY_WORKFLOW_FILE} 的生成区（标记之后的追加内容保留）`)
    return 0
  }

  const file = join(options.root, DEPLOY_WORKFLOW_FILE)
  let content
  try {
    content = readFileSync(file, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      io.err(`deploy check: ${DEPLOY_WORKFLOW_FILE} 不存在，请先运行 deploy init`)
      return 1
    }
    return argError(io, 'deploy', `读取 ${DEPLOY_WORKFLOW_FILE} 失败: ${messageOf(error)}`)
  }

  const extracted = extractRegion(content)
  if (!extracted.ok) {
    io.err(`deploy check: ${DEPLOY_WORKFLOW_FILE} 不是生成的骨架（缺生成区标记），无法比对`)
    return 1
  }
  const diff = firstDifference(region, extracted.region)
  if (diff !== null) {
    io.err(`deploy check: 生成区与配置不一致（第一处差异在第 ${diff.line} 行）`)
    io.err(`  期望: ${diff.expected}`)
    io.err(`  实际: ${diff.actual}`)
    return 1
  }
  io.out('deploy check: 生成区与配置一致')
  return 0
}

/**
 * 仓库概览（status 的第一段）：根目录 / 当前分支 / HEAD 一行 / worktree 列表。
 * 探测用 `rev-parse --show-toplevel`：非 git 仓库或 git 不可用时返回 null，
 * 调用方只把这一段换成提示行——审核记录段与退出码都不受影响。
 */
function collectRepoOverview(root, deps) {
  const options = { runner: deps.runner }
  if (!toplevel(root, options).ok) return null

  const branchName = branchShow(root, options)
  const sha = gitHeadSha(root, options)
  let branch
  if (branchName.ok && nonEmpty(branchName.data)) {
    branch = branchName.data
  } else if (sha.ok && nonEmpty(sha.data)) {
    branch = `<detached> ${sha.data.slice(0, 7)}`
  } else {
    branch = '?'
  }

  const oneline = headOneline(root, options)
  const worktrees = worktreeListPlain(root, options)

  return {
    // 展示与 payload 一律给绝对路径（`--root .` 时也能看出是哪个仓），git 调用仍用原样 root
    root: resolve(root),
    branch,
    head: oneline.ok ? oneline.data : null,
    worktrees: worktrees.ok && Array.isArray(worktrees.data) ? worktrees.data : [],
  }
}

function runStatus(argv, deps, io) {
  const parsed = parseArgs(argv, STATUS_VALUE_FLAGS, STATUS_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'status', parsed.error)
  if (parsed.options.root !== undefined && !nonEmpty(parsed.options.root)) {
    return argError(io, 'status', '--root 必须是非空目录路径')
  }
  // 缺省口径复用 resolveSelftestRoot（显式 --root > 主工作区 > 当前目录）：
  // 审核记录只落在主仓，在 task worktree 里跑 status 也该看主工作区那一份。
  const root = resolveSelftestRoot(parsed.options.root, deps)

  let collected
  try {
    collected = collectRecords(root)
  } catch (error) {
    io.err(`status: 读取审核记录失败: ${messageOf(error)}`)
    return 2
  }

  let latest = null
  if (collected.records.length > 0) {
    const { record } = collected.records[0]
    latest = {
      pr: record.pr,
      round: record.round,
      verdict: record.verdict,
      head_sha: typeof record.head_sha === 'string' ? record.head_sha : null,
    }
  }

  // git 取不到时只有这一段降级：payload 里 repo 仍是固定四字段的形状
  const repo = collectRepoOverview(root, deps)

  if (parsed.options.json === true) {
    io.out(
      JSON.stringify({
        repo: repo ?? { root: resolve(root), branch: null, head: null, worktrees: [] },
        records: collected.records.length,
        latest,
        invalid: collected.invalid,
      }),
    )
    return 0
  }

  // 仓库概览段固定排在审核记录段之前
  io.out('仓库概览:')
  if (repo === null) {
    io.out('（非 git 仓库或 git 不可用）')
  } else {
    io.out(`  根目录:   ${repo.root}`)
    io.out(`  当前分支: ${repo.branch}`)
    io.out(`  HEAD:     ${repo.head ?? '?'}`)
    io.out('  worktree:')
    for (const line of repo.worktrees) io.out(`    ${line}`)
  }

  io.out(`审核记录: ${collected.records.length} 条`)
  if (latest === null) {
    io.out('最近一条: 无')
  } else {
    const sha = latest.head_sha === null ? '未知' : latest.head_sha.slice(0, 8)
    io.out(`最近一条: PR #${latest.pr} 第 ${latest.round} 轮 结论 ${latest.verdict}（提交 ${sha}）`)
  }
  if (collected.invalid > 0) io.out(`无法解析的记录: ${collected.invalid} 条`)
  return 0
}

/** 前导 `~/`（或单独的 `~`）展开成当前用户家目录；其余原样返回。flag 与配置走同一条规则。 */
function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/**
 * task：issue 号是位置参数（唯一一个），其余走 --root / --worktrees-dir。
 * 参数错误一律 2，流程失败也一律 2——task 没有「闸门拒绝」这种中间态。
 */
function runTask(argv, deps, io) {
  const [first, ...rest] = argv
  if (first === undefined) {
    return argError(io, 'task', '用法: dsh-pipeline task <issue号> [--slug <slug>] [--root <dir>] [--worktrees-dir <dir>]')
  }
  if (first.startsWith('--')) return argError(io, 'task', `缺少 issue 号（用法: dsh-pipeline task <issue号>）`)
  if (!/^[1-9][0-9]*$/.test(first)) return argError(io, 'task', `issue 号必须是正整数: ${first}`)

  const parsed = parseArgs(rest, TASK_VALUE_FLAGS, TASK_BOOL_FLAGS)
  if (parsed.error) return argError(io, 'task', parsed.error)
  if (parsed.options.root !== undefined && !nonEmpty(parsed.options.root)) {
    return argError(io, 'task', '--root 必须是非空目录路径')
  }
  if (parsed.options['worktrees-dir'] !== undefined && !nonEmpty(parsed.options['worktrees-dir'])) {
    return argError(io, 'task', '--worktrees-dir 必须是非空目录路径')
  }

  // worktree 容器：flag 优先于配置；只在没给 flag 时才读配置，
  // 两者都没有 → 不传 worktreesDir，lib/task.mjs 仍回落到 <root>/.worktrees（现状不变）。
  // 配置读 --root（缺省当前目录）下的 .dsh/pipeline.json，读不了 / 不合规当场退 2。
  let worktreesDir = parsed.options['worktrees-dir']
  if (worktreesDir === undefined) {
    const configRoot = nonEmpty(parsed.options.root)
      ? parsed.options.root
      : nonEmpty(deps.cwd)
        ? deps.cwd
        : process.cwd()
    let config
    try {
      config = loadConfig(configRoot).config
    } catch (error) {
      return argError(io, 'task', `读取配置失败: ${messageOf(error)}`)
    }
    const configured = config.worktreesDir
    if (configured !== undefined && configured !== null) {
      if (!nonEmpty(configured)) {
        return argError(io, 'task', '配置 worktreesDir 必须是非空目录路径')
      }
      worktreesDir = configured
    }
  }
  // 相对路径按 --root 解析、~/ 展开、不存在则 mkdir -p，都在 lib/task.mjs 里与 flag 同一套
  if (worktreesDir !== undefined) worktreesDir = expandHome(worktreesDir)

  const result = runTaskFlow({
    issue: Number(first),
    slug: parsed.options.slug,
    root: parsed.options.root,
    worktreesDir,
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
    if (first === 'selftest') return runSelftest(rest, deps, io)
    if (first === 'shim') return runShim(rest, deps, io)
    if (first === 'hooks') return runHooks(rest, deps, io)
    if (first === 'check-all') return runCheckAllCommand(rest, deps, io)
    if (first === 'deploy') return runDeploy(rest, deps, io)
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
