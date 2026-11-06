/**
 * selftest 的检查实现（契约 §9 一致性门禁）。
 *
 * 已落地 --shims / --config / --repos / --exit-codes；--peer 已识别但未实现，
 * 由 CLI 明确报「尚未实现」退 2，不静默忽略。
 *
 * 检查只读不写：没有配置文件是合法状态（跳过、退出 0），文件存在就必须合规；
 * --shims 的比对逻辑复用 lib/shim.mjs（shim check 同一份），这里只包一层检查项形态；
 * --repos 是跨仓比对（契约 §9 的多仓构建一致性），路径解析（绝对 / 相对 / ~/）由 CLI 做好后传进来；
 * --exit-codes 是唯一会起子进程的检查项：退出码口径只能在真的跑一遍之后才知道。
 * 错误信息沿用 lib/config.mjs 的原文（只带字段名与原因，不打印文件内容）。
 */
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONFIG_PATH, loadConfig } from './config.mjs'
import { SHIM_DIR, checkShims as compareShims, renderShim } from './shim.mjs'

/** 本包根目录（用它定位 bin/cli.mjs）。 */
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLI_PATH = join(PACKAGE_ROOT, 'bin', 'cli.mjs')

/** 默认执行器：真实 spawnSync，形状与 git/gh 封装的 runner 一致（测试注入假 runner）。 */
function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, { encoding: 'utf8', ...options })
}

/** 已实现的检查项。 */
export const DONE_CHECKS = Object.freeze(['shims', 'config', 'exit-codes'])

/** 已识别但未实现的检查项（契约 §9 的其余门禁）。 */
export const PENDING_CHECKS = Object.freeze(['peer'])

/** 配置文件相对 root 的路径（输出里用它，不拼绝对路径）。 */
const CONFIG_FILE_LABEL = CONFIG_PATH.join('/')

/**
 * --config：<root>/.dsh/pipeline.json 能否被 schema 接受、有没有未声明字段。
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkConfig(root) {
  const file = join(root, ...CONFIG_PATH)
  if (!existsSync(file)) {
    return { name: 'config', ok: true, detail: `无 ${CONFIG_FILE_LABEL}（跳过）` }
  }
  try {
    loadConfig(root)
  } catch (error) {
    return { name: 'config', ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
  return { name: 'config', ok: true, detail: '配置 OK' }
}

/**
 * --shims：6 个入口是否等于按当前包版本渲染后的模板。
 * 比对本体在 lib/shim.mjs（与 shim check 同一份），这里只把结果包成检查项形态。
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkShimsEntry(root) {
  const result = compareShims(root)
  if (result.missingDir) {
    return { name: 'shims', ok: false, detail: `${SHIM_DIR} 不存在，请先运行 shim install` }
  }
  if (!result.ok) {
    return { name: 'shims', ok: false, detail: `入口与模板不一致: ${result.mismatches.join(', ')}` }
  }
  return { name: 'shims', ok: true, detail: '6 个入口与模板一致' }
}

/** 契约 §4 的退出码场景：起子进程真跑，判据是「实际退出码」，不是代码里写了什么。 */
const EXIT_CASES = Object.freeze([
  { id: '缺必填参数', argv: ['gate'], want: 2 },
  { id: '未知参数', argv: ['gate', '--pr', '1', '--nope'], want: 2 },
  { id: '未知子命令', argv: ['no-such-subcommand'], want: 2 },
])

/** 入口找不到共享包时的退出码（契约 §4：3 = 环境错误）。 */
const MISSING_PACKAGE_EXIT = 3

/** 把子进程结果折成「实际退出码」；spawn 失败（没有这个命令）记 null，不猜成 0。 */
function exitCodeOf(result) {
  return result !== null && typeof result === 'object' && typeof result.status === 'number'
    ? result.status
    : null
}

function describeExit(code) {
  return code === null ? '无退出码' : String(code)
}

