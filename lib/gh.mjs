/**
 * gh 执行封装：把「允许对 GitHub 做的操作」收成一个固定集合。
 *
 * 设计约束（对应 ADR-0003 的收敛思路）：
 * 1. 只暴露具名操作，argv 在函数内部拼好，调用方无法传入任意子命令或任意参数；
 * 2. 所有函数只返回 { ok, code, data, error }，绝不抛异常——上层据此写审计与闸门，
 *    不需要 try/catch，也不会因为一次 gh 失败把整个流程打断；
 * 3. runner 可注入（默认真实 spawnSync），单测用假 runner 断言「实际发出的命令」，
 *    不触网、不影响真实仓库。
 *
 * 合并策略固定为 --squash：不接受合并方式参数，避免调用方悄悄改成 merge / rebase。
 */
import { spawnSync } from 'node:child_process'

/** 固定合并方式：只允许 squash。 */
export const MERGE_STRATEGY = 'squash'

/** prReview 允许的事件，映射到互斥的 gh 开关。 */
const REVIEW_FLAGS = {
  APPROVE: '--approve',
  REQUEST_CHANGES: '--request-changes',
  COMMENT: '--comment',
}

/** prList 允许的 state。 */
const PR_STATES = ['open', 'closed', 'merged', 'all']

const PR_VIEW_FIELDS =
  'number,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,url'
const PR_CHECKS_FIELDS = 'name,state,bucket,link'
const PR_LIST_FIELDS = 'number,title,state,isDraft,headRefName,url'
const ISSUE_VIEW_FIELDS = 'number,title,state,url,body'

/** owner/repo 形式，挡掉以 - 开头之类的注入尝试。 */
const REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9._-]+$/

function fail(code, error) {
  return { ok: false, code, data: null, error }
}

/**
 * 默认 runner：真实调用 gh。
 * 用 spawnSync 而非 exec，参数以数组传递，天然不做 shell 解析。
 */
function defaultRunner(command, args, options) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    ...options,
  })
}

/** 取 stderr 末两行，够定位失败原因又不至于把整屏日志塞进记录。 */
function tailLines(text, count = 2) {
  if (typeof text !== 'string') return ''
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.slice(-count).join('\n')
}

function resolveRunner(runner) {
  return typeof runner === 'function' ? runner : defaultRunner
}

function toPrNumber(value) {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value
  if (typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) return Number(value)
  return null
}

function checkRepo(repo) {
  return typeof repo === 'string' && REPO_PATTERN.test(repo)
}

function checkBody(body) {
  return typeof body === 'string' && body.trim().length > 0
}

/**
 * 统一的执行与结果归一：runner 抛错、返回异常结构、非零退出码都折成失败结果。
 * parseJson 为真时把 stdout 当 JSON 解析，未请求 JSON 的操作直接给原始 stdout。
 */
