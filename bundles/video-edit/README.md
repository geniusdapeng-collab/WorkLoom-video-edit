# video-edit 行业包 · 视频AI剪辑与二次创作（runbook）

> 读者：被派来做"把素材剪成片"的 AI Coding Agent 或交付同学。
> 目的：**别跳步**。剪辑管线的典型事故不是"剪得不美"，而是"没看懂素材就开始编故事"、
> "把模型自报的时间码当权威"、"素材没授权就进时间线"。

## 0. 一句话定位

本包在既有 AI 视频生产链路**之前**插入一条管线：

```
（本包）素材 → 理解 → 高光 → 重组 → 剪辑脚本 → 本地合成
                                        ↓
（复用 ai-video）后期：调色 → 字幕 → 配音 → 配乐 → 封面 → 多风格交付 → 入库 → 返修
```

即：**替换掉"视频提示词生成"与"视频渲染"两个环节**，其余后期环节与既有链路共用同一批工位与同一份交付纪律。

## 1. 与 ai-video 包的分工（不要混用口径）

| 维度 | ai-video（生成片） | video-edit（剪辑片，本包） |
|---|---|---|
| 画面来源 | 生成模型渲染（提示词 → 渲染任务） | 真实拍摄/AI 素材**原样剪进时间线** |
| 素材围栏 | G-MAT1：素材只能作生成参考，禁止静态直出 | G-ED1/G-ED2：原件只读 + 授权与用途声明 |
| 核心产物 | 镜头卡 → 提示词包 → 渲染脚本 | 镜头记录 → 高光条目 → 剪辑时间轴 |
| 花费 | 渲染是"原材料费"（贵、慢） | 剪辑是**本地算力**（免费、可重跑），只有理解与创作调用模型 |
| 时间码 | 镜头卡名义时长 | **帧级**源轨/主轨时间码 |

## 1.1 两条剪辑管线：edit-film（多素材创作）与 edit-talk（口播精剪）

| 维度 | edit-film（v3，创作优先） | edit-talk（v1，口播精剪，2026-10-11 新增） |
|---|---|---|
| 素材形态 | 多条素材/多机位/多场景 | **一条长镜头**（怼脸口播、想到哪儿说到哪儿） |
| 主要矛盾 | 选镜与重组：讲哪条故事、怎么起承转合 | **逐句留删**：这句留不留、这个停顿留多长 |
| 事实源头 | 逐镜多模态理解（shot_record） | **ASR 逐字稿**（词级时间戳 + 口语标记），字幕/决策/点睛全部引用它 |
| 第二主轴 | 高光评分（多信号加权） | **情绪与活人感**：情绪曲线 + 三类峰值 + 人味下限 |
| 字幕口径 | ≥2s 必上、字数带 2.0–2.5× | 跟着说话出字、一屏 ≤2 行 ≤24 字、逐字等于 ASR 稿 |
| 剪辑手法 | 硬切优先、匹配剪辑 | 同机位跳切必须推近遮盖（1.0↔1.12 交替） |
| 专属围栏 | G-ED0–G-ED8 | G-TK1–G-TK8（逐字一致/不伪造原话/删留台账/选段人审/粗剪锁定/人味下限/跳切遮盖/点睛不遮挡） |
| 共用部分 | 入库、信号层、本地合成、**后期交付（调色/字幕版式/配乐/封面/变体）** | 同上（完全共用） |

> 口播的产品口径（产品所有者 2026-10-11）：**追求完美会摧毁信任，人类的不完美才是人的独特魅力**。
> 所以口播管线删的是"伤理解"的东西（死停、卡壳、无信息重复），留的是"像人"的东西
> （换气、笑声、自问自答、口误自纠），并把人味做成**可算的下限**（语气词保留率 ≥0.20、停顿保留率 ≥0.15，
> 跌破必须人审显式放行）。设计与调研见 [`docs/talking-head-pipeline.md`](../../docs/talking-head-pipeline.md)。

## 2. 管线（edit-film）与十一名数字员工

