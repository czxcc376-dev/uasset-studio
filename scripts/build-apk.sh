#!/usr/bin/env bash
# build-apk.sh — 把 web/ 打进 Android APK（本地或 CI 均可）
#
# 用法：
#   bash scripts/build-apk.sh            # debug 签名
#   bash scripts/build-apk.sh release    # 需 KEYSTORE_PATH 等环境变量
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODE="${1:-debug}"

echo "==> 1/4 构建 Web 资源"
node "$ROOT/scripts/build-web.mjs"

echo "==> 2/4 同步 web/ → android assets"
ASSETS="$ROOT/android/app/src/main/assets"
rm -rf "$ASSETS"
mkdir -p "$ASSETS"
cp -r "$ROOT/web/." "$ASSETS/"
# 只保留运行时需要的文件，去掉构建中间产物
rm -f "$ASSETS"/*.map
echo "    已复制 $(find "$ASSETS" -type f | wc -l) 个文件，共 $(du -sh "$ASSETS" | cut -f1)"

echo "==> 3/4 检查 Android SDK / Gradle"
if [ ! -d "$ROOT/android" ]; then
  echo "缺少 android/ 目录" >&2
  exit 1
fi
if command -v gradle >/dev/null 2>&1; then
  GRADLE=gradle
elif [ -x "$ROOT/android/gradlew" ]; then
  GRADLE="$ROOT/android/gradlew"
else
  echo "未找到 gradle。CI 里请先 actions/setup-java + gradle/actions/setup-gradle；" >&2
  echo "本地请安装 gradle 或在 android/ 下执行 gradle wrapper。" >&2
  exit 1
fi

echo "==> 4/4 编译 APK（$MODE）"
cd "$ROOT/android"
if [ "$MODE" = "release" ]; then
  "$GRADLE" :app:assembleRelease --no-daemon --stacktrace
  APK=$(find app/build/outputs/apk/release -name '*.apk' | head -1)
else
  "$GRADLE" :app:assembleDebug --no-daemon --stacktrace
  APK=$(find app/build/outputs/apk/debug -name '*.apk' | head -1)
fi

if [ -z "${APK:-}" ] || [ ! -f "$APK" ]; then
  echo "构建未产出 APK" >&2
  exit 1
fi

OUT="$ROOT/dist"
mkdir -p "$OUT"
cp "$APK" "$OUT/uasset-studio-$MODE.apk"
echo
echo "APK: $OUT/uasset-studio-$MODE.apk ($(du -h "$OUT/uasset-studio-$MODE.apk" | cut -f1))"
