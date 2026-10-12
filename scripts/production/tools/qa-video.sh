#!/bin/bash
# qa-video —— 成片质检（规格 / 响度 / 关键帧抽帧），把可复算的读数落成一份可核对的报告。
#
# 用法：
#   bash qa-video.sh --input <成片.mp4> --out-dir <QA目录> [--times "1.0,12.6,32.5,58.0"]
#   不传 --times 时：第 1 秒 + 按片长均分 5 个点（含封面片头的成片，第 1 秒通常是封面）。
set -euo pipefail

INPUT=""; OUT_DIR=""; TIMES=""
while [ $# -gt 0 ]; do
  case "$1" in
    --input) INPUT=${2:-}; shift 2 ;;
    --out-dir) OUT_DIR=${2:-}; shift 2 ;;
    --times) TIMES=${2:-}; shift 2 ;;
    *) echo "未知参数：$1"; exit 2 ;;
  esac
done
[ -n "$INPUT" ] && [ -f "$INPUT" ] || { echo "用法：bash qa-video.sh --input <成片.mp4> --out-dir <目录> [--times a,b,c]"; exit 2; }
OUT_DIR=${OUT_DIR:-"$(dirname "$INPUT")/qa"}
mkdir -p "$OUT_DIR"

FFPROBE=${WL_FFPROBE:-ffprobe}
FFMPEG=${WL_FFMPEG:-ffmpeg}

duration=$($FFPROBE -v error -show_entries format=duration -of csv=p=0 "$INPUT")
size=$($FFPROBE -v error -select_streams v:0 -show_entries stream=width,height,r_frame_rate -of csv=p=0 "$INPUT")
audio=$($FFPROBE -v error -select_streams a:0 -show_entries stream=codec_name,sample_rate,channels -of csv=p=0 "$INPUT" || true)
{
  echo "# 成片质检"
  echo
  echo "- 文件：$INPUT"
  echo "- 时长：${duration}s"
  echo "- 画面：${size}"
  echo "- 音频：${audio:-无}"
} > "$OUT_DIR/summary.md"

echo "== 规格 =="; cat "$OUT_DIR/summary.md"

echo; echo "== 响度（integrated / true peak） =="
loudness=$($FFMPEG -hide_banner -nostats -i "$INPUT" -af ebur128=peak=true -f null - 2>&1 | grep -E "I:|Peak:" | tail -2 || true)
echo "$loudness"
printf '\n## 响度\n\n```\n%s\n```\n' "$loudness" >> "$OUT_DIR/summary.md"

if [ -z "$TIMES" ]; then
  TIMES=$(awk -v d="$duration" 'BEGIN { printf "1.0"; for (i = 1; i <= 5; i++) printf ",%.1f", d * i / 6 }')
fi
echo; echo "== 抽帧（$TIMES） =="
IFS=',' read -r -a list <<< "$TIMES"
frames=""
for t in "${list[@]}"; do
  t=$(echo "$t" | tr -d ' ')
  [ -n "$t" ] || continue
  name=$(printf "frame-%05.1f.jpg" "$t")
  $FFMPEG -y -v error -ss "$t" -i "$INPUT" -frames:v 1 -q:v 3 "$OUT_DIR/$name"
  frames="$frames\n- ${t}s → $name"
done
printf '\n## 抽帧\n%b\n' "$frames" >> "$OUT_DIR/summary.md"
echo "== 报告：$OUT_DIR/summary.md =="
