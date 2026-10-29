#!/bin/bash
# 口播成片生产线编排（参考实现）——把一条片子从精剪跑到质检。
#
# 用法：
#   RUN_DIR=... SOURCE=... TRANSCRIPT=... bash run-pipeline.sh cut|post|attention|package|qa|all
#
# 全部输入走环境变量（都有合理默认）：
#   RUN_DIR      工作目录（必需；下面所有路径默认落在它里面）
#   SOURCE       源母版（cut 必需）
#   TRANSCRIPT   校对稿 JSON（cut 必需）
#   ANALYSIS     素材解析 JSON（可选，多个用逗号分隔）
#   FILM         精剪产物目录（默认 $RUN_DIR/film）
#   DELIVERY     后期交付目录（默认 $RUN_DIR/delivery）
#   OUT          打包输出目录（默认 $RUN_DIR/out）
#   TITLE/HOOK/PLATFORM/VARIANTS/KEEP/TARGET/ASPECT/FPS/CRF
#   REFRAME_PLAN 二次构图计划（可选；给了才会跑 apply-reframe）
#   CARDS_PLAN / OVERLAY_PLAN / DANMAKU_PLAN（attention 可选）
#
# 口径（详见 README.md）：分辨率默认跟随素材原生；4K 调色给足等待窗口；
# 原生分辨率下的推近要显式声明 allow-upscale；交付命名走 edit:package。
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$REPO_ROOT"

RUN_DIR=${RUN_DIR:-}
[ -n "$RUN_DIR" ] || { echo "缺少 RUN_DIR（工作目录）"; exit 2; }
mkdir -p "$RUN_DIR"

SOURCE=${SOURCE:-}
TRANSCRIPT=${TRANSCRIPT:-}
ANALYSIS=${ANALYSIS:-}
FILM=${FILM:-"$RUN_DIR/film"}
DELIVERY=${DELIVERY:-"$RUN_DIR/delivery"}
OUT=${OUT:-"$RUN_DIR/out"}
TITLE=${TITLE:-"未命名成片"}
HOOK=${HOOK:-""}
PLATFORM=${PLATFORM:-抖音}
VARIANTS=${VARIANTS:-clean-tech,warm-story}
KEEP=${KEEP:-}
TARGET=${TARGET:-160}          # 目标时长（秒）；60 秒版传 62 左右
ASPECT=${ASPECT:-9:16}
FPS=${FPS:-30}
CRF=${CRF:-18}
REFRAME_PLAN=${REFRAME_PLAN:-}
CARDS_PLAN=${CARDS_PLAN:-}
OVERLAY_PLAN=${OVERLAY_PLAN:-}
DANMAKU_PLAN=${DANMAKU_PLAN:-}
BGM_PACK=${BGM_PACK:-"$HOME/Downloads/1200可商用纯音乐"}

log() { printf '\n== %s\n' "$*"; }

step_cut() {
  [ -n "$SOURCE" ] || { echo "cut 需要 SOURCE"; exit 2; }
  [ -n "$TRANSCRIPT" ] || { echo "cut 需要 TRANSCRIPT"; exit 2; }
  mkdir -p "$FILM"
  log "① 情绪画像"
  pnpm edit:talk-emotion -- --transcript "$TRANSCRIPT" --out "$FILM/talk.emotion.json" \
    ${ANALYSIS:+--analysis "$ANALYSIS"}
  log "② 口播精剪（选段 + 时间轴/字幕/质检）"
  pnpm edit:talk-cut -- --transcript "$TRANSCRIPT" --emotion "$FILM/talk.emotion.json" \
    --out-dir "$FILM" --source "$SOURCE" --target "$TARGET" --aspect "$ASPECT" \
    --platform "$PLATFORM" --fps "$FPS" --punch-in alternate --max-segment-seconds 8 \
    ${KEEP:+--keep-sentences "$KEEP"}
  if [ -n "$REFRAME_PLAN" ]; then
    log "③ 二次构图声明（原生分辨率下自动转 allow-upscale）"
    node scripts/production/tools/apply-reframe.mjs --timeline "$FILM/talk.timeline.json" \
      --out "$FILM/talk.reframed.timeline.json" --plan "$REFRAME_PLAN" --native
  else
    cp "$FILM/talk.timeline.json" "$FILM/talk.reframed.timeline.json"
  fi
  log "④ 字幕门禁"
  pnpm edit:subtitle -- --talk --timeline "$FILM/talk.reframed.timeline.json" \
    --caption "$FILM/talk.captions.json" --transcript "$TRANSCRIPT" \
    --out "$FILM/talk.validated.srt" --report "$FILM/subtitle-report.json" \
    ${ANALYSIS:+--analysis "$ANALYSIS"}
  log "⑤ 时间轴校验"
  pnpm edit:verify -- --timeline "$FILM/talk.reframed.timeline.json" \
    ${ANALYSIS:+--analysis "$ANALYSIS"} --report "$FILM/cut-report.json"
  if [ -n "$DANMAKU_PLAN" ]; then
    log "⑥ 弹幕计划（源时间 → 主轨时间）"
    node scripts/production/tools/make-danmaku.mjs --timeline "$FILM/talk.reframed.timeline.json" \
      --plan "$DANMAKU_PLAN" --out "$FILM/danmaku.json"
  fi
}

