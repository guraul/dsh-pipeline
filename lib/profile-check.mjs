/**
 * doctor --profile：profile 配置档的只读体检。
 *
 * 背景：替代 self-dsh-plugins 的一次性脚本 scripts/pipeline/review-loop-check.sh
 * （该仓随后删除）。检查项以前者为基准：包声明两项、插件软链、dsh --dump-config
 * 可见性、审核记录目录可写；另加两项原脚本没有的（CONTRACT §3.2 已注明）：
 * cordis.patch.yml 非空与目录/DSH_HOME 报告。
 * 红线：profile 文件里可能有 secret——只判断包名字符串与文件存在性/大小/软链指向，
 * 不打印、不回显文件内容。
 */
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

/** 旧包：已迁移到 dsh-subagents，profile 里不应再有它的声明。 */
export const OLD_PKG = 'dsh-plugin-product-subagents'
/** 新包：dsh-subagents 目录的包名（或它的目录名）出现在 profile 的 package.json 即算已切换。 */
export const NEW_PKGS = ['dsh-plugin-subagents', 'dsh-subagents']

/** DSH_HOME：环境变量缺省 $HOME/.dsh。 */
export function resolveDshHome(env = process.env) {
  if (typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim().length > 0) return env.DSH_HOME
  const home = typeof env.HOME === 'string' && env.HOME.length > 0 ? env.HOME : homedir()
  return join(home, '.dsh')
}

/** 体检目录：--profile 给了用它；没给用 $DSH_HOME/profiles/web。 */
export function resolveProfileDir(profile, env = process.env) {
  if (typeof profile === 'string' && profile.trim().length > 0) return profile
  return join(resolveDshHome(env), 'profiles', 'web')
}

/** 按 env.PATH 找可执行文件（等价原脚本的 `command -dsh`）；找不到返回 null。 */
function findInPath(command, env) {
  const pathValue = typeof env.PATH === 'string' ? env.PATH : ''
  for (const entry of pathValue.split(':')) {
    if (entry.length === 0) continue
    const candidate = join(entry, command)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 下一个 PATH 条目
    }
  }
  return null
}

/**
 * 逐项体检（只读；唯一写动作是审核记录目录的 mkdir -p，与原脚本一致）。
 * @param {string} profile 目录（--profile 的取值；空值走 resolveProfileDir 的缺省）
 * @param {{ env?: object, repos?: string[], runner?: Function }} [options]
 *   repos：审核记录目录逐仓检查；runner：dsh --dump-config 的执行器（与 git/gh 同签名），
 *   缺省真实 spawnSync——测试用 PATH 隔离或假 runner，不真调 dsh。
 * @returns {{dir: string, dshHome: string, checks: {ok: boolean, skipped?: true, desc: string}[], failed: boolean}}
 */
export function checkProfile(profile, options = {}) {
  const { env = process.env, repos = [], runner } = options
  const dir = resolveProfileDir(profile, env)
  const dshHome = resolveDshHome(env)
  const checks = []

  // 1/2. package.json 里的包声明：只做子串判断（等价于 grep 包名），内容不外泄
  let pkgText = null
  try {
    pkgText = readFileSync(join(dir, 'package.json'), 'utf8')
  } catch {
    pkgText = null
  }
  const unreadable = pkgText === null ? `（读不到 ${join(dir, 'package.json')}）` : ''
  checks.push({
    ok: pkgText !== null && !pkgText.includes(`"${OLD_PKG}"`),
    desc: `profile 里已无 ${OLD_PKG}${unreadable}`,
  })
  checks.push({
    ok: pkgText !== null && NEW_PKGS.some((name) => pkgText.includes(`"${name}"`)),
    desc: `profile 里有 ${NEW_PKGS[0]}${unreadable}`,
  })

  // 3. 新包软链是否有效（pnpm link: 装的是符号链接；相对目标必须按链接所在目录解析）
  const linkPath = join(dir, 'node_modules', NEW_PKGS[0])
  let linkOk = false
  let linkDesc = `node_modules 里有 ${NEW_PKGS[0]} 软链（需在 profile 目录跑 pnpm install）`
  let linkTarget = null
  try {
    if (lstatSync(linkPath).isSymbolicLink()) {
      linkTarget = resolve(dirname(linkPath), readlinkSync(linkPath))
      linkOk = existsSync(linkTarget) && statSync(linkTarget).isDirectory()
      linkDesc = linkOk ? `软链有效 -> ${linkTarget}` : `软链悬空（${linkTarget}），需在 profile 目录跑 pnpm install`
    }
  } catch {
    // 软链不存在：沿用「需 pnpm install」描述
  }
  checks.push({ ok: linkOk, desc: linkDesc })

  // 4. dsh --dump-config 能看到该包（只读；stderr 丢弃）。dsh 不在 PATH 时跳过、不算失败
  //    （包要兼顾 CI，不强制依赖本机 dsh——原脚本判失败是因为它只在本机用）。
  const dumpDesc = `dsh --dump-config 能看到 ${NEW_PKGS[0]}`
  if (findInPath('dsh', env) === null) {
    checks.push({ ok: true, skipped: true, desc: `${dumpDesc}（跳过：dsh 不可用）` })
  } else {
    const run = typeof runner === 'function' ? runner : defaultRunner
    let stdout = ''
    try {
      const result = run('dsh', ['--profile', basename(dir), '--dump-config'], {})
      stdout = result !== null && typeof result === 'object' && typeof result.stdout === 'string' ? result.stdout : ''
    } catch {
      stdout = ''
    }
    checks.push({ ok: stdout.includes(NEW_PKGS[0]), desc: dumpDesc })
  }

  // 5. cordis.patch.yml 存在且非空（只看大小，不读内容；原脚本没有这项，CONTRACT 已注明）
  const cordisPath = join(dir, 'cordis.patch.yml')
  let cordisOk = false
  try {
    cordisOk = statSync(cordisPath).isFile() && statSync(cordisPath).size > 0
  } catch {
    cordisOk = false
  }
  checks.push({ ok: cordisOk, desc: `cordis.patch.yml 存在且非空（${cordisPath}）` })

  // 6. 审核记录目录可写（逐仓；不存在则 mkdir -p，与原脚本一致）
  for (const root of repos) {
    const records = join(root, '.dsh-web', 'reviews')
    let recordsOk = false
    try {
      mkdirSync(records, { recursive: true })
      accessSync(records, constants.W_OK)
      recordsOk = true
    } catch {
      recordsOk = false
    }
    checks.push({ ok: recordsOk, desc: `审核记录目录可写（${records}）` })
  }

  // 7. 报告 profile 目录路径与 DSH_HOME，便于排障
  let dirOk = false
  try {
    dirOk = statSync(dir).isDirectory()
  } catch {
    dirOk = false
  }
  checks.push({
    ok: dirOk,
    desc: dirOk ? `profile 目录 ${dir}（DSH_HOME ${dshHome}）` : `profile 目录不存在（${dir}；DSH_HOME ${dshHome}）`,
  })

  return { dir, dshHome, checks, failed: checks.some((item) => item.ok === false) }
}

/** 默认执行器：真实 spawnSync，与 git.mjs / gh.mjs 的缺省 runner 同一形态。 */
function defaultRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}
