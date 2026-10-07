#!/usr/bin/env bash
# 字幕工位自检：引擎与滤镜 → 字体在位与摘要 → 真实造片子 → 独立诊断 → 选型 → 烧录 → 处理回读
#
#   bash selftest.sh [输出目录]      # 默认 $TMPDIR/workloom-subtitle-selftest-<时间戳>
#
# 退出码：0 处理检查通过；1 技术、许可或产物检查失败（脚本会打印失败项）。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$(cd "${HERE}/.." && pwd)"
OUT="${1:-${TMPDIR:-/tmp}/workloom-subtitle-selftest-$(date +%s)}"
mkdir -p "${OUT}"
NODE_BIN="${NODE_BIN:-node}"

export WORKLOOM_SUBTITLE_ALLOWED_ROOTS="${OUT}:${TMPDIR:-/tmp}"

echo "① 引擎自检（ffmpeg/ffprobe + libass 滤镜 + 编码器）"
"${NODE_BIN}" -e "
import('${BRIDGE}/core.mjs').then(async (core) => {
  const health = await core.health();
  console.log('  ffmpeg:', health.ffmpeg ?? '(缺失)');
  console.log('  libass:', JSON.stringify(health.renderCapabilities));
  console.log('  编码器:', health.videoEncoder ?? '(缺失)');
  if (!health.ok) { console.error('✗ 工位不可用（缺 ffmpeg 或 ass 滤镜）'); process.exit(1); }
}).catch((error) => { console.error('✗', error.message); process.exit(1); });
"

echo "② 字体在位与摘要核验（29 款）"
bash "${HERE}/install-fonts.sh" --check > /dev/null
"${NODE_BIN}" -e "
import('${BRIDGE}/core.mjs').then(async (core) => {
  const scan = core.scanFonts({ verifySha: true });
  console.log(\`  工位字体目录：\${scan.root}\`);
  console.log(\`  在位 \${scan.installed}/\${scan.total} · 摘要一致 \${scan.verified}/\${scan.total}\`);
  if (scan.verified !== scan.total) {
    console.error('✗ 字体缺失或摘要不符：', scan.missing.join('、') || '（摘要不符，见 install-fonts.sh --check）');
    process.exit(1);
  }
}).catch((error) => { console.error('✗', error.message); process.exit(1); });
"

echo "③ 端到端演示（自造素材 → 独立诊断 → 选型 → 方案 → 单次烧录 → 处理回读）"
"${NODE_BIN}" "${BRIDGE}/demo-artifacts.mjs" --out "${OUT}" > "${OUT}/demo.json"

echo "④ 指标核验"
/usr/bin/python3 - "${OUT}/report.json" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

report = json.load(open(sys.argv[1], encoding="utf-8"))
burned = report["burned"]
checks = burned["processingChecks"]
presence = burned["presence"]
timeline = burned["timeline"]
targets = {
    "时间轴回读一致": timeline["ok"],
    "字幕实际处理检查通过": bool(checks) and all(value is True for value in checks.values()),
    "未把未检查品质冒充测量": burned["qualityReviewed"] is False and burned["qualityScore"] is None
        and presence["reviewed"] is False and presence["delta"] is None and presence["ok"] is None,
    "字体解析命中工位目录": checks["font_resolved_from_fonts_dir"],
    "分辨率保持": checks["resolution_preserved"],
    "音轨保持": checks["audio_preserved"],
}
for name, ok in targets.items():
    print(f"  {'✓' if ok else '✗'} {name}")
fonts = report.get("plan", {}).get("fonts", {})
sub_name = (fonts.get("字幕") or {}).get("chosen", {}).get("name", "-")
title_name = (fonts.get("标题") or {}).get("chosen", {}).get("name", "-")
print(f"  字幕字体 {sub_name} · 标题字体 {title_name} · 可现度未检查 · 时间轴 {timeline['cues']}/{timeline['sourceCues']} 条")
for mode in ("burned", "danmaku", "sticker", "karaoke", "bilingual"):
    section = report.get(mode, {})
    checks = section.get("processingChecks", section.get("checks")) or {}
    file = Path(section.get("path", ""))
    expected = section.get("sha256")
    actual = hashlib.sha256(file.read_bytes()).hexdigest() if file.is_file() else None
    ok = bool(checks) and all(value is True for value in checks.values()) and actual == expected
    unreviewed = section.get("qualityReviewed") is False and section.get("qualityScore") is None
    measured = section.get("presence") or {}
    unreviewed = unreviewed and measured.get("reviewed") is False and measured.get("delta") is None
    print(f"  {'✓' if ok else '✗'} {mode}（{section.get('path', '') .split('/')[-1] or '缺失'}）")
    targets[f"{mode} 当前文件摘要与处理检查"] = ok
    targets[f"{mode} 未检查品质声明"] = unreviewed
best = report.get("best", {})
best_file = Path(best.get("output", {}).get("path", ""))
best_hash = hashlib.sha256(best_file.read_bytes()).hexdigest() if best_file.is_file() else None
targets["best 单次出片与真实摘要"] = best.get("verdict") == "rendered" and best_hash == best.get("sha256")
targets["best 未伪造品质分"] = best.get("qualityReviewed") is False and best.get("qualityScore") is None and best.get("winner", {}).get("score") is None
failed = [name for name, ok in targets.items() if not ok]
if failed:
    print(f"✗ 自检未通过：{', '.join(failed)}")
    sys.exit(1)
print("✓ 自检通过")
PY

echo "产物目录：${OUT}"
