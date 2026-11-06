#!/usr/bin/env bash
#
# 打包脚本（ADR-0003 决策 4 的「包自身门禁」）：
#   先跑 node --test，测试不过就 exit 1，不产出任何 tarball。
#   测试通过才 pnpm pack 到 dist/，并把产物复制一份为 dist/latest.tgz。
#
# 兼容 macOS 自带的 bash 3.2：不使用 ${VAR:-默认值}、mapfile、关联数组。
# 已存在的同名文件直接覆盖；dist/ 被 .gitignore 忽略，本脚本不做任何 git 操作。
set -euo pipefail

cd "$(dirname "$0")/.."

DIST="dist"
TEST_LOG="$(mktemp -t dsh-pack-test)"

cleanup() {
  rm -f "$TEST_LOG"
  # 构建标识只在打包期间存在，打完就删（不进仓库、不留残留）
  rm -f build.json
}
trap cleanup EXIT

version="$(node -e "process.stdout.write(JSON.parse(require('node:fs').readFileSync('package.json','utf8')).version)")"

# 构建标识：版本号常年不变，靠它区分「哪一次打包」
git_sha="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
dirty=false
if [ -n "$(git status --porcelain 2>/dev/null)" ]; then dirty=true; fi
built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
cat > build.json <<JSON
{"gitSha":"$git_sha","builtAt":"$built_at","dirty":$dirty}
JSON
echo "==> 构建标识: ${git_sha} ${built_at} dirty=${dirty}"

echo "==> 门禁: node --test"
set +e
node --test >"$TEST_LOG" 2>&1
test_status=$?
set -e
cat "$TEST_LOG"

if [ "$test_status" -ne 0 ]; then
  echo "打包中止: 测试失败（node --test 退出码 ${test_status}），未生成 tarball" >&2
  exit 1
fi

# 汇总行随 reporter 而变（spec 用 "ℹ tests 5"，tap 用 "# tests 5"），两种都认。
summary() {
  grep -E "^[^ ]* $1 [0-9][0-9]*\$" "$TEST_LOG" | tail -n 1 | awk '{print $3}'
}

tests="$(summary tests)"
pass="$(summary pass)"
fail="$(summary fail)"

if [ -z "$tests" ]; then
  tests="未知"
fi
if [ -z "$pass" ]; then
  pass="未知"
fi
if [ -z "$fail" ]; then
  fail="未知"
fi

mkdir -p "$DIST"

echo "==> 打包: pnpm pack --pack-destination ${DIST}"
pack_output="$(pnpm pack --pack-destination "$DIST")"
printf '%s\n' "$pack_output" | tail -n 1
tarball="$(printf '%s\n' "$pack_output" | tail -n 1)"

# pnpm 的输出格式可能因版本而异，取不到就回退到 dist/ 下最新的编号包。
if [ ! -f "$tarball" ]; then
  tarball=""
  for candidate in "$DIST"/*-*.tgz; do
    if [ -f "$candidate" ]; then
      tarball="$candidate"
    fi
  done
fi

if [ -z "$tarball" ] || [ ! -f "$tarball" ]; then
  echo "打包失败: 未找到 pnpm pack 产物" >&2
  exit 1
fi

cp -f "$tarball" "$DIST/latest.tgz"

# ---- 单一安装位置：解包 latest.tgz，供各消费仓 `link:` 指向 ----
sha8="$(printf '%s' "$git_sha" | cut -c1-8)"
if [ -z "$sha8" ]; then sha8="unknown"; fi
stamp="$(printf '%s' "$built_at" | tr -d ':-')"

# 1) 解包到临时目录 → 校验 → 原子改名到带时间戳的版本目录
pkg_dir="$DIST/pkg-${sha8}-${stamp}"
staging="$DIST/.staging-$$"
rm -rf "$staging"
mkdir -p "$staging"
tar_status=0
tar -xzf "$DIST/latest.tgz" -C "$staging" --strip-components=1 || tar_status=$?
if [ "$tar_status" -ne 0 ]; then
  echo "解包失败: tar 退出码 ${tar_status}" >&2
  rm -rf "$staging"
  exit 1
fi
missing=""
for f in bin/cli.mjs lib/review.mjs; do
  if [ ! -f "$staging/$f" ]; then missing="${missing} ${f}"; fi
done
if [ -n "$missing" ]; then
  echo "解包失败: 缺少${missing}" >&2
  rm -rf "$staging"
  exit 1
fi
rm -rf "$pkg_dir"
mv "$staging" "$pkg_dir"

# 2) 切换链接：先把链接指向已经完整的新目录，再清理旧目录（任何时刻目标都存在）
if [ -d "$DIST/pkg" ] && [ ! -L "$DIST/pkg" ]; then
  rm -rf "$DIST/pkg"
fi
ln -sfn "pkg-${sha8}-${stamp}" "$DIST/pkg"
if [ "$(readlink "$DIST/pkg")" != "pkg-${sha8}-${stamp}" ]; then
  echo "切换失败: dist/pkg 未指向 pkg-${sha8}-${stamp}" >&2
  exit 1
fi

# 3) 归档可回滚副本（校验通过才归档），保留最近 10 个
mkdir -p "$DIST/archive"
cp -f "$DIST/latest.tgz" "$DIST/archive/${sha8}-${stamp}.tgz"
ls -1t "$DIST"/archive/*.tgz 2>/dev/null | tail -n +11 | while IFS= read -r old; do rm -f "$old"; done || true

# 4) 版本目录只留最近 2 个，且永不删除当前链接指向的那个
kept=0
for old in $(ls -1dt "$DIST"/pkg-* 2>/dev/null); do
  if [ "$old" = "$DIST/pkg-${sha8}-${stamp}" ]; then continue; fi
  kept=$((kept + 1))
  if [ "$kept" -gt 1 ]; then rm -rf "$old"; fi
done

echo ""
echo "版本: ${version}"
echo "产物: ${tarball}"
echo "最新: ${DIST}/latest.tgz"
echo "测试: ${tests} 条，通过 ${pass}，失败 ${fail}"
echo "安装位置: ${DIST}/pkg -> pkg-${sha8}-${stamp}（各仓 tools 用 link: 指向它）"
