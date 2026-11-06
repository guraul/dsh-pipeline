/**
 * lib/semver.mjs：`selftest --peer` 的范围匹配地基。
 *
 * 覆盖 parseVersion 的三个出口（合法 / 带预发布 / 非法）、compare 的预发布排序与 build 忽略、
 * satisfies 的 `^`（含 0.x / 0.0.x 上界）、`~`、比较器组合、`||` 或选、通配、
 * 以及两条最容易错的语义：预发布照常比较（偏离 npm 的闸门，理由见下）与 `<0.3.0-0`。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { compare, parseVersion, satisfies } from '../lib/semver.mjs'

test('parseVersion：合法版本 / 预发布 / build / 非法', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseVersion('0.2.2-rc.1'), { major: 0, minor: 2, patch: 2, pre: ['rc', '1'] })
  assert.deepEqual(parseVersion('1.2.3+build.5'), { major: 1, minor: 2, patch: 3, pre: [] })
  assert.deepEqual(parseVersion('1.2.3-rc.1+build'), { major: 1, minor: 2, patch: 3, pre: ['rc', '1'] })

  for (const bad of ['', '1.2', 'v1.2.3', '1.2.3.4', '^1.2.3', null, undefined, 123]) {
    assert.equal(parseVersion(bad), null, `${String(bad)} 应判非法`)
  }
})

test('compare：主次补丁号 + 预发布排序 + build 不参与', () => {
  assert.equal(compare('1.0.0', '1.0.0'), 0)
  assert.equal(compare('1.0.0', '1.0.1'), -1)
  assert.equal(compare('1.10.0', '1.9.0'), 1)
  // semver §11 的经典序列
  const chain = [
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0-alpha.beta',
    '1.0.0-beta',
    '1.0.0-beta.2',
    '1.0.0-beta.11',
    '1.0.0-rc.1',
    '1.0.0',
  ]
  for (let index = 1; index < chain.length; index += 1) {
    assert.equal(compare(chain[index - 1], chain[index]), -1, `${chain[index - 1]} < ${chain[index]}`)
  }
  // 数字标识符小于字母标识符
  assert.equal(compare('1.0.0-1', '1.0.0-alpha'), -1)
  // build 元数据不影响比较
  assert.equal(compare('1.0.0+aaa', '1.0.0+zzz'), 0)
})

test('compare：非法输入抛错（调用方应先 parseVersion）', () => {
  assert.throws(() => compare('nope', '1.0.0'), /无法比较的版本/)
  assert.throws(() => compare('1.0.0', '1.0'), /无法比较的版本/)
  // 非字符串非对象（数字 / null / 缺字段的对象）也走同一条错误路径，不静默比较
  assert.throws(() => compare(5, '1.0.0'), /无法比较的版本/)
  assert.throws(() => compare(null, '1.0.0'), /无法比较的版本/)
  assert.throws(() => compare({ major: 1 }, '1.0.0'), /无法比较的版本/)
  // 已解析对象与版本串等价
  assert.equal(compare('1.2.3', parseVersion('1.2.3')), 0)
})

test('satisfies：^ 的上界（普通 / 0.x / 0.0.x）', () => {
  assert.equal(satisfies('1.4.2', '^1.2.3'), true)
  assert.equal(satisfies('2.0.0', '^1.2.3'), false)
  assert.equal(satisfies('0.2.9', '^0.2.1'), true)
  assert.equal(satisfies('0.3.0', '^0.2.1'), false)
  assert.equal(satisfies('0.0.3', '^0.0.3'), true)
  assert.equal(satisfies('0.0.4', '^0.0.3'), false)
})

test('satisfies：~ 的上界', () => {
  assert.equal(satisfies('1.2.9', '~1.2.3'), true)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
  assert.equal(satisfies('1.2.3', '~1.2.3'), true)
})

test('satisfies：比较器组合是「与」，|| 是「或」', () => {
  assert.equal(satisfies('0.2.5', '>=0.2.0 <0.3.0'), true)
  assert.equal(satisfies('0.3.0', '>=0.2.0 <0.3.0'), false)
  assert.equal(satisfies('0.2.1', '^0.1.0 || ^0.2.0'), true)
  assert.equal(satisfies('0.3.0', '^0.1.0 || ^0.2.0'), false)
})

test('satisfies：> 与 <=（inclusive 翻转）', () => {
  assert.equal(satisfies('1.2.4', '>1.2.3'), true)
  assert.equal(satisfies('1.2.3', '>1.2.3'), false)
  assert.equal(satisfies('1.2.3', '<=1.2.3'), true)
  assert.equal(satisfies('1.2.4', '<=1.2.3'), false)
})

test('satisfies：-0 上界把上界版本的预发布也排除掉', () => {
  // ^ 与 ~ 生成的上界都带 -0：`<0.3.0-0` / `<1.3.0-0` / `<2.0.0-0`
  assert.equal(satisfies('0.3.0-rc.1', '^0.2.1'), false)
  assert.equal(satisfies('1.3.0-rc.1', '~1.2.3'), false)
  assert.equal(satisfies('2.0.0-rc.1', '^1.2.3'), false)
  // 上界版本本身当然也不在范围内
  assert.equal(satisfies('0.3.0', '^0.2.1'), false)
  assert.equal(satisfies('1.3.0', '~1.2.3'), false)
})

test('satisfies：非字符串非对象 / 非法版本 / 带数字的通配一律 false', () => {
  assert.equal(satisfies(5, '*'), false)
  assert.equal(satisfies(null, '*'), false)
  assert.equal(satisfies('1.0.0-01', '*'), false) // 前导零的数字标识符合法
  assert.equal(satisfies('1.x', '*'), false) // 只认裸 *
  assert.equal(satisfies('1.0.0', '1.x'), false) // 带数字的通配不支持
})

test('satisfies：精确版本、通配、以及「范围写坏不抛错」', () => {
  assert.equal(satisfies('1.2.3', '1.2.3'), true)
  assert.equal(satisfies('1.2.4', '1.2.3'), false)
  assert.equal(satisfies('1.2.3', '=1.2.3'), true)
  assert.equal(satisfies('9.9.9', '*'), true)
  assert.equal(satisfies('9.9.9', 'x'), true)
  assert.equal(satisfies('9.9.9', 'X'), true)

  for (const bad of ['^abc', '>=1.2', '1.2.3 - 2.0.0', '']) {
    assert.equal(satisfies('1.2.3', bad), false, `范围 ${JSON.stringify(bad)} 应判不满足`)
  }
  assert.equal(satisfies('nope', '^1.0.0'), false)
})

test('satisfies：预发布照常参与比较（不施加 npm 的同段闸门）', () => {
  // 故意偏离 node-semver：DSH 常发 rc，插件的 `^0.2.1-rc.2` 在官方兼容表里覆盖 0.2.2-rc.1。
  // 若照搬 npm 的「同段预发布才允许命中」，真实声明会全部变成假警报。
  assert.equal(satisfies('1.0.0-beta', '*'), true)
  assert.equal(satisfies('1.0.0-beta', '>=0.5.0'), true)
  assert.equal(satisfies('0.2.2-rc.1', '^0.2.1-rc.2'), true)
  assert.equal(satisfies('0.2.2-rc.1', '^0.2.2-rc.2'), false)
  assert.equal(satisfies('0.2.0', '^0.2.1-rc.2'), false)

  // <0.3.0-0 仍然把 0.3.0 的所有预发布挡在外面（"-0" 是最小的预发布）
  assert.equal(satisfies('0.2.2-rc.1', '>=0.1.0-rc.7 <0.3.0-0'), true)
  assert.equal(satisfies('0.3.0-rc.1', '>=0.1.0-rc.7 <0.3.0-0'), false)
  // 同段之间仍按预发布顺序比较
  assert.equal(satisfies('1.0.0-beta', '^1.0.0-alpha'), true)
  assert.equal(satisfies('1.0.0-alpha', '^1.0.0-beta'), false)
})

test('satisfies：真实插件声明样例（来自 self-dsh-plugins 的 package.json）', () => {
  const dsh = '0.2.2-rc.1'
  // dsh-plugin-product-subagents 的 dsh.compatibility.dsh
  assert.equal(
    satisfies(
      dsh,
      '^0.0.1-rc.5 || ^0.1.0-rc.2 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.3-alpha.2 || ^0.1.5-alpha.1 || ^0.2.0-rc.2 || ^0.2.1-alpha.5',
    ),
    true,
  )
  // dsh-subagents 的 dsh.compatibility.dsh
  assert.equal(satisfies(dsh, '^0.2.1-alpha.5 || ^0.2.2-alpha.2'), true)
  // dsh-im-bridge-workspaces 的 dsh.compatibility.dsh
  assert.equal(satisfies(dsh, '^0.2.1-rc.2 || ^0.2.1-rc.4'), true)
  // dsh-prompt-optimizer 的 engines.dsh
  assert.equal(satisfies(dsh, '>=0.1.0-rc.7 <0.3.0-0'), true)
  // dsh-usage-panel 的 dsh.engines.dsh
  assert.equal(satisfies(dsh, '>=0.1.5-rc.1'), true)
})
