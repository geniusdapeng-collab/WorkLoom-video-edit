# 剪辑转场：方案调研、引擎落地与机检口径（T-2026-1011-0003）

> 结论先行：**默认引擎选 FFmpeg `xfade`（内置，零新依赖），并把"剪辑脚本声明的转场"真正渲染出来**。
> GLSL 着色器集合（gl-transitions）与 ffmpeg-gl-transition 因"需要自编译 FFmpeg / 原生 GL 渲染器"未纳入本次，
> 保留为可选升级路径（见 §3）。本轮同时把"黑屏过渡"从主观抱怨变成可回读的数字（见 §6）。
>
> 适用范围：`workloom-ai/WorkLoom-video-edit` 的 AI 剪辑生产线（`pnpm edit:post` + `bundles/ai-video/connectors/post-bridge`）。
> 证据口径：本机 `ffmpeg 6.0`（2026-10-11 实测）＋ FFmpeg master 源码 `libavfilter/vf_xfade.c` 与 `doc/filters.texi`；
> 开源项目的 star/许可/维护时间来自 GitHub API 只读查询（查询日期 2026-10-11）。

## 1. 问题与目标

现状（T-2026-1010-0008 口径）：

- 剪辑时间轴契约 `bundles/video-edit/schemas/edit-timeline.schema.json#transitionIn` 早就支持声明
  `dissolve / fade_from_black / fade_to_black / wipe / match_cut / jump_cut / whip_pan / zoom_blur`，
  **但后期执行器从不消费它**——默认全片硬切；
- 唯一"软"路径是 legacy `fade`：逐段淡入淡出，镜头之间经黑场。客户实测观感是"黑屏停顿"，即本轮要修掉的问题；
- 原 `xfade` 路径只有一种转场（`transition=fade`），且整条时间轴一种参数，无法逐刀设计。

目标（按优先级）：

1. 让剪辑脚本里的转场声明**真的上屏**（逐刀可控：类型、时长、方向、缓动）；
2. 默认仍是硬切（产品所有者 2026-10-10 口径：叙事剪辑默认硬切），转场必须"按需显式或用 auto 才会出现"；
3. 同一份剪辑脚本，不同风格变体输出**不同转场观感**（与调色/配乐/封面同为风格轴）；
4. 每一刀转场都有回执与机检：**黑屏、缺转场窗口、时长不符**是事实类硬失败；
5. 不引入新的原生依赖，不破坏 `pnpm install` / CI / 4K 本地渲染。

## 2. 关键事实（先搜后答）

| 事实 | 证据（2026-10-11 实测/查证） |
|---|---|
| FFmpeg 6.0 的 `xfade` 有 **46 种命名转场 + custom 表达式** | 本机 `ffmpeg -hide_banner -h filter=xfade`（transition from -1 to 45） |
| FFmpeg master（7.x/8.x 线）扩到 **59 种命名转场**（新增 wind/cover/reveal 家族 12 种 + custom） | `FFmpeg/FFmpeg` `libavfilter/vf_xfade.c` 的 transition 选项表 |
| custom 表达式可用变量：`X Y W H P PLANE A B`（`P`=进度，`A/B`=两路输入当前像素） | `FFmpeg/FFmpeg` `doc/filters.texi` xfade 段（master） |
| `fade` 是线性交叉溶解；`dissolve` 是噪声阈值溶解；`zoomin` 自带 `smoothstep(0.5,1,P)` 缓动 | `n6.0:libavfilter/vf_xfade.c` 的 `FADE_TRANSITION` / `DISSOLVE_TRANSITION` / `ZOOMIN_TRANSITION` 宏 |
| `fadeblack` 是**两段式冲黑再出**（不是全黑帧），`fade_from/to_black` 只适合章节跳变 | 同上 `FADEBLACK_TRANSITION` 宏（phase=0.2） |
| gl-transitions：2149★，最近推送 2026-10-10 | GitHub API `gl-transitions/gl-transitions` |
| ffmpeg-gl-transition（滤镜补丁）：720★，最后推送 2024-07-23，**仓库无 LICENSE 声明** | GitHub API `transitive-bullshit/ffmpeg-gl-transition`；GitHub 搜索 API（同名 fork 多为个人镜像） |
| editly：5522★，MIT，依赖 `gl@8`（headless-gl 原生模块）+ `gl-transitions`，逐帧渲染 | GitHub API `mifi/editly` + `package.json`（raw） |

