/**
 * deploy：契约 §10 落地第一步——`deploy` 配置字段 + caller workflow 骨架生成 / 校验。
 *
 * 覆盖：init 打印骨架（uses pin、with 逐项、concurrency、首尾标记、不落盘）、
 * init --write 落盘 + check 一致退 0、改配置后 check 打印第一处差异退 1、
 * 手改生成区一行退 1、标记之后追加 job 仍退 0、改配置重跑 --write 只换生成区并保留追加内容、
 * artifact=oci-image 退 2、缺文件 / 缺标记退 1、手写文件拒绝覆盖退 1、
 * 参数与缺 deploy 段 / 缺 build.json 退 2。
 * 构建标识经 deps.buildInfo 注入，不依赖包内 build.json（CI 源码运行没有该文件）。
 * 只调 runCli（注入输出流），不碰真实 gh / git。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCli } from '../bin/cli.mjs'
import { DEPLOY_WORKFLOW_FILE, REGION_BEGIN, REGION_END } from '../lib/deploy.mjs'

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const GIT_SHA = '0123456789abcdef0123456789abcdef01234567'
const BUILD_INFO = { gitSha: GIT_SHA, builtAt: '2026-11-06T00:00:00Z', dirty: false }

const BASE_DEPLOY = {
  artifact: 'static-dir',
  service: 'serve-9928',
  remoteDir: '/root/project/demo/demo-app',
  workDir: 'demo-app',
  health: { url: 'http://127.0.0.1:9929/' },
}

function tmp() {
  return mkdtempSync(join(tmpdir(), 'dsh-deploy-'))
}

function writeConfig(root, deploy) {
  mkdirSync(join(root, '.dsh'), { recursive: true })
  const value = deploy === undefined ? { repo: 'guraul/demo' } : { repo: 'guraul/demo', deploy }
  writeFileSync(join(root, '.dsh', 'pipeline.json'), JSON.stringify(value, null, 2), 'utf8')
}

function run(argv, deps = {}) {
  const state = { out: '', err: '' }
  const code = runCli(argv, {
    stdout: (text) => {
      state.out += text
    },
    stderr: (text) => {
      state.err += text
    },
    buildInfo: BUILD_INFO,
    ...deps,
  })
  return { code, ...state }
}

function workflowPath(root) {
  return join(root, ...DEPLOY_WORKFLOW_FILE.split('/'))
}

function init(root, extra = []) {
  return run(['deploy', 'init', '--root', root, ...extra])
}

function check(root) {
  return run(['deploy', 'check', '--root', root])
}

test('deploy init：不带 --write 只打印骨架，uses / with / concurrency / 标记齐全', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const result = init(root)
  assert.equal(result.code, 0)
  assert.equal(result.err, '')
  assert.ok(!existsSync(workflowPath(root)), '不带 --write 不应落盘')

  const out = result.out
  assert.ok(out.startsWith(`${REGION_BEGIN}\n`), '首行应是生成区起始标记')
  assert.ok(out.trimEnd().endsWith(REGION_END), '末行应是生成区结束标记')

  // uses pin 到当前安装包的构建标识（注入的 gitSha）
  assert.ok(out.includes(`uses: guraul/dsh-pipeline/.github/workflows/deploy.yml@${GIT_SHA}\n`), 'uses 应 pin gitSha')
  // concurrency：串行部署，不取消进行中的部署
  assert.ok(out.includes('concurrency:\n  group: deploy-web\n  cancel-in-progress: false\n'))
  // on：push 到 main + 手动触发
  assert.ok(out.includes('on:\n  push:\n    branches:\n      - main\n  workflow_dispatch:\n'))
  // with：配置逐项填入，缺省值补齐
  assert.ok(out.includes("      mode: 'releases'\n"))
  assert.ok(out.includes("      service: 'serve-9928'\n"))
  assert.ok(out.includes("      remote_dir: '/root/project/demo/demo-app'\n"))
  assert.ok(out.includes("      work_dir: 'demo-app'\n"))
  assert.ok(out.includes("      health_url: 'http://127.0.0.1:9929/'\n"))
  assert.ok(out.includes("      health_check: 'http'\n"))
  assert.ok(out.includes('      public_health_insecure: true\n'))
  assert.ok(out.includes('      keep_releases: 5\n'))
  assert.ok(out.includes('    secrets: inherit\n'))
  // 单个 job：jobs 下只有 deploy
  assert.ok(out.includes('jobs:\n  deploy:\n'))
  // 没配置的可选项不写
  assert.ok(!out.includes('artifact_dir:'), '未配 artifactDir 不应出现')
  assert.ok(!out.includes('ssh_host:'), '未配 sshHost 不应出现')
  assert.ok(!out.includes('public_health_url:'), '未配 publicUrl 不应出现')
})

test('deploy init：node-standalone 在生成阶段拒绝（构建步骤尚未参数化）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, {
    artifact: 'node-standalone',
    service: 'serve-node',
    remoteDir: '/srv/node-app',
    workDir: 'apps/api',
    health: { url: 'http://127.0.0.1:1/' },
  })
  const r = run(['deploy', 'init', '--root', root], { buildInfo: { gitSha: 'a'.repeat(40) } })
  assert.equal(r.code, 2)
  assert.match(r.err, /node-standalone 尚未实现/)
})

test('deploy init --write 落盘，deploy check 一致退 0', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const written = init(root, ['--write'])
  assert.equal(written.code, 0)
  assert.equal(written.err, '')
  assert.equal(written.out, `deploy init: 已写入 ${DEPLOY_WORKFLOW_FILE}\n`)
  const file = workflowPath(root)
  assert.ok(existsSync(file), '应生成 workflow 文件')

  const result = check(root)
  assert.equal(result.code, 0)
  assert.equal(result.out, 'deploy check: 生成区与配置一致\n')
  assert.equal(result.err, '')
})

test('deploy check：改配置后报不一致，打印第一处差异并退 1', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.keepReleases = 3
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /第一处差异在第 \d+ 行/)
  assert.match(result.err, /期望:.*keep_releases: 3/)
  assert.match(result.err, /实际:.*keep_releases: 5/)
})

test('deploy check：手改生成区一行 → 退 1，指出该行', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  const original = readFileSync(file, 'utf8')
  writeFileSync(file, original.replace('cancel-in-progress: false', 'cancel-in-progress: true'), 'utf8')

  const result = check(root)
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /期望:.*cancel-in-progress: false/)
  assert.match(result.err, /实际:.*cancel-in-progress: true/)
})

test('deploy check：标记之后追加 job → 仍退 0（追加内容不参与比对）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  const appended = [
    '  post-deploy:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - run: echo done',
    '',
  ].join('\n')
  writeFileSync(file, readFileSync(file, 'utf8') + appended, 'utf8')

  const result = check(root)
  assert.equal(result.code, 0)
  assert.equal(result.out, 'deploy check: 生成区与配置一致\n')
})

test('deploy init --write：改配置重跑只换生成区，保留标记之后追加的 job', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)
  assert.equal(init(root, ['--write']).code, 0)

  const file = workflowPath(root)
  writeFileSync(
    file,
    `${readFileSync(file, 'utf8')}  post-deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo done\n`,
    'utf8',
  )

  const configFile = join(root, '.dsh', 'pipeline.json')
  const config = JSON.parse(readFileSync(configFile, 'utf8'))
  config.deploy.keepReleases = 3
  writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf8')

  const again = init(root, ['--write'])
  assert.equal(again.code, 0)
  assert.match(again.out, /已更新.*生成区/)

  const content = readFileSync(file, 'utf8')
  assert.ok(content.includes('keep_releases: 3'), '新配置应写进生成区')
  assert.ok(content.includes('  post-deploy:'), '追加的 job 应保留')
  assert.equal(check(root).code, 0)
})

test('deploy：artifact=oci-image → init 与 check 都退 2，报尚未实现', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, { ...BASE_DEPLOY, artifact: 'oci-image' })

  const initResult = init(root)
  assert.equal(initResult.code, 2)
  assert.equal(initResult.out, '')
  assert.match(initResult.err, /oci-image 尚未实现/)

  const checkResult = check(root)
  assert.equal(checkResult.code, 2)
  assert.match(checkResult.err, /oci-image 尚未实现/)
  assert.ok(!existsSync(workflowPath(root)), '未实现时不应落盘')
})

test('deploy check：文件不存在 → 退 1 提示先跑 deploy init；缺标记 → 报不是生成的骨架', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const missing = check(root)
  assert.equal(missing.code, 1)
  assert.equal(missing.out, '')
  assert.match(missing.err, /不存在，请先运行 deploy init/)

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  writeFileSync(workflowPath(root), 'name: hand-written\non: push\n', 'utf8')

  const notGenerated = check(root)
  assert.equal(notGenerated.code, 1)
  assert.equal(notGenerated.out, '')
  assert.match(notGenerated.err, /不是生成的骨架/)
})

test('deploy init --write：已有手写文件（缺标记）→ 退 1 拒绝覆盖，文件不动', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  mkdirSync(join(root, '.github', 'workflows'), { recursive: true })
  const file = workflowPath(root)
  const handWritten = 'name: 手写的\non: push\n'
  writeFileSync(file, handWritten, 'utf8')

  const result = init(root, ['--write'])
  assert.equal(result.code, 1)
  assert.equal(result.out, '')
  assert.match(result.err, /不是生成的骨架.*拒绝覆盖/)
  assert.equal(readFileSync(file, 'utf8'), handWritten, '拒绝时不动磁盘')
})

test('deploy：缺 --root / 未知动作 / 未知选项 / 缺 deploy 段 / 缺 build.json → 退 2', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  const noRoot = run(['deploy', 'init'])
  assert.equal(noRoot.code, 2)
  assert.match(noRoot.err, /缺少必填参数 --root/)

  const noAction = run(['deploy'])
  assert.equal(noAction.code, 2)
  assert.match(noAction.err, /用法: dsh-pipeline deploy/)

  const unknownAction = run(['deploy', 'frobnicate', '--root', root])
  assert.equal(unknownAction.code, 2)
  assert.match(unknownAction.err, /未知动作: frobnicate/)

  // check 不接受 --write：严格解析，不静默忽略
  const writeOnCheck = run(['deploy', 'check', '--root', root, '--write'])
  assert.equal(writeOnCheck.code, 2)
  assert.match(writeOnCheck.err, /未知选项: --write/)

  const bareRoot = tmp()
  t.after(() => rmSync(bareRoot, { recursive: true, force: true }))
  writeConfig(bareRoot, undefined)
  const noDeploy = init(bareRoot)
  assert.equal(noDeploy.code, 2)
  assert.match(noDeploy.err, /配置缺少 deploy 段/)

  // 源码运行没有 build.json：拒绝生成假 pin
  const noBuild = run(['deploy', 'init', '--root', root], { buildInfo: null })
  assert.equal(noBuild.code, 2)
  assert.match(noBuild.err, /没有 build.json/)
})

// 回归（issue #64）：pack.sh 先在包根写 build.json 再跑 node --test，此时注入的 null 会被
// isPlainObject 判成「没注入」→ 回退读到真的 build.json → 上面那条用例绿成退出码 0，门禁整段红。
// 断言用意：显式注入 null 表示「这里没有 build.json」，这个语义必须原样生效，不被真实文件顶掉。
test('deploy：包根存在 build.json 时，注入 buildInfo:null 仍退 2（不回退读真实文件）', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeConfig(root, BASE_DEPLOY)

  // 造一个包根 build.json 复刻打包期间的现场：只在原本没有时才造（打包期间那个是 pack.sh 的
  // 产物，不能碰），且由本用例自己删掉，不留残留；文件在 .gitignore 里，不会弄脏 git status。
  const repoBuild = join(REPO_ROOT, 'build.json')
  const created = !existsSync(repoBuild)
  if (created) {
    writeFileSync(
      repoBuild,
      JSON.stringify({ gitSha: GIT_SHA, builtAt: '2026-11-06T00:00:00Z', dirty: false }),
      'utf8',
    )
    t.after(() => rmSync(repoBuild, { force: true }))
  }

  const result = run(['deploy', 'init', '--root', root], { buildInfo: null })
  assert.equal(result.code, 2, '显式注入 null 必须拒绝，不能读到包根 build.json 而退出码 0')
  assert.match(result.err, /没有 build.json/)
})

test('deploy：配置字段不合规（未知键等）→ 退 2，不落盘', (t) => {
  const root = tmp()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, '.dsh'), { recursive: true })
  writeFileSync(
    join(root, '.dsh', 'pipeline.json'),
    JSON.stringify({ deploy: { ...BASE_DEPLOY, bogus: 1 } }),
    'utf8',
  )

  const result = init(root, ['--write'])
  assert.equal(result.code, 2)
  assert.match(result.err, /deploy 未知字段: bogus/)
  assert.ok(!existsSync(workflowPath(root)))
})
