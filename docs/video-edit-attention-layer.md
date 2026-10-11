# 口播知识视频 · 注意力层（attention layer）设计与实测

> 适用链路：`WorkLoom-video-edit` 口播精剪（`edit-talk`）+ 正式后期（`edit:post`）+ **注意力层（本文件）**
> 新增执行器：`edit:attention` / `edit:cards` / `edit:overlay` / `edit:karaoke` / `edit:sfx` / `edit:retention-check`
> 证据口径：本机 ffmpeg 6.0 + headless Chrome（2026-10-11 实测）；行业侧全部为 C 级二手经验，只作默认值、不作硬闸

## 1. 为什么需要这一层

口播精剪（`talk-cut`）解决的是"说哪些话、怎么剪顺"；它不解决**"观众为什么会在第 47 秒划走"**。
单一机位长镜头的注意力问题，行业里叫 pattern interrupt：

| 行业口径（C 级） | 来源 | 我们的映射 |
|---|---|---|
| 每 5–7 秒给观众一次视觉变化（punch-in / 文字层 / 信息卡 / 换角度） | The Beans《How to Edit Talking Head Videos》 | `attention-plan` 按 6s 窗口排期 + 覆盖率体检 |
| B-roll/文字层只上四种时刻：清单、数字、抽象名词、长铺垫 | QuickReel《Where to Add B-Roll》 | 知识卡只挂在这四类句子（卡片计划由内容决定） |
| 单机位可做"伪机位"：复制轨道放大 120–130% + 位移，45–60s 切一次 | Prepublish《Pattern Interrupts Without B-Roll》 | 4K 源无损预算内做景别切换（本片 1.06→1.16） |
| 重点句前**故意留白** 0.3–0.5s 比一味删停顿更有效 | Vortex Xcel《Talking Head Editing Guide》 | 由 `talk-cut` 决定留白，注意力层只在留白后 0–0.3s 摆卡片 |
| 字幕是留存工具（静音观看占多数） | Verizon Media×Publicis 2019（二手转述） | 逐字卡拉OK：关键词自己跳出来 |
| 动画"不要无节制叠加" | BigVIRALS 指南（中文，C 级） | 卡片 ≤3s、全屏卡全片 ≤1 张、弹幕 ≤6 条/分钟 |

结论：**这一层的目标不是"更花"，而是"每次走神之前给一个理由看下去"**。所以密度是咨询项、遮挡是硬项。

## 2. 契约

### 2.1 `attention-plan.json`（`workloom.video-edit/attention-plan/v1`）

```jsonc
{
  "generatedFor": { "timelineId": "…", "durationSeconds": 98.78, "platform": "抖音" },
  "options": { "targetGapSec": 6, "maxGapSec": 7, "angleEverySec": 45, "hookCardSec": 0, "maxCards": 10, "keywordPerMinute": { "min": 3, "max": 6 } },
  "keywords": [{ "text": "一两块钱", "start": 16.4, "end": 17.6, "kind": "number" }],
  "events": [{ "id": "att-001", "kind": "angle-switch", "at": 30.2, "durationSec": 0.2, "source": "angle", "detail": "…" }],
  "sfx": [{ "id": "sfx-1", "kind": "whoosh", "at": 30.08, "gainDb": -18, "reason": "景别切换（…）" }],
  "audit": { "ok": true, "hardFailures": [], "advisories": [], "metrics": { "coverageRate": 1, "maxGapSeconds": 4.42, "keywordPerMinute": 5.47, "cards": 9, "fullCards": 1, "angleSwitches": 6 } }
}
```

### 2.2 `overlay-plan.json`（覆盖层计划）

```jsonc
{ "overlays": [
  { "id": "ov-price", "kind": "knowledge-card | full-card | lower-third | pip",
    "start": 16.7, "end": 19.7,
    "asset": { "type": "png|mp4", "path": "…png" },
    "layout": { "x": 0.04, "y": 0.20, "w": 0.92, "h": 0.552 },
    "fadeSec": 0.25, "opacity": 1, "note": "价值锚点" } ] }
```

### 2.3 `cards-plan.json`（卡片计划 → PNG）

模板：`matrix`（网格逐个亮）/ `list` / `steps` / `price` / `quote`（全屏金句）/ `panel`（终端回执面板）。
`stages > 1` 时渲染 `{id}-s1…sN.png`，在覆盖层里按 1.5–2s 逐张替换，形成"逐条揭晓"。

## 3. 执行器与命令

