/**
 * 部署 caller workflow 骨架的生成与校验（契约 §10 落地第一步）。
 *
 * 设计（已定）：
 *   - 各仓的 `.github/workflows/deploy-web.yml` 由 `deploy init` 生成，不是手写；
 *   - 生成区 = `name` / `on` / `concurrency` + 单个 job 的 `uses` + `with` + `secrets`，
 *     首尾用固定注释标记包裹；生成区之后各仓允许追加自己的 post-deploy job；
 *   - `deploy check` 只取标记之间的内容与期望值**逐字节**比对，标记之外的追加内容不参与比对；
 *   - `deploy init --write` 重生成时只替换生成区，标记之后的追加内容原样保留
 *     （标记文案本身承诺「改配置后重跑 deploy init」，重跑必须不丢追加 job）。
 *
 * `uses` pin 到当前安装包 build.json 的 gitSha（由 CLI 经 lib/build-info.mjs 读取后传入），
 * 保证「调用的复用 workflow 版本 == 装的那个包的版本」。
 *
 * 单一事实源：标记文案、文件路径、渲染与比对全在本文件；CLI 只做参数解析与输出。
 * 输出口径：面向人的信息走 stdout、错误走 stderr，全部中文；由调用方决定打印。
 */

/** 生成的 caller workflow 相对仓库根的路径（契约 §10：各仓只留一个 caller）。 */
export const DEPLOY_WORKFLOW_FILE = '.github/workflows/deploy-web.yml'

/** 复用 workflow 所在的仓库（部署实现只在本包仓，消费仓只写 caller）。 */
export const DEPLOY_WORKFLOW_REPO = 'guraul/dsh-pipeline'

/** 生成区起始标记（整行比对，逐字节）。 */
export const REGION_BEGIN = '# >>> dsh-pipeline 生成区（勿手改，改配置后重跑 deploy init）'

/** 生成区结束标记（整行比对；此行之后允许本仓追加自己的后置 job）。 */
export const REGION_END = '# <<< dsh-pipeline 生成区结束（以下可追加本仓自己的后置 job）'

export class DeployError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'DeployError'
    this.code = code
  }
}

/**
 * 补齐 deploy 段的默认值（schema 只校验，不填默认；默认值在这里收敛成一处）。
 * 可选字段缺省或 null 一律视为「未设置」。
 * @returns {{artifact: string, service: string, remoteDir: string, workDir: string,
 *   artifactDir: string|null, sshHost: string|null, qualityCmd: string|null, buildCmd: string|null,
 *   paths: string[]|null,
 *   health: {url: string, check: string, publicUrl: string|null, insecure: boolean},
 *   keepReleases: number}}
 */
export function resolveDeploy(deploy) {
  const health = deploy.health
  return {
    artifact: deploy.artifact,
    service: deploy.service,
    remoteDir: deploy.remoteDir,
    workDir: deploy.workDir,
    artifactDir: deploy.artifactDir ?? null,
    sshHost: deploy.sshHost ?? null,
    qualityCmd: deploy.qualityCmd ?? null,
    buildCmd: deploy.buildCmd ?? null,
    paths: deploy.paths ?? null,
    health: {
      url: health.url,
      check: health.check ?? 'http',
      publicUrl: health.publicUrl ?? null,
      insecure: health.insecure ?? true,
    },
    keepReleases: deploy.keepReleases ?? 5,
  }
}

/**
 * mode 由 artifact 推导：static-dir 与 node-standalone 都落 releases 布局
 * （release 内怎么启动由 systemd unit 决定，不写进 workflow）。
 * node-standalone 已放行——deploy.yml 的构建步骤参数化后（quality_cmd / build_cmd / assemble），
 * 它能生成正确调用的 caller；oci-image 仍只在 schema 层放行，生成时明确报「尚未实现」。
 * @throws {DeployError} code 2
 */
function deriveMode(artifact) {
  if (artifact === 'static-dir' || artifact === 'node-standalone') return 'releases'
  if (artifact === 'oci-image') {
    throw new DeployError(2, 'artifact=oci-image 尚未实现（本轮只支持 static-dir / node-standalone）')
  }
  throw new DeployError(2, `未知的 artifact: ${String(artifact)}`)
}

/** 字符串一律单引号包起来（路径 / URL 里 ':' '#' 等在裸标量里有歧义）；布尔与数字保持裸值。 */
function yamlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

/**
 * 渲染生成区（不含首尾标记）。
 * @param {object} deploy config.deploy（已过 schema 校验）
 * @param {string} gitSha 当前安装包 build.json 的 gitSha
 * @returns {string} 以换行分隔的 YAML 文本（末行无换行）
 * @throws {DeployError} code 2（oci-image 尚未实现、gitSha 缺失）
 */
