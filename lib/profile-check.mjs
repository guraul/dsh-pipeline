/**
 * doctor --profile：profile 配置档的只读体检。
 *
 * 背景：切换到 dsh-subagents 后，self-dsh-plugins 里留着一个一次性体检脚本
 * （scripts/pipeline/review-loop-check.sh），与 doctor 同属只读检查，收进本包统一维护，
 * 业务仓那份脚本随后删除。
 * 红线：profile 文件里可能有 secret——这里只判断包名字符串与文件存在性/大小，
 * 不打印、不回显文件内容。
 */
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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

/**
 * 逐项体检（只读）。
 * @param {string} profile 目录（--profile 的取值；空值走 resolveProfileDir 的缺省）
 * @param {object} [env] 环境变量（测试注入用），缺省 process.env
 * @returns {{dir: string, dshHome: string, checks: {ok: boolean, desc: string}[], failed: boolean}}
 */
export function checkProfile(profile, env = process.env) {
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

  // 3. cordis.patch.yml 存在且非空（只看大小，不读内容）
  const cordisPath = join(dir, 'cordis.patch.yml')
  let cordisOk = false
  try {
    cordisOk = statSync(cordisPath).isFile() && statSync(cordisPath).size > 0
  } catch {
    cordisOk = false
  }
  checks.push({ ok: cordisOk, desc: `cordis.patch.yml 存在且非空（${cordisPath}）` })

  // 4. 报告 profile 目录路径与 DSH_HOME，便于排障
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
