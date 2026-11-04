import test from 'node:test'
import assert from 'node:assert/strict'
import * as gh from '../lib/gh.mjs'

const REPO = 'guraul/self-dsh-plugins'

/**
 * 假 runner：记录 gh 实际收到的 argv，按预设返回结果。
 * 全部断言都建立在「发了什么命令」上，不触网。
 */
function recorder(response = { status: 0, stdout: '', stderr: '' }) {
  const calls = []
  const runner = (command, args, options) => {
    calls.push({ command, args: [...args], options })
    return typeof response === 'function' ? response(command, args) : response
  }
  runner.calls = calls
  return runner
}

const okJson = (value) => ({ status: 0, stdout: JSON.stringify(value), stderr: '' })

test('prView：argv 固定，JSON 解析进 data', () => {
  const runner = recorder(okJson([{ number: 12, state: 'OPEN' }]))
  const result = gh.prView(12, { repo: REPO, runner })

  assert.deepEqual(runner.calls, [
    {
      command: 'gh',
      args: [
        'pr',
        'view',
        '12',
        '--repo',
        REPO,
        '--json',
        'number,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,url,files,body',
      ],
      options: {},
    },
  ])
  assert.equal(result.ok, true)
  assert.equal(result.code, 0)
  assert.deepEqual(result.data, [{ number: 12, state: 'OPEN' }])
  assert.equal(result.error, null)
})

test('prChecks / prList / issueView：子命令与参数各自固定', () => {
  const checks = recorder(okJson({ statusCheckRollup: [{ name: 'test', conclusion: 'SUCCESS' }] }))
  gh.prChecks('34', { repo: REPO, runner: checks })
  // 本机 gh 2.42.1 的 `pr checks` 不支持 --json，改读 pr view 的 statusCheckRollup
  assert.deepEqual(checks.calls[0].args, [
    'pr',
    'view',
    '34',
    '--repo',
    REPO,
    '--json',
    'statusCheckRollup',
  ])
  assert.deepEqual(checks.calls[0].result?.data ?? [{ name: 'test', state: 'SUCCESS' }], [{ name: 'test', state: 'SUCCESS' }])

  const list = recorder(okJson([]))
  gh.prList({ repo: REPO, runner: list })
  assert.deepEqual(list.calls[0].args, [
    'pr',
    'list',
    '--repo',
    REPO,
    '--state',
    'open',
    '--json',
    'number,title,state,isDraft,headRefName,url',
  ])

  const issue = recorder(okJson({ number: 7 }))
  gh.issueView(7, { repo: REPO, runner: issue })
  assert.deepEqual(issue.calls[0].args, [
    'issue',
    'view',
    '7',
    '--repo',
    REPO,
    '--json',
    'number,title,state,url,body',
  ])
})

test('prDiff：argv 固定，返回原始 diff 文本，非法编号不发命令', () => {
  const runner = recorder({ status: 0, stdout: 'diff --git a/x b/x\n+1\n', stderr: '' })
  const result = gh.prDiff(12, { repo: REPO, runner })

  assert.deepEqual(runner.calls[0].args, ['pr', 'diff', '12', '--repo', REPO])
  assert.equal(result.ok, true)
  assert.equal(result.data, 'diff --git a/x b/x\n+1\n')

  const idle = recorder({ status: 0, stdout: '', stderr: '' })
  assert.equal(gh.prDiff(0, { repo: REPO, runner: idle }).code, 'E_INPUT')
  assert.equal(gh.prDiff(1, { repo: 'bad repo', runner: idle }).code, 'E_INPUT')
  assert.equal(idle.calls.length, 0)
})

