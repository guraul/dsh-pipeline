/**
 * check-all：逐包跑 test / check / typecheck 并汇总（语义照搬
 * self-dsh-plugins 的 scripts/pipeline/check-all.sh）：
 *
 *   * scripts 里有 test → `pnpm test`；有 check → `pnpm run check`；
 *     有 typecheck → `pnpm run typecheck`；三者都没有 → 记「无可跑检查」失败
 *   * 包目录缺 node_modules → 三项都记「跳过（未安装依赖）」，不算失败
 *   * 任一命令非零 → 该项失败，继续跑后面的包（不中断），最后汇总
 *
 * 包来源由调用方给：--packages 显式指定（目录 / package.json 缺失记为失败），
 * 其次 `.dsh/pipeline.json` 的 checks.packages（按给定顺序），最后 discoverPackages
 * 自动发现并按 checks.exclude 过滤；配置读取在 bin/cli.mjs 里完成。
 *
 * 执行严格串行：一次只发一条命令；spawn 不到 pnpm（ENOENT）时立即停止并置
 * missingPnpm，由 CLI 退 3（环境错误，不计入通过 / 失败）。
 * 命令自身的输出不透出：每项只出一行 `<包目录> | <检查> | <结果>`。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 三项检查的固定顺序与各自要发的 pnpm 命令。 */
const CHECKS = Object.freeze([
  { name: 'test', argv: ['test'] },
  { name: 'check', argv: ['run', 'check'] },
  { name: 'typecheck', argv: ['run', 'typecheck'] },
])

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 没有可执行命令的失败项（包目录缺失 / package.json 缺失或坏 / 无可跑检查）。 */
function failed(detail) {
  return { name: '-', ok: false, skipped: false, code: null, detail }
}

/**
 * 自动发现：<root> 下每个含 package.json 的子目录各算一个包，
 * 跳过 node_modules 与 . 开头的目录；返回按名称排序的列表。
 * @param {string} root
 * @returns {string[]}
 */
export function discoverPackages(root) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
    .filter((entry) => existsSync(join(root, entry.name, 'package.json')))
    .map((entry) => entry.name)
    .sort()
}

/**
 * 逐包执行检查（串行，任一失败不中断，最后汇总）。
 *
 * @param {{ root: string, names: string[], onRow?: (row: { dir: string, name: string, detail: string }) => void }} options
 *   onRow 每完成一项收到一行的三个字段；人读模式由 CLI 打印，--json 模式不传。
 * @returns {{
 *   ok: boolean,
 *   missingPnpm: boolean,
 *   summary: { total: number, pass: number, fail: number, skip: number },
 *   packages: { dir: string, checks: { name: string, ok: boolean, skipped: boolean, code: number | null, detail: string }[] }[],
 * }}
 */
export function runCheckAll({ root, names, onRow }) {
  const packages = []
  let missingPnpm = false

  for (const name of names) {
    const entry = { dir: name, checks: [] }
    packages.push(entry)
    const emit = (check) => {
      entry.checks.push(check)
      if (typeof onRow === 'function') {
        onRow({ dir: name, name: check.name, detail: check.detail, failureOutput: check.failureOutput ?? '' })
      }
    }

    const dir = join(root, name)
    if (!isDirectory(dir)) {
      emit(failed('失败（包目录不存在）'))
      continue
    }
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) {
      emit(failed('失败（package.json 不存在）'))
      continue
    }
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch {
      emit(failed('失败（package.json 无法解析）'))
      continue
    }
    const scripts = isPlainObject(pkg) && isPlainObject(pkg.scripts) ? pkg.scripts : {}

    // 缺依赖先于脚本判定：三项一律「跳过（未安装依赖）」，不算失败（与 check-all.sh 一致）
    if (!isDirectory(join(dir, 'node_modules'))) {
      for (const check of CHECKS) {
        emit({ name: check.name, ok: true, skipped: true, code: null, detail: '跳过（未安装依赖）' })
      }
      continue
    }

    const runnable = CHECKS.filter(
      (check) => typeof scripts[check.name] === 'string' && scripts[check.name].trim().length > 0,
    )
    if (runnable.length === 0) {
      emit(failed('失败（无可跑检查）'))
      continue
    }

    for (const check of runnable) {
      const spawned = spawnSync('pnpm', check.argv, {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      })
      if (spawned.error) {
        if (spawned.error.code === 'ENOENT') {
          missingPnpm = true
          break
        }
        emit({ name: check.name, ok: false, skipped: false, code: null, detail: '失败（无法执行 pnpm）' })
        continue
      }
      const code = typeof spawned.status === 'number' ? spawned.status : null
      // 失败时把命令输出挂在条目上（人读模式打印，--json 不带）：
      // 只给「失败（退出码 3）」等于没说，排查还得手工重跑。
      const failureOutput =
        code === 0 ? '' : `${spawned.stdout ?? ''}${spawned.stderr ?? ''}`.trimEnd()
      emit({
        name: check.name,
        ok: code === 0,
        skipped: false,
        code,
        detail: code === 0 ? '通过' : code === null ? '失败（无退出码）' : `失败（退出码 ${code}）`,
        failureOutput,
      })
    }
    if (missingPnpm) break
  }

  // 汇总按包计：任一项失败 → 该包失败；全是跳过 → 跳过；否则通过
  const summary = { total: packages.length, pass: 0, fail: 0, skip: 0 }
  for (const entry of packages) {
    if (entry.checks.length === 0 || entry.checks.some((check) => !check.ok)) summary.fail += 1
    else if (entry.checks.every((check) => check.skipped)) summary.skip += 1
    else summary.pass += 1
  }

  return { ok: !missingPnpm && summary.fail === 0, missingPnpm, summary, packages }
}
