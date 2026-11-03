/**
 * 构建标识：让「装的是哪个版本的包」可判断。
 *
 * 背景：消费方用 `file:` 指向本地 tarball，而 tarball 内容会随重打包变化、版本号却常常不动
 * （见 ADR-0003 的「锁文件钉不住内容会变的本地产物」）。只看 SemVer 无法区分两个不同构建，
 * 于是有了这个文件：打包时写入 git sha + 打包时间，运行时读出来比对。
 *
 * 源码目录里没有 build.json（它在 .gitignore 里），此时返回 null —— 直接跑源码是正常用法，
 * 不该因此报错。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = dirname(HERE)

/**
 * 读取包内的构建信息。
 * @returns {{gitSha: string, builtAt: string, dirty: boolean}|null}
 */
export function readBuildInfo() {
  try {
    const raw = readFileSync(join(ROOT, 'build.json'), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed?.gitSha !== 'string' || typeof parsed?.builtAt !== 'string') return null
    return { gitSha: parsed.gitSha, builtAt: parsed.builtAt, dirty: parsed.dirty === true }
  } catch {
    return null
  }
}

/** 人读的一行摘要：`<sha7> <时间>`，没有构建信息时返回 `源码运行`。 */
export function describeBuild(info = readBuildInfo()) {
  if (info === null) return '源码运行'
  return `${info.gitSha.slice(0, 7)}${info.dirty ? '+dirty' : ''} ${info.builtAt}`
}