export function renderRegion(deploy, gitSha) {
  if (typeof gitSha !== 'string' || gitSha.trim().length === 0) {
    throw new DeployError(2, '缺少 gitSha：uses 必须 pin 到当前安装包的构建标识')
  }
  const resolved = resolveDeploy(deploy)
  const mode = deriveMode(resolved.artifact)

  const lines = [
    'name: deploy-web',
    '',
    'on:',
    '  push:',
    '    branches:',
    '      - main',
  ]
  // paths 是 push 触发的路径过滤：只在配置里给了才写；没配就保持「任何 push 到 main 都部署」的现状
  if (resolved.paths !== null) {
    lines.push('    paths:')
    for (const item of resolved.paths) lines.push(`      - ${yamlString(item)}`)
  }
  lines.push(
    '  workflow_dispatch:',
    '',
    'concurrency:',
    '  group: deploy-web',
    '  cancel-in-progress: false',
    '',
    'jobs:',
    '  deploy:',
    `    uses: ${DEPLOY_WORKFLOW_REPO}/.github/workflows/deploy.yml@${gitSha}`,
    '    with:',
    `      mode: ${yamlString(mode)}`,
    // assemble 跟着 artifact 走：deploy.yml 据此决定要不要把 standalone 组装成 release 目录
    `      assemble: ${yamlString(resolved.artifact)}`,
  )
  // quality_cmd / build_cmd 紧跟 assemble：deploy.yml 的构建步骤参数，只在配置里给了才写
  // （缺省不渲染该行，deploy.yml 用自己的默认值；写空串会把默认值顶掉）
  if (resolved.qualityCmd !== null) lines.push(`      quality_cmd: ${yamlString(resolved.qualityCmd)}`)
  if (resolved.buildCmd !== null) lines.push(`      build_cmd: ${yamlString(resolved.buildCmd)}`)
  lines.push(
    `      service: ${yamlString(resolved.service)}`,
    `      remote_dir: ${yamlString(resolved.remoteDir)}`,
  )
  // work_dir 是 deploy.yml 的必填 input，schema 已保证非空，直接写
  lines.push(`      work_dir: ${yamlString(resolved.workDir)}`)
  // 其余可选项只在配置里给了才写：deploy.yml 对它们都有默认值，写空串反而会把默认值顶掉
  if (resolved.artifactDir !== null) lines.push(`      artifact_dir: ${yamlString(resolved.artifactDir)}`)
  if (resolved.sshHost !== null) lines.push(`      ssh_host: ${yamlString(resolved.sshHost)}`)
  lines.push(`      health_url: ${yamlString(resolved.health.url)}`)
  lines.push(`      health_check: ${yamlString(resolved.health.check)}`)
  if (resolved.health.publicUrl !== null) lines.push(`      public_health_url: ${yamlString(resolved.health.publicUrl)}`)
  lines.push(`      public_health_insecure: ${resolved.health.insecure}`)
  lines.push(`      keep_releases: ${resolved.keepReleases}`)
  lines.push('    secrets: inherit')
  return lines.join('\n')
}

/**
 * 完整骨架文本（标记 + 生成区 + 标记），不含结尾换行。
 * @throws {DeployError} code 2
 */
export function renderSkeleton(deploy, gitSha) {
  return `${REGION_BEGIN}\n${renderRegion(deploy, gitSha)}\n${REGION_END}`
}

/**
 * 从整份文件里取出生成区（两个标记整行之间，不含标记行）。
 * @returns {{ok: true, region: string} | {ok: false, reason: 'no-begin'|'no-end'}}
 */
export function extractRegion(content) {
  const lines = content.split('\n')
  const begin = lines.findIndex((line) => line === REGION_BEGIN)
  if (begin === -1) return { ok: false, reason: 'no-begin' }
  const end = lines.findIndex((line, index) => index > begin && line === REGION_END)
  if (end === -1) return { ok: false, reason: 'no-end' }
  return { ok: true, region: lines.slice(begin + 1, end).join('\n') }
}

/**
 * 逐字节判等（字符串相等即内容相等）后，给出第一处差异的行号与两侧整行。
 * 行序列的首个差异必然存在且与首个字节差异同位置（同一行序列 ⇒ 同一字符串）。
 * @returns {null | {line: number, expected: string, actual: string}}
 */
export function firstDifference(expected, actual) {
  if (expected === actual) return null
  const expectedLines = expected.split('\n')
  const actualLines = actual.split('\n')
  const count = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < count; index += 1) {
    const left = index < expectedLines.length ? expectedLines[index] : null
    const right = index < actualLines.length ? actualLines[index] : null
    if (left === right) continue
    return {
      line: index + 1,
      expected: left === null ? '<文件结束>' : left,
      actual: right === null ? '<文件结束>' : right,
    }
  }
  return null
}

/**
 * 把已有文件的生成区整体替换成 skeleton（标记之外的前缀与追加内容原样保留）。
 * 文件里没有成对标记时返回 null——调用方据此拒绝覆盖手写文件。
 */
export function replaceRegion(content, skeleton) {
  const lines = content.split('\n')
  const begin = lines.findIndex((line) => line === REGION_BEGIN)
  if (begin === -1) return null
  const end = lines.findIndex((line, index) => index > begin && line === REGION_END)
  if (end === -1) return null
  return [...lines.slice(0, begin), ...skeleton.split('\n'), ...lines.slice(end + 1)].join('\n')
}