/**
 * --exit-codes：退出码口径自检（契约 §4 / §9）。
 *
 * 四类场景各跑一次真子进程：
 *   - 缺必填参数、未知参数、未知子命令 → 2（用法错误）；
 *   - 入口 shim 找不到共享包 → 3（环境错误）。
 *
 * 最后一条只能靠入口验：把当前包版本渲染出的 shim 放进临时目录，
 * 让它的三条定位路径（DSH_PIPELINE_HOME、主工作区 tools/、所在仓 tools/）全部落空。
 * @param {{ runner?: Function }} [options] runner 可注入，测试用它断言「发了什么命令」
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
export function checkExitCodes({ runner } = {}) {
  const run = typeof runner === 'function' ? runner : defaultRunner
  const problems = []

  for (const item of EXIT_CASES) {
    const actual = exitCodeOf(run(process.execPath, [CLI_PATH, ...item.argv], {}))
    if (actual !== item.want) {
      problems.push(`${item.id} 期望退出 ${item.want}，实际 ${describeExit(actual)}`)
    }
  }

  const dir = mkdtempSync(join(tmpdir(), 'dsh-exit-codes-'))
  try {
    const shim = join(dir, 'pipeline.sh')
    writeFileSync(shim, renderShim(''), 'utf8')
    chmodSync(shim, 0o755)
    // cwd 与 script_dir 都在临时目录：git 定位不到仓 → 退回临时目录；
    // 再让 DSH_PIPELINE_HOME 指向不存在的路径，三条定位路径就都落空了。
    const actual = exitCodeOf(
      run('bash', [shim, 'status'], {
        cwd: dir,
        env: { ...process.env, DSH_PIPELINE_HOME: join(dir, 'no-such-package') },
      }),
    )
    if (actual !== MISSING_PACKAGE_EXIT) {
      problems.push(`找不到共享包 期望退出 ${MISSING_PACKAGE_EXIT}，实际 ${describeExit(actual)}`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const total = EXIT_CASES.length + 1
  return {
    name: 'exit-codes',
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `退出码口径 ${total} 条全部符合（缺必填参数 2 / 未知参数 2 / 未知子命令 2 / 找不到共享包 3）`
        : `退出码口径不符（${problems.length}/${total}）: ${problems.join('; ')}`,
  }
}

/**
 * 跑指定检查项并汇总。
 * @param {string} root
 * @param {string[]} checks 检查项名（shims / config）
 * @returns {{ ok: boolean, checks: { name: string, ok: boolean, detail: string }[] }}
 */
export function runChecks(root, checks, { runner } = {}) {
  const results = checks.map((name) => {
    if (name === 'config') return checkConfig(root)
    if (name === 'shims') return checkShimsEntry(root)
    if (name === 'exit-codes') return checkExitCodes({ runner })
    throw new Error(`未知检查项: ${name}`)
  })
  return { ok: results.every((item) => item.ok), checks: results }
}

/** 共享包在消费仓里的安装位置（相对仓库根）。 */
const PKG_SEGMENTS = ['tools', 'node_modules', 'dsh-pipeline']

/**
 * 读仓里那个共享包的 build.json：gitSha 与 builtAt 两个字段都要，
 * 取不到（没这个文件 / 不是合法 JSON / 缺字段）一律按「未装包」处理。
 * @param {string} pkgDir
 * @returns {{gitSha: string, builtAt: string}|null}
 */
function readInstalledBuild(pkgDir) {
  let parsed = null
  try {
    parsed = JSON.parse(readFileSync(join(pkgDir, 'build.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed?.gitSha !== 'string' || typeof parsed?.builtAt !== 'string') return null
  if (parsed.gitSha.length === 0 || parsed.builtAt.length === 0) return null
  return { gitSha: parsed.gitSha, builtAt: parsed.builtAt }
}

/**
 * --repos：多个仓装的共享包是不是同一构建（吸收消费仓 build-check.sh 的门禁语义）。
 *
 * 只纳入「目录存在 + 有 <root>/tools/node_modules/dsh-pipeline/bin/cli.mjs + build.json 可读」的仓；
 * 其余跳过并列出，不算失败——CI 里没有兄弟仓，把缺仓判成失败会让 CI 必红。
 * 判据是 build.json 的 gitSha 相同（基准取第一个能比对的仓），builtAt 必须能读到并随行展示。
 * 可比对的仓不足 2 个时 baseline 为 null、ok 为 true：没有第二方就没有「不一致」可言。
 * @param {string[]} paths 已解析的仓路径（绝对路径由 CLI 负责）
 * @returns {{ok: boolean, baseline: string|null, enough: boolean,
 *   repos: {path: string, sha: string, builtAt: string, ok: boolean}[],
 *   skipped: {path: string, reason: string}[]}}
 */
export function checkRepos(paths) {
  const repos = []
  const skipped = []
  for (const path of paths) {
    let stat = null
    try {
      stat = statSync(path)
    } catch {
      stat = null
    }
    if (stat === null) {
      skipped.push({ path, reason: '目录不存在' })
      continue
    }
    if (!stat.isDirectory()) {
      skipped.push({ path, reason: '不是目录' })
      continue
    }
    const pkgDir = join(path, ...PKG_SEGMENTS)
    if (!existsSync(join(pkgDir, 'bin', 'cli.mjs'))) {
      skipped.push({ path, reason: '未装包' })
      continue
    }
    const build = readInstalledBuild(pkgDir)
    if (build === null) {
      skipped.push({ path, reason: '未装包' })
      continue
    }
    repos.push({ path, sha: build.gitSha, builtAt: build.builtAt, ok: true })
  }

  const enough = repos.length >= 2
  const baseline = enough ? repos[0].sha : null
  // 不足 2 个没有基准可比：逐仓 ok 记 true（整体 ok 也由 enough 兜住），别把「没得比」写成失败
  for (const repo of repos) repo.ok = !enough || repo.sha === baseline
  return { ok: !enough || repos.every((repo) => repo.ok), baseline, enough, repos, skipped }
}
