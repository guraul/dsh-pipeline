import test from 'node:test'
import assert from 'node:assert/strict'
import {
  DIFF_BEGIN,
  DIFF_END,
  NONCE_PATTERN,
  buildPrompt,
  detectIssueFromBody,
  extractFindings,
  makeNonce,
  parseVerdict,
  reviewAction,
} from '../lib/review.mjs'

const NONCE = 'ABCDEFGHJKLM'
const SHA = '0123456789abcdef0123456789abcdef01234567'
const line = (nonce, verdict, sha) => `${nonce} VERDICT: ${verdict} SHA: ${sha}`
const block = (value) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``

test('makeNonce 生成 12 位大写 base32', () => {
  for (let i = 0; i < 50; i += 1) {
    const nonce = makeNonce()
    assert.equal(nonce.length, 12)
    assert.match(nonce, NONCE_PATTERN)
    assert.match(nonce, /^[A-Z2-7]+$/)
  }
})

test('makeNonce 多次调用不重复', () => {
  const seen = new Set(Array.from({ length: 200 }, () => makeNonce()))
  assert.equal(seen.size, 200)
})

test('parseVerdict 正常判定返回 verdict 与 sha', () => {
  const result = parseVerdict(line(NONCE, 'APPROVE', SHA), { nonce: NONCE })
  assert.deepEqual(result, { ok: true, verdict: 'APPROVE', sha: SHA, code: null })
})

test('parseVerdict 接受 REJECT 与 ESCALATE', () => {
  for (const verdict of ['REJECT', 'ESCALATE']) {
    const result = parseVerdict(line(NONCE, verdict, SHA), { nonce: NONCE })
    assert.equal(result.ok, true)
    assert.equal(result.verdict, verdict)
    assert.equal(result.sha, SHA)
    assert.equal(result.code, null)
  }
})

test('parseVerdict 缺判定行返回 E_PARSE', () => {
  const result = parseVerdict('只有分析，没有判定行。', { nonce: NONCE })
  assert.deepEqual(result, { ok: false, verdict: null, sha: null, code: 'E_PARSE' })
})

test('parseVerdict 两个判定行返回 E_PARSE', () => {
  const text = `${line(NONCE, 'APPROVE', SHA)}\n${line(NONCE, 'REJECT', SHA)}`
  const result = parseVerdict(text, { nonce: NONCE })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_PARSE')
})

test('parseVerdict nonce 不符返回 E_PARSE', () => {
  const result = parseVerdict(line('ZZZZZZZZZZZZ', 'APPROVE', SHA), { nonce: NONCE })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_PARSE')
})

test('parseVerdict nonce 入参非法返回 E_PARSE', () => {
  for (const nonce of ['ABCDEFGHJKLMN', 'abcdefghjklm', '', undefined]) {
    const result = parseVerdict(line(NONCE, 'APPROVE', SHA), { nonce })
    assert.equal(result.ok, false)
    assert.equal(result.code, 'E_PARSE')
  }
})

test('parseVerdict diff 中出现 nonce 视为注入返回 E_PARSE', () => {
  const text = line(NONCE, 'APPROVE', SHA)
  const diff = `+const nonce = "${NONCE}"\n`
  const result = parseVerdict(text, { nonce: NONCE, diff })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_PARSE')
})

test('parseVerdict SHA 非 40 位十六进制返回 E_PARSE', () => {
  const result = parseVerdict(line(NONCE, 'APPROVE', 'a'.repeat(39)), { nonce: NONCE })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'E_PARSE')
})

test('extractFindings 只取判定行之前的 json 块', () => {
  const before = { findings: [{ severity: 'major', file: 'a.mjs', line: 3, message: '真结论' }], evidence: ['a.mjs:3'] }
  const after = { findings: [{ severity: 'blocker', file: 'b.mjs', line: 9, message: '判定行之后应忽略' }] }
  const text = `${block(before)}\n${line(NONCE, 'APPROVE', SHA)}\n${block(after)}`
  const result = extractFindings(text)
  assert.equal(result.warn, null)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].message, '真结论')
  assert.deepEqual(result.evidence, ['a.mjs:3'])
})