## 3. 候选方案对比与结论

| 方案 | 能力面 | 落地成本 | 风险 | 结论 |
|---|---|---|---|---|
| **FFmpeg `xfade`（内置）** | 46 种（6.0）/59 种（7.x）+ custom 表达式；纯 CPU；4K 可跑 | 0 新依赖；本轮新增计划层 + 回执 | 6.0 无 wind/cover/reveal 家族（版本闸明确拒绝） | **采纳为默认引擎** |
| gl-transitions（GLSL 着色器集合） | 100+ 着色器，观感最"潮" | 需要 GL 渲染器（浏览器 WebGL 或 headless-gl）；逐帧渲染慢；4K 成本高 | 新增原生/浏览器依赖会破坏 `pnpm install --frozen-lockfile` 与 CNB CI 的可复现性 | 未采纳；记录为可选升级路径 |
| ffmpeg-gl-transition（给 FFmpeg 加 `gltransition` 滤镜） | 与 gl-transitions 全量对接 | 必须**自编译 FFmpeg**（或依赖第三方预编译产物） | 维护停滞（2024-07 最后推送）、无许可声明、供应链不可控（≥1 个预编译仓仅 1★） | 未采纳；需单独供应链评审 |
| editly（MIT，声明式剪辑） | 声明式 + GLSL 转场 | 引入 `gl`/`canvas` 原生模块 + 逐帧渲染 | 与既有 post-bridge 装配/调色/音频链路重复；CI 安装风险 | 未采纳（只借鉴其"转场是变体轴"的产品口径） |
| MLT / Kdenlive luma 擦除 | 数百种 luma 划像 | 引入 MLT C 框架 + luma 资产 | luma 资产多为 GPL，与 Apache-2.0 仓许可不兼容；4K 性能未验证 | 未采纳 |
| Remotion `@remotion/transitions` | React 时间轴 + 富转场 | 需要 Chromium 渲染环境 | 与"本地 ffmpeg 管线"架构不符；CI 需装浏览器 | 未采纳 |

**决策**：默认引擎 = FFmpeg `xfade`；把"编辑意图 → 引擎转场"的映射做成**受签名资产**（`bundles/ai-video/library/transitions/catalog.json`），
这样未来若要接 GL 引擎，只需新增一个引擎适配层与 intentMap，不改剪辑契约与回执结构。

> 为什么不"顺手接 gl-transitions"：本仓当前的交付纪律要求"自证可运行 + CI 可复现 + 4K 本地渲染可跑"。
> GLSL 路线要么改 CI/安装链（原生模块/浏览器），要么依赖无许可声明的预编译 FFmpeg——两者都会把不可控风险带进主交付路径。
> 需要"炫技转场"的单片，可在**隔离的实验分支**用 `ffmpeg-gl-transition` 预编译产物跑，不进主链（仓库不随包分发该二进制）。

## 4. 引擎能力与边界

- **目录**：`bundles/ai-video/library/transitions/catalog.json`（含 `engine` / `intents` / `packs` / `transitions` / `durationPolicy` / `receiptPolicy`）；
  已纳入 `bundles/ai-video/bundle.json#integrity.assets`（行业包签名覆盖）。
- **编辑意图**（时间轴契约，9 种）：`cut`、`dissolve`、`fade_from_black`、`fade_to_black`、`wipe`、`match_cut`、`jump_cut`、`whip_pan`、`zoom_blur`。
- **意图默认映射**：`dissolve→fade`、`wipe→wipeleft`（方向可换）、`whip_pan→smoothleft`（方向可换）、`zoom_blur→zoomin`、
  `fade_from/to_black→fadeblack`；`cut / match_cut / jump_cut` 保持**真硬切**（编辑技法要求帧精确）。
- **时长策略**：上限 2s（与契约一致）、下限 max(0.15s, 2 帧)、且不超过相邻较短镜头的 **1/3**；不满足即**降级硬切并记录原因**。
- **版本闸**：`since=7.0` 的转场（wind/cover/reveal）在 FFmpeg 6.x 上会明确拒绝并给出版本要求，不静默换类型。
- **缓动**：`--transitions-easing smooth` 仅对 `fade` 生效（custom 表达式 `A*(1-ease)+B*ease`，`ease=P²(3-2P)`）；
  其余转场回退 native 并给出提示（FFmpeg 的 `fadeslow/fadefast/zoomin` 本身自带曲线，优先用它们）。