```bash
# ① 注意力排期（事件 + 音效 + 体检）
pnpm edit:attention -- --timeline outputs/edit/talk/<id>/talk.reframed.timeline.json \
  --transcript work/prod/<id>.prod.transcript.json --cards work/prod/<id>.cards.json \
  --danmaku outputs/edit/talk/<id>/danmaku.json --out outputs/edit/talk/<id>/attention-plan.json \
  --platform 抖音 --target-gap 6 --angle-every 45 --hook-card-sec 0

# ② 知识卡（headless Chrome 渲染，零新增依赖）
pnpm edit:cards -- --plan work/prod/cards-plan.json --out-dir work/prod/cards

# ③ 逐字卡拉OK（真实词级时间，主轨↔源素材换算）
pnpm edit:karaoke -- --input <成片.mp4> --srt <talk.validated.srt> --timeline <timeline.json> \
  --transcript <校对稿.json> --out <karaoke.mp4> --platform 抖音

# ④ 覆盖渲染（知识卡 / 画中画 / 全屏字卡；声音保持原声）
pnpm edit:overlay -- --input <karaoke.mp4> --plan work/prod/overlay-plan.json --out <cards.mp4>

# ⑤ 音效轨（本地合成 whoosh/impact/riser，视频流 copy）
pnpm edit:sfx -- --input <cards.mp4> --attention <attention-plan.json> --out <sfx.mp4>

# ⑥ 体检（排期 + 覆盖回执 + 字幕 三合一）
pnpm edit:retention-check -- --attention <attention-plan.json> \
  --overlay-receipt <overlay-receipt.json> --srt <talk.validated.srt> --out <retention-report.json>
```

## 4. 机检口径（硬项 vs 咨询项）

**硬项（失败即拒绝出片）**

1. 同一时刻**两个"盖画面"的主事件**（卡片/画中画/全屏卡）重叠；
2. 覆盖物越界：出画布、压字幕带（`y+h > 0.78`）、压右侧操作栏（仅当卡片重心在下半部）；
3. 覆盖产物：时长/分辨率/音轨与输入一致；卡片区域确实发生变化（PSNR < 45）；**字幕带未被压**（PSNR ≥ 30）——
   全屏字卡（`full-card`）是声明的全屏接管，豁免本条并单独记账；
4. 字幕：超过 2 行即硬失败（口播口径一屏 ≤2 行 ×12 字）；
5. 覆盖资产缺失；覆盖时间窗超出成片时长。

**咨询项（只提示，不拦）**

1. 覆盖率 <85%、最大空窗 >7s；
2. 关键词强调 <3 或 >6 个/分钟（检测到多少 ≠ 强调多少，见 `selectEmphasisKeywords`）；
3. 卡片停留超出 1.5–3s（全屏卡 3–5s）、知识卡 >10 张、全屏卡 >1 张；
4. 前 2 秒出现非钩子事件（钩子窗口应干净）。

`selectEmphasisKeywords`：按"金额/价格 > 结论词 > 其他数字"排序 + 最小间隔 8s + 每分钟上限，被丢弃的锚点写进 `notes`（不静默丢）。

## 5. 本片实测（2026-10-11，98.78s 短版）

| 指标 | 实测 | 口径 |
|---|---|---|
| 视觉事件 | 34 个（含卡片/景别切换/关键词强调/弹幕） | 覆盖率 100%，最大空窗 4.42s |
| 强调关键词 | 9 个（检测 27 个 → 选 9 个） | 5.47 个/分钟（带上限 3–6） |
| 知识卡 | 9 张 + 全屏金句卡 1 张 | 单张 1.6–3.1s；全屏卡 3.6s（3–5s 带内） |
| 景别切换 | 6 次 | 45s 间隔口径 |
| 音效 | 22 个点位（whoosh/impact/riser，本地合成） | 峰值限制 -1dBFS，不削波 |
| 覆盖机检 | 逐条：卡片区已变化 + 字幕带未动 | 全屏卡豁免并记账 |

## 6. 边界（本层不做什么）

1. **不做矢量级动效引擎**：本轮用"PNG 阶段帧 + ffmpeg 定时替换"实现逐条揭晓；矢量动效（Motion Canvas/Revideo，均 MIT）另开任务卡；
2. **不引入未授权素材**：本轮只用自有素材帧、自绘卡片、真实回执面板；免版权库（Pexels/Pixabay 等）需要一个 API 凭证与许可回执链路，另开任务卡；
3. **不生成人像/AI 换脸**；
4. **不承诺平台播放数据**：发布后按 30s 留存/平均播放时长/完播率回测，另开复盘任务卡；
5. **不改原声**：覆盖层只盖画面，声音始终用原声（`edit:overlay -c:a copy`）。

## 7. 与既有链路的关系

```text
素材 → probe/ASR/校对稿 → talk-cut（选段+逐句留删） → edit:post（母版/调色/配乐/三形态）
                                                              ↓
                       注意力层（本文件）：edit:attention → edit:cards → edit:karaoke
                                                              → edit:overlay → edit:danmaku → edit:sfx
                                                              → edit:retention-check（体检）
                                                              ↓
                                                        封面烧封（1.6s）→ 交付
```

注意力层是**后置、可反复迭代**的一层：改卡片不动母版；改关键词不动时间轴；体检不过就不出片。