step_post() {
  log "⑥ 正式后期（默认跟随素材原生分辨率）"
  # 4K（uhd）在负载机上单次调色可能超过默认 30 分钟：给足等待窗口（只放宽等待，不改画质参数）
  export WORKLOOM_COLOR_GRADE_TIMEOUT_MS=${WORKLOOM_COLOR_GRADE_TIMEOUT_MS:-3600000}
  pnpm edit:post -- --timeline "$FILM/talk.reframed.timeline.json" --out-dir "$DELIVERY" \
    --subtitle "$FILM/talk.validated.srt" ${ANALYSIS:+--analysis "$ANALYSIS"} \
    --title "$TITLE" --hook "$HOOK" --platform "$PLATFORM" --fps "$FPS" --crf "$CRF" \
    --variants "$VARIANTS" --burn-subtitles \
    --reframe declared --reframe-fill cover --reframe-max-zoom budget --reframe-easing smooth \
    --bgm agent --bgm-pack "$BGM_PACK"
}

step_attention() {
  local primary=${VARIANTS%%,*}
  local base="$DELIVERY/variants/$primary/$primary.mp4"
  [ -f "$base" ] || { echo "找不到主变体：$base"; exit 2; }
  mkdir -p "$RUN_DIR/attention"
  log "⑦ 逐字卡拉OK（一屏 ≤2 行 ×12 字）"
  pnpm edit:karaoke -- --input "$base" --srt "$FILM/talk.validated.srt" \
    --timeline "$FILM/talk.reframed.timeline.json" --transcript "$TRANSCRIPT" \
    --out "$RUN_DIR/attention/karaoke.mp4" --platform "$PLATFORM"
  if [ -n "$OVERLAY_PLAN" ]; then
    log "⑧ 覆盖层（知识卡 / AI 插片 / 全屏卡）"
    pnpm edit:overlay -- --input "$RUN_DIR/attention/karaoke.mp4" --plan "$OVERLAY_PLAN" \
      --out "$RUN_DIR/attention/overlay.mp4" --evidence-dir "$RUN_DIR/attention/overlay-evidence"
  else
    cp "$RUN_DIR/attention/karaoke.mp4" "$RUN_DIR/attention/overlay.mp4"
  fi
  if [ -n "$CARDS_PLAN" ]; then
    log "（提示）知识卡渲染：pnpm edit:cards -- --plan $CARDS_PLAN --out-dir $RUN_DIR/attention/cards"
  fi
  log "⑨ 音效轨（本地合成 whoosh/impact/riser）"
  pnpm edit:sfx -- --input "$RUN_DIR/attention/overlay.mp4" --attention "$RUN_DIR/attention/attention.json" \
    --out "$RUN_DIR/attention/sfx.mp4" --evidence-dir "$RUN_DIR/attention/sfx-evidence" 2>/dev/null || {
      echo "（需要 attention 排期：先跑 pnpm edit:attention -- --timeline ... --transcript ... --out $RUN_DIR/attention/attention.json --cards <cards-plan>）"; exit 3; }
  log "⑩ 差异化封面（逐变体独立设计 + 两两 MAD 机检）"
  pnpm edit:cover -- --input "$DELIVERY/master/master-clean.mp4" --out-dir "$DELIVERY" \
    --timeline "$FILM/talk.reframed.timeline.json" --variants "$VARIANTS" --platform "$PLATFORM" \
    --theme 知识科普 --title "$TITLE" --hook "$HOOK" --burn-intro 0.6 --renderer ffmpeg
  log "⑪ 注意力体检（排期 + 覆盖回执 + 字幕）"
  pnpm edit:retention -- --attention "$RUN_DIR/attention/attention.json" \
    --overlay-receipt "$RUN_DIR/attention/overlay-evidence/overlay-receipt.json" \
    --srt "$FILM/talk.validated.srt" --out "$RUN_DIR/attention/retention.json"
}

step_package() {
  mkdir -p "$OUT"
  log "⑫ 交付命名与推荐件（edit:package）"
  pnpm edit:package -- --delivery "$DELIVERY" --title "$TITLE" --platform "$PLATFORM" --out "$OUT"
}

step_qa() {
  log "⑬ 成片质检（规格 / 响度 / 抽帧）"
  local main
  main=$(ls "$DELIVERY"/variants/*/*.burned.cover.mp4 2>/dev/null | head -1 || true)
  [ -n "$main" ] || main=$(ls "$OUT"/*.mp4 2>/dev/null | head -1)
  [ -n "$main" ] || { echo "找不到成片（先跑 post/attention 或 package）"; exit 2; }
  bash scripts/production/tools/qa-video.sh --input "$main" --out-dir "$RUN_DIR/qa"
}

case "${1:-all}" in
  cut) step_cut ;;
  post) step_post ;;
  attention) step_attention ;;
  package) step_package ;;
  qa) step_qa ;;
  all) step_cut; step_post; step_attention; step_package; step_qa ;;
  *) echo "用法：bash run-pipeline.sh cut|post|attention|package|qa|all"; exit 2 ;;
esac
echo "== 完成：$RUN_DIR"