| 阶段 | 员工 | 关键产物 | 围栏 |
|---|---|---|---|
| 入库 | 素材馆员 | 素材原件（指纹/规格/授权/用途） | G-ED1/G-ED2 |
| 信号解析 | 信号分析师 | 信号解析结果（切点/词级转写/节拍/指标） | G-ED0 |
| 镜头理解 | 镜头理解师 | 镜头记录（语义字段 + 证据帧） | G-ED4 |
| 高光挖掘 | 高光猎手 | 高光条目 + 三类关键帧 | G-ED4 |
| 媒资索引 | 素材馆员 | 媒资索引条目（标签/实体/复用建议） | G-ED2 |
| 创作意图 | 创意织工 | 创作意图（受众/平台/时长/情绪目标） | — |
| 方向确认 | 剪辑制片 | 人审回执 | **G-ED7** |
| 创意发散 | 创意织工 | 创意方案集（不含自评） | — |
| 叙事结构 | 叙事架构师 | 叙事方案（结构/情绪曲线/节奏图/素材映射）+ 四视角评审 | — |
| 剪辑脚本 | 剪辑指导 | 剪辑脚本 + 帧级剪辑时间轴 | G-ED3 |
| 字幕文案 | 文案字幕师 | 字幕与文案 | G-ED6 |
| 剪辑质检 | 剪辑质检师 | 剪辑质检报告 + 返修单 | G-ED3/G-ED6 |
| 粗剪锁定 | 剪辑制片 | 人审回执（锁定后改结构＝新版本） | **G-ED8** |
| 本地合成 | 剪辑合成师 | 成片（裁切/归一化/拼接/垫音） | G-ED1/G-ED3 |
| 后期交接 | 剪辑合成师 | 后期交接单（调色/字幕/配音/配乐/封面需求） | G-ED6 |
| 入库回写 | 素材馆员 | 成片入库 + 素材复用回执 | — |
| 返修 | 剪辑制片 | 层增量重合成 | — |

## 3. 数据契约（内部数据格式）

所有契约在 `schemas/` 下，均为 JSON Schema（2020-12）：

| 契约 | 文件 | 用途 |
|---|---|---|
| 素材理解结果 | `schemas/footage-analysis.schema.json` | 信号层 + 镜头层 + 高光/关键帧的统一外壳 |
| 高光条目 | `schemas/highlight-pick.schema.json` | 多信号加权、惩罚项、证据帧与用途 |
| 关键帧候选 | `schemas/keyframe-candidate.schema.json` | 情绪峰值/动作峰值/构图最优 |
| 剪辑时间轴 | `schemas/edit-timeline.schema.json` | 帧级源轨 in/out + 主轨连续 + 转场/声音/字幕 |
| 创意与叙事 | `schemas/creative-set.schema.json` | 创意候选（含差异化矩阵）与叙事方案（beat/曲线/节奏） |
| 对象与阶段枚举 | `schemas/objects.json` / `schemas/stages.json` | 事件对象与阶段机 |
| 口播逐字稿 | `schemas/talk-transcript.schema.json` | 词级时间戳 + 原样文本 + 口语标记 + 话题块（口播唯一事实源） |
| 口播情绪 | `schemas/talk-emotion.schema.json` | 句级情绪曲线 + 三类峰值 + 活人感信号（效价只用标注通道） |
| 口播剪取台账 | `schemas/talk-cut-list.schema.json` | 逐句留删决策 + 人味价值 + 人味指标 + 拆分候选 |

**三条跨契约纪律**：
1. 时间码一律帧级 `HH:MM:SS.mmm`（并带帧号）；源轨与主轨分开表达。
2. 每条语义结论带 `evidence[]` 与 `confidence`（G-ED4）。
3. 只增不改：修订走新版本（`revision`/`prevRevision`），旧版本与旧结论保留。

## 4. 本地参考实现（可先跑通再上模型）

```bash
# 1) 信号解析 + 高光 + 关键帧（只用本地 ffmpeg，不花模型钱）
pnpm edit:probe -- --input <素材.mp4> --out work/edit/<asset>.probe.json

# 2) 按时间轴合成（裁切/归一化/拼接/垫音，产出新文件）
pnpm edit:assemble -- --timeline work/edit/<film>.timeline.json --out work/edit/<film>.mp4

# 3) 契约校验（时间轴合法性/同源重叠/主轨连续性）
pnpm edit:verify -- --timeline work/edit/<film>.timeline.json
```