function execute({ runner, args, parseJson = false, options = {} }) {
  let result
  try {
    result = resolveRunner(runner)('gh', args, options)
  } catch (error) {
    return fail(null, `gh 执行失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (result === null || typeof result !== 'object') {
    return fail(null, 'runner 未返回结果')
  }

  const code = typeof result.status === 'number' ? result.status : null
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''

  if (result.error instanceof Error) {
    return fail(code, `gh 执行失败: ${result.error.message}`)
  }
  if (code !== 0) {
    const detail = tailLines(stderr)
    return fail(code, detail.length > 0 ? detail : `gh 退出码 ${String(code)}，无 stderr 输出`)
  }

  if (!parseJson) {
    return { ok: true, code, data: stdout, error: null }
  }

  try {
    return { ok: true, code, data: JSON.parse(stdout), error: null }
  } catch {
    return fail(code, `gh 输出不是合法 JSON: ${tailLines(stdout, 1) || '(空)'}`)
  }
}

/** 统一的前置校验：号码与仓库两个必填项。 */
function precheck(pr, repo) {
  const number = toPrNumber(pr)
  if (number === null) return { error: fail('E_INPUT', `非法编号: ${String(pr)}`) }
  if (!checkRepo(repo)) return { error: fail('E_INPUT', `非法仓库标识: ${String(repo)}`) }
  return { number }
}

/**
 * 读取 PR 详情。
 * @returns {{ ok: boolean, code: number|null, data: object|string|null, error: string|null }}
 */
export function prView(pr, { repo, runner } = {}) {
  const { number, error } = precheck(pr, repo)
  if (error) return error
  return execute({
    runner,
    parseJson: true,
    args: ['pr', 'view', String(number), '--repo', repo, '--json', PR_VIEW_FIELDS],
  })
}

/** 读取 PR 的 CI 检查结果。 */
export function prChecks(pr, { repo, runner } = {}) {
  const { number, error } = precheck(pr, repo)
  if (error) return error
  return execute({
    runner,
    parseJson: true,
    args: ['pr', 'checks', String(number), '--repo', repo, '--json', PR_CHECKS_FIELDS],
  })
}

/**
 * 合并 PR。合并方式恒为 --squash；squash 传 false 直接拒绝，
 * 而不是退化成 --merge——策略只有一种，就不该留第二种可能的入口。
 */
export function prMerge(pr, { repo, squash = true, runner } = {}) {
  const { number, error } = precheck(pr, repo)
  if (error) return error
  if (squash !== true) {
    return fail('E_INPUT', `只允许 ${MERGE_STRATEGY} 合并，squash 必须为 true`)
  }
  return execute({
    runner,
    args: ['pr', 'merge', String(number), '--repo', repo, '--squash'],
  })
}

/** 在 PR 下发评论。 */
export function prComment(pr, { repo, body, runner } = {}) {
  const { number, error } = precheck(pr, repo)
  if (error) return error
  if (!checkBody(body)) return fail('E_INPUT', '评论内容 body 不能为空')
  return execute({
    runner,
    args: ['pr', 'comment', String(number), '--repo', repo, '--body', body],
  })
}

/**
 * 提交 review。event 只能是 APPROVE / REQUEST_CHANGES / COMMENT，
 * 分别对应互斥开关；body 可选，仅原样作为一个 argv 元素传递。
 */
export function prReview(pr, { repo, event, body, runner } = {}) {
  const { number, error } = precheck(pr, repo)
  if (error) return error
  const flag = REVIEW_FLAGS[event]
  if (!flag) {
    return fail('E_INPUT', `非法 review event: ${String(event)}（允许 APPROVE/REQUEST_CHANGES/COMMENT）`)
  }
  if (body !== undefined && typeof body !== 'string') {
    return fail('E_INPUT', 'review body 必须是字符串')
  }
  const args = ['pr', 'review', String(number), '--repo', repo, flag]
  if (typeof body === 'string' && body.length > 0) args.push('--body', body)
  return execute({ runner, args })
}

/** 列出 PR，state 收敛为固定枚举。 */
export function prList({ repo, state = 'open', runner } = {}) {
  if (!checkRepo(repo)) return fail('E_INPUT', `非法仓库标识: ${String(repo)}`)
  if (!PR_STATES.includes(state)) {
    return fail('E_INPUT', `非法 state: ${String(state)}（允许 ${PR_STATES.join('/')}）`)
  }
  return execute({
    runner,
    parseJson: true,
    args: ['pr', 'list', '--repo', repo, '--state', state, '--json', PR_LIST_FIELDS],
  })
}

/** 读取 issue 详情。 */
export function issueView(n, { repo, runner } = {}) {
  const { number, error } = precheck(n, repo)
  if (error) return error
  return execute({
    runner,
    parseJson: true,
    args: ['issue', 'view', String(number), '--repo', repo, '--json', ISSUE_VIEW_FIELDS],
  })
}