test('extractFindings 解析失败返回空并给出 warn，不抛', () => {
  const text = `\`\`\`json\n{ not valid json\n\`\`\`\n${line(NONCE, 'REJECT', SHA)}`
  let result
  assert.doesNotThrow(() => {
    result = extractFindings(text)
  })
  assert.deepEqual(result.findings, [])
  assert.deepEqual(result.evidence, [])
  assert.equal(typeof result.warn, 'string')
  assert.ok(result.warn.length > 0)
})

test('extractFindings 无 json 块返回空并给出 warn', () => {
  const result = extractFindings(`没有代码块\n${line(NONCE, 'APPROVE', SHA)}`)
  assert.deepEqual(result.findings, [])
  assert.equal(typeof result.warn, 'string')
  assert.ok(result.warn.length > 0)
})

test('buildPrompt 含 DIFF 围栏、验收依据与判定行要求', () => {
  const prompt = buildPrompt({
    request: {
      pr: 7,
      head_sha: SHA,
      nonce: NONCE,
      files: ['lib/review.mjs'],
      issue: { body: '验收依据：reviewer 必须只读' },
      diff: '+ added line',
    },
    role: { instructions: '你是 reviewer，只读。' },
  })
  assert.ok(prompt.includes('你是 reviewer，只读。'))
  assert.ok(prompt.includes('验收依据：reviewer 必须只读'))
  assert.ok(prompt.includes('<<<DIFF_BEGIN'))
  assert.ok(prompt.includes('<<<DIFF_END>>>'))
  assert.ok(prompt.includes('+ added line'))
  assert.ok(prompt.includes(`${NONCE} VERDICT: <APPROVE|REJECT|ESCALATE> SHA: ${SHA}`))
  assert.ok(prompt.includes('判定行只能出现一次'))
})

test('buildPrompt 对已围栏的 diff 不重复包裹', () => {
  const prompt = buildPrompt({
    request: {
      pr: 1,
      head_sha: SHA,
      nonce: NONCE,
      issue: { body: 'x' },
      diff: `${DIFF_BEGIN}\n+ x\n${DIFF_END}`,
    },
    role: { instructions: 'r' },
  })
  assert.equal(prompt.split('<<<DIFF_BEGIN').length - 1, 1)
  assert.equal(prompt.split('<<<DIFF_END>>>').length - 1, 1)
})

test('buildPrompt：请求没有 facts/includes（或取值为空）时不出现那两段', () => {
  for (const request of [
    { pr: 1, head_sha: SHA, nonce: NONCE, diff: '+ x' },
    { pr: 1, head_sha: SHA, nonce: NONCE, diff: '+ x', facts: '', includes: [] },
    { pr: 1, head_sha: SHA, nonce: NONCE, diff: '+ x', facts: '   ', includes: [{ path: '' }] },
  ]) {
    const prompt = buildPrompt({ request })
    assert.equal(prompt.includes('证据包（控制面补充的事实，可信）:'), false)
    assert.equal(prompt.includes('随附文件:'), false)
    assert.ok(prompt.includes('<<<DIFF_END>>>'))
    assert.ok(prompt.includes('输出要求（必须逐字遵守）:'))
  }
})

