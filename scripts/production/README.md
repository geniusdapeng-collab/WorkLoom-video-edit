# 口播成片生产线（参考实现）

> 位置：`scripts/production/`｜适用：口播知识/生活类竖屏成片的"精剪 → 后期 → 注意力层 → 打包 → 质检"全链。
> 本目录是**编排与工具**，真正的能力都在仓库已有的执行器里（`pnpm edit:*`）；这里只做三件事：
> ① 把一条片子的完整命令顺序固化成可复跑脚本；② 补三个仓库没有的小工具；③ 把踩过的坑写成口径。

## 一、分辨率与时间口径（务必先读）

1. **输出分辨率默认跟随素材原生**：`edit:post` 不传 `--width/--height` 时自动取与目标画幅一致的最大素材档位
   （4K 竖拍 → 2160×3840 / uhd）。**不要**为了省时间随手写 `--width 1080 --height 1920`——
   显式低于原生档位会 fail closed，必须再加 `--allow-downscale`（只用于预览）并会记进交付清单。
2. **4K 的调色等待窗口**：`ffmpeg(grade)` 默认 hd 15 分钟 / uhd 30 分钟；负载机上 4K 单次调色可能超过 30 分钟，
   建议显式给足：`export WORKLOOM_COLOR_GRADE_TIMEOUT_MS=3600000`（60 分钟）。
3. **原生分辨率下的取景（推近/回拉）**：任何 `scale > 1` 的推近在 4K 输出上都是上采样，必须**逐段显式声明**
   `maxZoomPolicy: "allow-upscale"`（机检硬项 `reframe_n` 只接受"无损预算内"或"显式声明"两种）。
   `tools/apply-reframe.mjs --native` 会把计划里的推近与历史遗留的静态推近（legacy punchIn）统一转成显式声明。
4. **封面烧封与字幕流**：软字幕轨形态在 `-f concat -c copy` 拼片头时会丢字幕流；
   `edit:cover` 已内置“重挂 + 事实复核”，产物名与内容必须一致（不要在外部另写一套拼接）。
5. **交付命名与推荐件**：用 `pnpm edit:package`（中文规范名 + 推荐发布件标注），不要手写文件名清单。

## 二、目录

```
scripts/production/
  run-pipeline.sh          # 全链编排：cut / post / attention / package / qa
  tools/
    apply-reframe.mjs      # 逐段二次构图声明（含 --native：转 allow-upscale 声明）
    make-danmaku.mjs       # 弹幕计划：源素材时间 → 成片主轨时间（越界 fail closed）
    gen-cover.mjs          # 定制“炸裂封面”生成器（--scale 2 → 4K 封面；尺寸断言 + 回执）
    gen-insert.mjs         # AI 插片（Ark Seedance：提交 → 轮询 → 下载 → 回执）
    qa-video.sh            # 成片质检：规格 / 响度 / 关键帧抽帧
  plans/                   # 四个计划文件的示例（取景 / 知识卡 / 覆盖层 / 弹幕）
  production-toolkit.test.mjs  # 工具自检（语法 + 行为断言；已注册进 test:scripts）
```

## 三、快速开始（把一条片子跑完）

```bash
# 0) 准备：把源片归一化母版（SDR）与校对稿放到 RUN_DIR 里
export RUN_DIR=/path/to/run
export SOURCE=$RUN_DIR/mezzanine-sdr.mp4
export TRANSCRIPT=$RUN_DIR/talk.prod.transcript.json
export ANALYSIS=$RUN_DIR/analysis.json          # edit:probe 的产物，可省（省则少自动决策）
export TITLE="一条片子1-2块钱"
export HOOK="出去玩拍的素材，堆着等于白拍"
export PLATFORM=抖音
export VARIANTS=clean-tech,warm-story
export KEEP="s050-p2,s052,s054"                  # 选段定稿（句 id，见 talk-cut 报告）

# 1) 精剪（情绪 → 选段 → 取景声明 → 字幕门禁 → 时间轴校验）
bash scripts/production/run-pipeline.sh cut
# 2) 后期（原生分辨率；2 变体起；烧字形态；配乐 agent）
bash scripts/production/run-pipeline.sh post
# 3) 注意力层（卡拉OK → 知识卡/AI 插片 → 音效 → 差异化封面 → 体检）
bash scripts/production/run-pipeline.sh attention
# 4) 打包（edit:package 中文命名 + 推荐发布件）
bash scripts/production/run-pipeline.sh package
# 5) 质检（规格/响度/抽帧）
bash scripts/production/run-pipeline.sh qa
```

也可以 `bash scripts/production/run-pipeline.sh all` 一次跑完。

## 四、每一步的产物与口径

| 步 | 命令 | 产物 | 备注 |
|---|---|---|---|
| cut | `edit:talk-emotion` → `edit:talk-cut` → `tools/apply-reframe.mjs` → `edit:subtitle --talk` → `edit:verify` | `film/talk.timeline.json`、`talk.validated.srt`、`subtitle-report.json` | 字幕门禁与时间轴校验任一硬失败即停 |
| post | `edit:post` | `delivery/`（母版/软字幕/烧字/封面/文案/manifest） | 不传分辨率；4K 建议 `WORKLOOM_COLOR_GRADE_TIMEOUT_MS`；`--variants` 至少 2 个 |
| attention | `edit:karaoke` → `edit:overlay` → `edit:sfx` → `edit:cover` → `edit:retention` | 覆盖回执、音效回执、体检报告 | 覆盖物越界/字幕带被压是硬失败 |
| package | `edit:package` | 中文命名交付件 + 推荐发布件标注 | 与回执目录一起交付 |
| qa | `tools/qa-video.sh` | 规格/响度读数 + 抽帧图 | 建议固定抽：封面 1.0s、每张卡中点、插片中点、末卡 |

## 五、常见坑（真机踩过）

- **别显式降分辨率**：想快速预览请用 `--allow-downscale` 并知悉会被记进清单（T-2026-1011-0015）。
- **4K 调色超时**：默认 30 分钟；负载机给 60 分钟（T-2026-1011-0016）。
- **取景上采样**：原生输出下推近必然上采样，用 `--native` 显式声明，别删声明硬跑（机检会拒）。
- **封面撞车**：多变体交付必须走 `edit:cover` 的差异化硬门（两两 MAD），自定义封面（`gen-cover.mjs`）时也要保持各变体不同。
- **AI 插片**：`gen-insert.mjs` 需要 `ARK_API_KEY`；产物是 1080p 素材，用作画中画（缩放由覆盖计划决定）。
- **弹幕时间**：计划里写**源素材时间**（`sourceTime`），由 `make-danmaku.mjs` 换算成主轨时间（`at`），越界直接失败。