**口播精剪（edit-talk）最小路径**：

```bash
pnpm edit:talk-asr      -- --input <口播.mp4> --out outputs/edit/talk/<id>.transcript.json
pnpm edit:talk-emotion  -- --transcript <…>.transcript.json --out <…>.emotion.json
pnpm edit:talk-cut      -- --transcript <…>.transcript.json --emotion <…>.emotion.json --out-dir outputs/edit/talk/<filmId>
pnpm edit:talk-annotate -- --transcript <…> --cut <…>/talk-cut-list.json --timeline <…>/talk.timeline.json --out-dir <…>
# 之后照旧：edit:verify → edit:assemble → edit:subtitle --talk → edit:danmaku → edit:post
```

> 环境依赖：`WL_FFMPEG` / `WL_FFPROBE`（默认取 `~/.workloom-color/bin`，缺省回落到 PATH）。
> 缺 ffmpeg 时命令**显式失败**，不产出假成功。

## 5. 起步顺序（给 Agent 的最小路径）

1. 读 `docs/video-edit-architecture.md`（三环架构与升级理由）。
2. 读 `docs/video-edit-prompt-suite.md`（可直接投喂的提示词全文）。
3. 跑 `pnpm edit:probe` 看一份真实素材的结构化结果，确认契约符合预期。
4. 按 `pipelines/edit-film.yml` 顺序推进；每一步产物先落 `work/edit/`，再进正式账本。

## 5.1 三个"隐形素材"：画面文字 / 人声 / 环境音（v0.2.0 起为流水线必备）

这三类信息决定"地点/店铺/商品是谁""文案怎么写""声音怎么设计"，是本包 v0.2.0 起的**必备字段**：

| 字段 | 契约位置 | 主通道 | 兜底通道（无模型能力时） |
|---|---|---|---|
| 画面文字 | `probe.onScreenText[]` → `shots[].content.onScreenText` | **多模态模型**直接读关键帧（带证据帧；看不清标 `[模糊]`） | `pnpm edit:probe -- --ocr`（Apple Vision，离线；回执 `channel=fallback`） |
| 人声转写 | `probe.speech.{sentences,words}` → `shots[].content.speechText` | **多模态模型**直接听写（需模型具备音频模态；回执 `channel=model`） | `pnpm edit:probe -- --asr auto`（本机 mlx-audio 引擎，离线；`channel=fallback`） |
| 环境音 | `probe.ambience`（噪声底/动态/静音与人声覆盖）+ `shots[].audio.ambience`（语义：风噪/市集/厨房…） | 量化部分本地计算；**语义标签由多模态模型**写 | 无需兜底（本地计算始终可用） |

**质检**：`pnpm edit:verify -- --timeline <film>.timeline.json --analysis <probe.json>…` 会核对这三字段是否已采集、
通道是否如实标注；素材没有解析结果直接硬失败（不许"没看懂就剪"），字段缺采按咨询项逐条列出。

## 6. 常见坑（务必遵守）

1. **不要跳过信号层**：模型不做切点检测；时间码以信号层为权威，模型只能"建议"。
2. **不要让一个模型一口气"理解全片"**：逐镜调用，长视频必须分批。
3. **不要把生成片围栏套到剪辑片**：G-MAT1 是给"素材只作生成参考"的场景用的；剪辑片用 G-ED 系列。
4. **不要覆盖原件**：一切加工写新文件（G-ED1 阻断）。
5. **不要在没有授权与用途声明时进片**：G-ED2 fail-closed（缺字段同样阻断）。
6. **不要把审美口径写成硬闸**：硬闸只保留事实类（合法性/授权/时长/规格）。
7. **不要在无素材支撑时硬编故事**：所有画面建议必须能指回素材 id，缺料写进 gaps。
8. **口播不要照抄通用剪辑口径**：口播字幕不套字数带、同源密集跳切不套"间隔 ≥1s"（改用 `sourceGapPolicy`），
   但要守住两条：**逐字一致**（G-TK1）与**人味下限**（G-TK6）。
9. **口播不要"因为更顺"删过头**：删到语气词保留率 <0.20 / 停顿保留率 <0.15 必须人审显式放行，
   否则片子会像 AI 念稿——这是产品口径，不是审美偏好。