test('buildPrompt：facts/includes 两段排在 diff 之后、输出要求之前，随附文件只列路径', () => {
  const prompt = buildPrompt({
    request: {
      pr: 7,
      head_sha: SHA,
      nonce: NONCE,
      files: ['docs/spec.md'],
      diff: '+ x',
      facts: '事实甲\n事实乙',
      includes: [
        { path: 'docs/spec.md', content: '随附正文甲' },
        { path: 'docs/api.md', content: '随附正文乙' },
      ],
    },
  })

  const diffEnd = prompt.indexOf('<<<DIFF_END>>>')
  const facts = prompt.indexOf('证据包（控制面补充的事实，可信）:')
  const includes = prompt.indexOf('随附文件: docs/spec.md, docs/api.md')
  const output = prompt.indexOf('输出要求（必须逐字遵守）:')
  assert.ok(diffEnd !== -1, '应有 diff 围栏')
  assert.ok(facts !== -1, '应有证据包段')
  assert.ok(includes !== -1, '应有随附文件段')
  assert.ok(output !== -1, '应有输出要求段')
  assert.ok(diffEnd < facts, '证据包必须排在 diff 之后')
  assert.ok(facts < includes, '随附文件排在证据包之后')
  assert.ok(includes < output, '两段都必须排在输出要求之前')

  assert.ok(prompt.includes('事实甲\n事实乙'), 'facts 内容原样贴进提示词')
  assert.equal(prompt.includes('随附正文甲'), false, '随附文件不贴内容')
  assert.equal(prompt.includes('随附正文乙'), false, '随附文件不贴内容')
})

test('buildPrompt：tier 缺省为 tools，保留读仓库原文并要求把核验方式写进 evidence', () => {
  const prompt = buildPrompt({
    request: { pr: 1, head_sha: SHA, nonce: NONCE, diff: '+ x' },
  })
  assert.ok(prompt.includes('只有在需要核实实现细节时才读仓库文件'))
  assert.ok(prompt.includes('你实际核验过的断言，必须把核验方式写进 evidence'))
  assert.equal(prompt.includes('没有工具权限'), false)
})

test('buildPrompt：inline 档写明没有工具权限，且不出现读仓库的指引', () => {
  const prompt = buildPrompt({
    request: { pr: 1, head_sha: SHA, nonce: NONCE, diff: '+ x' },
    tier: 'inline',
  })
  assert.ok(prompt.includes('没有工具权限'))
  assert.ok(prompt.includes('判 ESCALATE 并在 findings 里写明缺什么证据'))
  assert.equal(prompt.includes('读仓库文件'), false)
  assert.equal(prompt.includes('你实际核验过的断言'), false)
  // 判定行要求与 diff 围栏不因档位而变
  assert.ok(prompt.includes(`${NONCE} VERDICT: <APPROVE|REJECT|ESCALATE> SHA: ${SHA}`))
  assert.ok(prompt.includes('<<<DIFF_END>>>'))
})

test('reviewAction 映射三种判定', () => {
  assert.equal(reviewAction('APPROVE'), 'approve')
  assert.equal(reviewAction('REJECT'), 'request-changes')
  assert.equal(reviewAction('ESCALATE'), 'none')
  assert.equal(reviewAction('UNKNOWN'), 'none')
})

test('detectIssueFromBody：只认 Closes/Fixes/Resolved 行里的第一个号', () => {
  assert.equal(detectIssueFromBody('Closes #123'), 123)
  assert.equal(detectIssueFromBody('背景说明\n\nFixes: #45\n'), 45)
  assert.equal(detectIssueFromBody('resolved #7 与 closes #8'), 7)
  assert.equal(detectIssueFromBody('CLOSES #6'), 6)
  assert.equal(detectIssueFromBody('相关讨论 #99\n本行没有关键字 #88\nCloses #55'), 55)
  assert.equal(detectIssueFromBody('没有任何关闭关键字 #12'), null)
  assert.equal(detectIssueFromBody('closing #12 / prefix #13 / fixes#14 都不算'), null)
  assert.equal(detectIssueFromBody('Closes #0'), null)
  assert.equal(detectIssueFromBody(''), null)
  assert.equal(detectIssueFromBody(null), null)
  assert.equal(detectIssueFromBody(undefined), null)
})