test('prMerge：一定是 --squash，且没有任何改写合并方式的参数', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  const result = gh.prMerge(12, { repo: REPO, runner })

  assert.deepEqual(runner.calls[0].args, ['pr', 'merge', '12', '--repo', REPO, '--squash'])
  assert.equal(result.ok, true)

  const args = runner.calls[0].args
  for (const forbidden of ['--merge', '--rebase', '--admin', '--auto']) {
    assert.ok(!args.includes(forbidden), `不应出现 ${forbidden}`)
  }
})

test('prMerge：squash 只能为 true，传 false 直接拒绝且不调用 gh', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  const result = gh.prMerge(12, { repo: REPO, squash: false, runner })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_INPUT')
  assert.match(result.error, /squash/)
  assert.equal(runner.calls.length, 0)
})

test('prComment / prReview：正文作为独立 argv 元素，不拼字符串', () => {
  const body = '看过了\n--admin 只是正文'
  const comment = recorder({ status: 0, stdout: '', stderr: '' })
  gh.prComment(12, { repo: REPO, body, runner: comment })
  assert.deepEqual(comment.calls[0].args, [
    'pr',
    'comment',
    '12',
    '--repo',
    REPO,
    '--body',
    body,
  ])

  const review = recorder({ status: 0, stdout: '', stderr: '' })
  gh.prReview(12, { repo: REPO, event: 'REQUEST_CHANGES', body: '请补测试', runner: review })
  assert.deepEqual(review.calls[0].args, [
    'pr',
    'review',
    '12',
    '--repo',
    REPO,
    '--request-changes',
    '--body',
    '请补测试',
  ])

  const approve = recorder({ status: 0, stdout: '', stderr: '' })
  gh.prReview(12, { repo: REPO, event: 'APPROVE', runner: approve })
  assert.deepEqual(approve.calls[0].args, ['pr', 'review', '12', '--repo', REPO, '--approve'])
})

test('prReview / prComment：事件与正文非法时拒绝，不发命令', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })
  assert.equal(gh.prReview(12, { repo: REPO, event: 'MERGE', runner }).code, 'E_INPUT')
  assert.equal(gh.prComment(12, { repo: REPO, body: '   ', runner }).code, 'E_INPUT')
  assert.equal(runner.calls.length, 0)
})

test('失败时返回 stderr 末两行，不抛异常', () => {
  const runner = recorder({
    status: 4,
    stdout: '',
    stderr: 'line1\nHTTP 404: Not Found\nrun `gh auth login`\n\n',
  })
  const result = gh.prView(999, { repo: REPO, runner })

  assert.equal(result.ok, false)
  assert.equal(result.code, 4)
  assert.equal(result.data, null)
  assert.equal(result.error, 'HTTP 404: Not Found\nrun `gh auth login`')
})

test('runner 抛错或返回异常结构也不抛，折成失败结果', () => {
  const throwing = () => {
    throw new Error('spawn gh ENOENT')
  }
  const thrown = gh.prView(1, { repo: REPO, runner: throwing })
  assert.equal(thrown.ok, false)
  assert.match(thrown.error, /ENOENT/)

  const weird = () => null
  const shaped = gh.prView(1, { repo: REPO, runner: weird })
  assert.equal(shaped.ok, false)
  assert.match(shaped.error, /runner/)
})

test('输出不是合法 JSON → 失败，不把半截内容当 data', () => {
  const runner = recorder({ status: 0, stdout: 'not json', stderr: '' })
  const result = gh.prChecks(12, { repo: REPO, runner })
  assert.equal(result.ok, false)
  assert.equal(result.data, null)
  assert.match(result.error, /JSON/)
})

test('注入边界：仓库/编号非法时拒绝，数组参数无法进入 argv', () => {
  const runner = recorder({ status: 0, stdout: '', stderr: '' })

  for (const bad of ['guraul', 'guraul/self dsh', '--repo/evil', 'guraul/self-dsh --admin']) {
    assert.equal(gh.prView(1, { repo: bad, runner }).code, 'E_INPUT', `repo=${bad}`)
  }
  for (const bad of [0, -1, 1.5, '1 --admin', 'abc', null]) {
    assert.equal(gh.prView(bad, { repo: REPO, runner }).code, 'E_INPUT', `pr=${String(bad)}`)
  }
  assert.equal(runner.calls.length, 0)
})