- **音频**：转场窗口用 `acrossfade`（tri/tri）；硬切处走既有**样点级对齐**拼接（`av-sync.mjs`），不做音频淡入淡出。
- **真硬切**：按转场切点把时间轴拆成 run，run 内 xfade、run 之间样点级 concat——**不会**用"1 帧 xfade"假装硬切。

## 5. 怎么用

### 5.1 CLI（`pnpm edit:post`）

```bash
# 默认：全片硬切（产品口径不变）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1

# 推荐：脚本声明的转场照渲染；未声明处，场景组切换自动补（组内保持硬切）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1 --transitions auto

# 只用脚本声明，其余硬切
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1 --transitions declared

# 缓动叠化（custom 表达式；4K 成本约 7 倍，按需）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1 --transitions auto --transitions-easing smooth

# 节奏档案（auto 模式下场景切换用哪种意图）：documentary / vlog / fast_cut / information
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1 --transitions auto --transition-pack vlog

# legacy：整段沿用变体配方（warm-story=fade 经黑场 / clean-tech=hard / bold-promo=xfade）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/delivery-v1 --transitions pack
```

### 5.2 时间轴（剪辑脚本侧）

```json
{
  "seq": 1, "segmentId": "S2", "groupId": "场景1",
  "sourceId": "src-2", "sourceIn": 0, "sourceOut": 3, "durationSeconds": 3,
  "transitionIn": {
    "type": "whip_pan",
    "durationSeconds": 0.3,
    "params": { "direction": "right" }
  }
}
```

`params` 支持：`direction`（left/right/up/down，wipe 与 whip_pan 有效）、`xfade`（**点名**具体引擎转场，例如 `hlslice`，
此时变体 intentMap 不得覆盖——计划回执里 `resolvedBy=plan-explicit`）、`easing`（native/smooth）。

### 5.3 变体风格（intentMap）

`bundles/ai-video/library/style-variants/*.json#transitions.intentMap` 决定"同一意图在不同变体里的观感"：

| 变体 | dissolve | wipe | whip_pan | zoom_blur |
|---|---|---|---|---|
| warm-story | `fadeslow` 0.65s | `smoothleft` 0.55s | `smoothright` 0.35s | `zoomin` 0.4s |
| clean-tech | `fade` 0.35s | `wipeleft` 0.3s | `smoothleft` 0.28s | `zoomin` 0.3s |
| bold-promo | `dissolve` 0.22s | `hlslice` 0.25s | `smoothleft` 0.22s | `zoomin` 0.25s |
| segmented-story | 继承 warm-story 的 intentMap | | | |

同一份剪辑脚本 + `--transitions auto`，四路输出的转场类型互不相同（实测见 §7）。

## 6. 回执与机检（无回执不算完成）

产物：

- 每次装配：`<assembly>.transition-receipt.json`（母版与每个变体各一份，落在 `work/` 或 `work/assemble/`）；
- 交付面汇总：`transitions/transition-receipt.json`（`workloom.transition-summary/v1`），并写进 `delivery-manifest.json#transitions`。

回执字段：`cuts[]`（逐刀：意图 / 引擎类型 / 时长 / 缓动 / 解析来源 / 起止时间）、`hardCutCount`、
`expectedDurationSeconds` 与 `actualDurationSeconds`、`checks[]`、`evidence[]`（逐刀窗口测量）、`notes[]`。

机检口径（硬闸只允许事实类）：

| 检查 | 级别 | 判据 |
|---|---|---|
| `transition_window_present` | 硬 | 转场窗口内可采样帧数 ≥ 2（证明存在真实重叠窗口，而不是一帧幽灵过渡） |
| `transition_no_black_screen` | 硬 | **转场引入的黑帧**为 0：窗口内有黑帧、窗口外邻域（±0.6s）却没有 → 判黑屏缺陷；素材本身黑场（邻域同样有黑帧）与黑场类转场（fadeblack/fadewhite/fadegrays）豁免 |
| `transition_duration_matches_plan` | 硬 | 成片实测时长与计划（Σ镜头 − Σ转场重叠）相差 ≤0.4s |
| `transition_change_spread` | 咨询 | 帧间差集中度 ≤0.85 表示变化分摊在多帧（像渐变）；≥0.85 更像单帧跳变（只记录，不否决） |

复现黑屏判定的最小命令（把 `<输出>`、`<起>`、`<止>` 换成回执里的值）：

```bash
ffmpeg -hide_banner -v info -ss <起-0.6> -to <止+0.6> -i <输出> \
  -vf "blackframe=amount=98:threshold=32,tblend=difference,signalstats,metadata=print:file=-" \
  -an -f null - 2>&1 | grep -E 'pblack|YAVG'
```

## 7. 实测（2026-10-11，本机 ffmpeg 6.0，Apple Silicon）

**单刀性能**（1920×1080 双 3s 素材 → 5.5s 成片）：

| 转场 | 耗时 |
|---|---|
| `fade` 0.5s | 3.52s |
| `dissolve` 0.5s | 3.72s |
| `fadeslow` 0.5s | 3.02s |
| `zoomin` 0.4s | 3.13s |
| `custom`（缓动叠化）0.5s | 5.25s（≈+70%） |
| `fade` 0.5s（3840×2160） | 4.16s |
| `custom`（缓动叠化）0.5s（3840×2160） | 28.73s（≈7×） |

**黑屏过渡取证**（同一批 3 段素材，2.5s/段）：

| 口径 | 第 1 刀窗口内黑帧 | 窗口外邻域黑帧 | 结论 |
|---|---|---|---|
| legacy `fade`（0.6s 逐段淡入淡出） | **3** | 0 | 黑屏是**转场引入**的（客户反馈成立） |
| 新 `xfade`（逐切计划） | 0 | 0 | 无黑帧 |

**全链路**（`pnpm edit:post --transitions auto`，4 段素材 / 3 刀声明转场 / 3 变体）：

```
master      : fade       + smoothright + zoomin   3 刀 / 硬切 0 处
warm-story  : fadeslow   + smoothright + zoomin   3 刀 / 硬切 0 处
clean-tech  : fade       + smoothleft  + zoomin   3 刀 / 硬切 0 处
bold-promo  : dissolve   + smoothleft  + zoomin   3 刀 / 硬切 0 处
delivery-manifest.json#checks：12/12 全过（含新增 transition_receipts）
```

## 8. 不解决什么（边界）

- **不追求 GLSL 级炫技转场**：glitch/粒子/液态等效果不在本轮；要单片使用请走实验分支，不进主链。
- **不做自动审美评分**：转场"好不好看"不进硬闸；硬闸只判事实（黑屏/窗口/时长）。
- **不自动生成转场设计**：auto 只按"场景组切换 + 节奏档案"补默认意图；更细腻的逐刀设计仍要剪辑脚本声明。
- **不改 `edit:assemble` 粗剪**：粗剪仍是硬拼预览；转场在 `edit:post` 正式后期执行（口径：粗剪快、后期准）。
- **未在 CI 覆盖 7.0+ 转场**：CNB 运行的是 6.0 基线；7.0 家族已进目录并做版本闸，待运行时升级后自动可用。

## 9. 回滚

```bash
git revert <本任务合并提交>     # 计划层/引擎/回执/文档一起回滚
```

- 回滚后：`--transitions` 只认 `hard/pack`（旧行为），`transitionIn` 重新变成"只校验不渲染"；
- 运行时零残留：不新增依赖、不生成新的常驻进程；`transitions/` 与回执文件随交付目录，不写入系统路径；
- 变体配方里的 `intentMap` 字段在旧代码下会被忽略（旧 `transitions.mode/fadeSec` 保留未动），不会导致旧版本报错。

## 10. 文件地图

| 文件 | 角色 |
|---|---|
| `bundles/ai-video/library/transitions/catalog.json` | 转场目录与意图映射（受签名资产） |
| `packages/video-studio/src/edit/transitions.ts` | 转场计划纯函数（意图/时长/缓动/安全降级） |
| `packages/video-studio/src/edit/transitions.test.ts` | 计划层断言 + 与目录的一致性交叉校验 |
| `bundles/ai-video/connectors/post-bridge/core.mjs` | 引擎：逐切解析、run 渲染、真硬切拼接、回执与机检 |
| `bundles/ai-video/connectors/post-bridge/delivery-integration.test.ts` | 真实 ffmpeg 集成断言（含黑屏取证） |
| `scripts/tools/edit-post.mts` | CLI：`--transitions / --transitions-easing / --transition-pack` |
| `bundles/ai-video/library/style-variants/*.json` | 变体 intentMap（同一脚本 → 不同转场观感） |