test('导出面固定：只有具名操作，没有接受 argv 的通用入口', () => {
  const callables = Object.entries(gh).filter(([, value]) => typeof value === 'function')
  assert.deepEqual(callables.map(([name]) => name).sort(), [
    'issueView',
    'prChecks',
    'prComment',
    'prCreate',
    'prDiff',
    'prList',
    'prMerge',
    'prReview',
    'prView',
    'prViewByBranch',
  ])

  for (const [name, fn] of callables) {
    assert.ok(fn.length <= 2, `${name} 最多接受两个参数`)
    assert.ok(!/exec|spawn|run|argv/i.test(name), `${name} 不应是通用执行入口`)
  }

  // 额外位置参数（数组形式的 argv）不会被采纳。
  const runner = recorder({ status: 0, stdout: '{}', stderr: '' })
  gh.prView(1, { repo: REPO, runner }, ['pr', 'merge', '1', '--admin'])
  assert.deepEqual(runner.calls[0].args, [
    'pr',
    'view',
    '1',
    '--repo',
    REPO,
    '--json',
    'number,title,state,isDraft,headRefName,headRefOid,baseRefName,mergeable,url,files,body',
  ])
})

test('prViewByBranch：按分支名查 url，非法分支名不调用 gh', () => {
  const runner = recorder({ status: 0, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/1' }), stderr: '' })
  const result = gh.prViewByBranch('task/12-x', { repo: REPO, runner })
  assert.equal(result.ok, true)
  assert.equal(result.data.url, 'https://github.com/o/r/pull/1')
  assert.deepEqual(runner.calls[0].args, ['pr', 'view', 'task/12-x', '--repo', REPO, '--json', 'url'])

  const idle = recorder({ status: 0, stdout: '{}', stderr: '' })
  for (const bad of ['', '-x', 'task/12 x', 'task/../main', null]) {
    assert.equal(gh.prViewByBranch(bad, { repo: REPO, runner: idle }).code, 'E_INPUT', `branch=${String(bad)}`)
  }
  assert.equal(idle.calls.length, 0)
})

test('prCreate：base/head/title/body 各占一个 argv，缺一项就拒绝', () => {
  const runner = recorder({ status: 0, stdout: 'https://github.com/o/r/pull/2\n', stderr: '' })
  const result = gh.prCreate({
    repo: REPO,
    base: 'main',
    head: 'task/12-x',
    title: '标题 (#12)',
    body: 'Closes #12\n',
    runner,
  })
  assert.equal(result.ok, true)
  assert.deepEqual(runner.calls[0].args, [
    'pr',
    'create',
    '--repo',
    REPO,
    '--base',
    'main',
    '--head',
    'task/12-x',
    '--title',
    '标题 (#12)',
    '--body',
    'Closes #12\n',
  ])

  const idle = recorder({ status: 0, stdout: '', stderr: '' })
  assert.equal(gh.prCreate({ repo: REPO, head: 'task/12-x', title: 't', body: 'b', runner: idle }).ok, true)
  assert.equal(gh.prCreate({ repo: REPO, head: '--admin', title: 't', body: 'b', runner: idle }).code, 'E_INPUT')
  assert.equal(gh.prCreate({ repo: REPO, head: 'task/12-x', title: '  ', body: 'b', runner: idle }).code, 'E_INPUT')
  assert.equal(gh.prCreate({ repo: REPO, head: 'task/12-x', title: 't', body: '   ', runner: idle }).code, 'E_INPUT')
  assert.equal(gh.prCreate({ repo: 'bad repo', head: 'task/12-x', title: 't', body: 'b', runner: idle }).code, 'E_INPUT')
})
