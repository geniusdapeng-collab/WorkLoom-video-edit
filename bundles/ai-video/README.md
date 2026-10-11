# ai-video 行业包 · 给 AI Agent 的安装与执行说明（runbook）

> 读者：被派来做视频的 AI Coding Agent（或交付同学）。
> 目的：**别跳步**。真机事故（2026-09-30 真人出镜片）的根因就是"直接跑出片命令、
> 没先判视频类型、也没让分镜卡过字段规范闸"。

> **任何视频制作、返修或交付先读** [`AI 工作台视频调用指南`](../../docs/ai-video-workbench-guide.md)，
> 或 `node scripts/workloom-agent.mjs invoke growth.video.workbench.guide`；MCP 对应
> `workloom_growth_video_workbench_guide`，参数 `{}`。先冻结指定人、商品、平台、时长、账号调性、声音和特殊要求。
> 本仓没有 Growthtest 的 standard-post/nativeaudio 专用契约；普通全链默认保留原节目声音，不隐式 ASR/TTS；新声音只有明确请求才生成，不能静默替代原生声音或指定声线。
>
> **要把本仓能力接进桌面客户端（Codex / DeepSeek Harness）**：见 [`docs/AGENT-CLIENTS.md`](../../docs/AGENT-CLIENTS.md)
> —— 里面有 5 分钟接入（`list`/`invoke`/MCP 冒烟）、MCP 配置片段、**视频能力清单**（以 `list` / `tools/list` 为准，含固定指南读取）
> 与安全边界。本文（runbook）负责"怎么出片"，那份文档负责"怎么被 Agent 调起来"。

---

## 0. 先核对成功原片；仅新生成先判断视频类型

已有供应商成功记录和实际源片时，先核对项目/镜号、任务来源、当前 SHA256 与授权；历史品质拒绝只读，追加独立接受回执并走本仓正式后期。没有新的生成需求时不运行分流模型、不要求新的 provider key、不重新验证旧镜头卡/定妆照。

**待新生成镜头**才先跑分流：

```bash
pnpm exec tsx scripts/tools/route-video.mts --title "<用户需求原文>" --llm --out work/route.json
```

它会给出 `marketing`（营销片，含商品情报档案与 G1 门）/ `narrative`（通用叙事片）/
`explainer`（口播解说片）/ `clarify`（**判不准 → 先问用户，不要替用户花钱**），
并打印对应的**建议命令**与意图清理后的文本。

> **出片入口的硬约束（T-2026-0930-0015）**：`full-chain-film.mts` 在待新生成路径**要求分流结论**——
> 要么 `--route work/route.json`（上面这条命令的 `--out` 产物），要么对已确认过的补跑项目显式
> `--route-kind marketing|narrative`。两者都没有会直接 `ROUTE_PREFLIGHT_ROUTE_REQUIRED` 拒绝出片；
> 判不准（`clarify`）时也会拒绝并提示"先问用户"。待新生成营销镜头缺商品锚点同样 fail-closed；已成功原片不因旧商品/卡片元数据被重新生成。

- 判据与口径：`packages/video-studio/src/pipeline-router.ts`；设计说明：`docs/video-pipeline-routing-and-dossier-2026-09-25.md`
- **营销片必需商品锚点**（商品名只能来自用户显式声明 / metadata / 模型抽取，**不许猜**）；
  商品档案放在 `bundles/ai-video/library/products/<档案>/`，G-PROD1 会逐镜校验真实商品绑定。
- 服务端派活（`apps/server/src/video/router.ts`）走的是同一条分流；CLI 侧以前没有入口，
  所以本补充了 `route-video.mts`。

## 1. 安装与环境（一次）

```bash
node -v            # >= 24
pnpm install
pnpm exec tsx scripts/tools/video-doctor.mts   # 出片环境自检（缺什么一目了然）
```

`video-doctor` 会检查：Node/pnpm、ffmpeg/ffprobe（含 `~/.workloom-color/bin` 与 `WL_FFMPEG`）、
火山方舟与评审模型密钥、配音工位、**配乐曲库与路径监狱**、真人/商品/片型/封面知识库、入口与 runbook 是否齐备。
`--json` 输出给 Agent 解析；存在 FAIL 时退出码 1。

工位与密钥（**不要写进仓库/日志/提交**）：

| 依赖 | 位置 / 变量 | 说明 |
|---|---|---|
| 视频/图片生成（火山方舟） | `~/.workloom/live.env`：`VOLCENGINE_ARK_API_KEY`、`SEEDANCE_MODEL`、`SEEDREAM_MODEL` | 仅新生成出片/出图必需；**欠费时提交会被 403 `AccountOverdueError` 拒绝**（先充值再跑，别反复提交） |
| 评审/仲裁模型 | `DEEPSEEK_API_KEY`（同文件） | 仅明确新前期的模型调用/分流需要；成功原片后期不调用模型品质评审 |
| 调色/字幕/配乐工位 | `bundles/ai-video/connectors/{color,subtitle,bgm}-bridge` | 纯本地；ffmpeg 走 `~/.workloom-color/bin`（管线的 `WL_FFMPEG/WL_FFPROBE`） |
| 配音/人声核查 | `~/.workloom/voice-station`（本地 MLX 引擎，**不联网不花钱**） | `voice-bridge health` 可自检；音色档默认 `zh-xiaozhi` |
| 真人素材 | 火山方舟"私域真人人像库"的 `asset://...` | 参考图只能以 `asset://` 提交（平台禁止直传真人照片） |

自检：`bash scripts/agent-tour.sh`（能力巡游）、`pnpm exec tsx scripts/tools/route-video.mts --title test`。

## 2. 三条管线与它们的执行器

| 类型 | 执行器 | 特点 |
|---|---|---|
| 营销片 | `scripts/tools/full-chain-film.mts`（+ 商品情报档案/G1 门） | 卖货/种草/投放；需要商品锚点；逐镜生成 + 完整后期 |
| 叙事片（通用） | 同上（不需要商品情报层） | 故事/形象片；分镜卡仍须过 25 字段规范（`spec` 阶段） |
| 口播解说片 | `pnpm explainer:run -- --script <稿> --profile <音色>` | 图文成片，不跑逐镜生成 |
| 手绘白板 | `scripts/tools/whiteboard-film.mts --script <稿>` | 本地白板引擎 |

`full-chain-film.mts` 阶段顺序（**按需裁剪，但别跳"规范类"阶段**）：

```
cine-kb → continuity → micromotion → spec（25 字段交付闸）→ plates → material-gen → videos
        → voice（默认保留原声；新配音仅显式请求）→ compose → color → subtitle → bgm → cover → mux → master → deliver
```

> **成功原片只走实际请求后期**：不自动补 `spec`，不重新做旧身份/服装/动作/画质/嘴型/台词/声音品质评审。来源核验通过后直接采用原字节；默认保留完整节目声音。部分镜头已成功时，前期规范和素材检查只作用于待新生成镜头，已成功镜不重新打开。

## 3. 默认成功原片接受与明确后期请求

1. **供应商成功就正式后期**：真实任务/项目/镜号、原输入与当前源片 SHA256、授权匹配后直接接受。身份、服装、动作、源画质、名义时长、嘴型、台词、声音品质均不阻断；不调用额外模型、ASR/TTS、抽帧评分或人工放行。`review-policy` 元数据不重新启用后期品质闸。
2. **保留真实失败**：供应商 failed、任务来源/租户/支付/授权不符、缺件、文件读取/实际工具执行失败、请求导出缺失仍明确失败。原片和历史品质失败只读，新接受/加工以新回执表示；qualityReviewed=false、qualityScore=null，不把未测写通过。
3. **前置授权与新任务保持明确**：只有未生成或用户明确授权改变的点名镜头进入当前分流/字段/素材用途/人物商品绑定/G8/支付流程。定妆照的已批准档案复用，旧成功镜不因当前属性库或组件变化再次付费。
4. **请求加工一次**：compose/color/subtitle/BGM/cover/mux/master/deliver 按实际请求各执行一次，不按品质评分候选投票、自动重试或静默降级。默认 UHD 是本地目标画布处理；显式模型增强是独立新请求。

## 4. 踩过的坑（务必遵守）

1. **post-only 组装与复用**：按实际入口提供合法组装声明与原因，成功原片来源先核对；不额外补前期 `spec` 或要求旧卡字段通过新规范。普通 resume 与 `--no-resume` 都不能重付同一成功镜。
2. **封面按明确请求本地出稿**：指定主视觉镜号、时刻与标题，人物层只有明确请求才添加；没有人物的成功片不补人物，不调用模型选帧或整图品质复审。
3. **原节目音频是默认真实来源**：省略分轨时保留原片完整节目，不需要独立分轨签发密钥。显式提供四角色分轨则必须真实有效、来源/租户/授权/签章匹配，null/false/空或非法包不能静默降成默认路径。BGM 配方一次处理，不按余量降 3dB 重试或按原声降级交付。
4. **不要手工做封面 / 手工混音绕过管线**：交付清单要能核对（`delivery-manifest.json` 里有
   `reviewPolicy` / `assembly` / 封面来源 / 各变体 sha256）。
5. **账户欠费**：`AccountOverdueError` 403 会拦住提交；**先充值**，不要连点重试。
6. **服务端固定影片工位（`--worker`）已有接线**：`video.film.start` 经 `film-worker.ts`
   启动固定入口并建立真实 IPC 父通道；CLI 从环境装载 `FullChainFilmWorker`，后续资格与调用留账由正式服务通道校验。
   不要在终端伪造 `FILM_JOB_CONTEXT` 或直接手跑 `--worker`；缺少真实父通道会被拒绝。
   当前通用 Agent CLI/MCP 菜单未暴露 `video.film.start`，不能把服务接口已实现写成桌面 MCP 已可执行。
7. **创作口径不得写成硬闸**：片型配比、运镜强弱、造型主色这类"好不好看"的问题默认只做咨询项，
   默认闸只保留实际请求加工与来源/权限事实（真实任务/当前字节/读取与工具成功/请求字幕和导出存在/授权与素材用途），不把源时长、画布、音轨品质或同步诊断阈值当默认素材接受条件。CI 会拦（`scripts/ci/verify-hard-gate-policy.mjs`）。

## 5. 交付物与验收

交付目录（`--out`）应包含：`*-<实测时长>s-final.mp4`（母版，名称与实测时长一致）、
`subtitles/`（srt/ass/vtt + 清单）、`*-softsub.mp4`、变体 3 支 + 变体封面、
`*-cover.png`、`*-delivery-manifest.json`（sha256/声明配方与品质未评审/组装声明/**分流结论**/**渲染台账**）、
`*-render-ledger.md`（每一次花钱的账：提交几次、判不合格几次、平台拒收几次、canary 止损几次、后期返工几次）。
质量口径见 `docs/video-delivery-and-revision.md`；监制门设计见 `docs/producer-gate-design.md`。

## 6. 认证真人（asset://）：定妆照/角度槽位怎么落实

### 6.0 先跟客户要一样东西：**平台侧资产清单**（通用动作，别靠人肉登记）

> 真机（2026-09-30）：主档里 10 个同组素材 ID 有 8 个在控制台**查无此素材**，而管线取
> "主素材 + 前两张"作参考图 → 多参考图**静默失效**，表现只是"像不像不稳定"，日志里查不出错。
> **任何客户、任何一次建档都按下面这条走。**

请客户提供（任选其一，能复制文本最好）：① 控制台「资产详情」列表的 **源文件名 + asset ID** 两列
（截图也可以——Agent 会把两列转成文本）；② 或直接粘贴/导出 `asset-…` 列表；③ 素材组 ID（`group-…`）；
④ 明确**哪一张是主素材**（主档 `assetId`）与**授权范围/有效期**。

```bash
pnpm video:assets list --asset <assetId>                          # 现状（含管线实取的前 3 张）
pnpm video:assets reconcile --asset <assetId> --from <清单.txt>    # dry-run：新增/删除/不变
pnpm video:assets reconcile --asset <assetId> --from <清单.txt> --primary <主素材ID> --apply
```

纪律（工具已强制）：顺序=优先级（管线取"主素材 + 前两张"，前两张必须最像本人）；
**新 ID 一律标"待客户确认"，不猜角度**；写前备份 `profile.json.bak`，写后落
`asset-list-evidence.json`（清单 sha256 + 逐条来源文件名）并自动自检（主档可装载 + 属性校验 + 打印实取参考图）。

> 抽象口径：截图/清单只是"客户输入"；对账逻辑在 `packages/video-studio/src/real-person-asset-sync.ts`
> （纯函数、无客户常量），CLI 在 `scripts/tools/real-person-assets.mts`。**不要为某个客户写死 ID。**

真人素材在本地只有主档 ID，**没有图片文件**；角色档案的角度槽位必须由"客户导出的原图"或
"以授权素材为参考的派生图"逐张落实，作为本次新前期引用来源，不用于重新评审已成功源片：

```bash
# 客户从平台导出原图后（保留原文件名即可）：
pnpm exec tsx scripts/tools/portrait-set-install.mts \
  --character <角色ID> --library <角色库目录> \
  --from "<导出目录>" --mapping <角度映射.json> \
  --source customer-export --activate --out report.json
```

工具会校验（缺必需角度/同图占多角度/越界/非图片一律拒绝）、不覆盖历史版本、
写 `portraits/v<N>/source-map.json` 来源证据、更新档案并**写后复核**（未过即 exit 2）。
映射里必填 `front / threeQuarter / closeup / side`；可选 `frontFull / threeQuarterLeft /
threeQuarterRight / smileCloseup / back / actionPose / emotionCloseup / handDetail`。
派生（充值后 img2img）用 `scripts/tools/portrait-agent.mts`，产物必须标注"派生·非权威原图"。

### 6.1 客户只给一张「资产详情页截图」时的通用流程（无需客户逐张导出）

认证素材在**客户账号**里，平台没有"导出资产内容"的接口（`/assets/*` 实测 404）。通用做法是**两件输入**：

| 客户给什么 | 用途 |
|---|---|
| 控制台「资产详情」页**截图** | 结构：分组名/分组 ID/授权说明、逐行**缩略图**（判角度）、资源原始文件名、状态 |
| 从该页**复制的 ID 列表文本**（`asset-…` 每行一个） | **权威 ID**（截图小字不可靠：大模型会幻觉、本机 Vision OCR 也会把 `6r` 读成 `гq`；由 **Agent 读图后转成文本**再喂给 CLI，程序不直接吃截图） |

```bash
# ① 清单对账（客户截图/导出/粘贴文本 → 主档 referenceAssets/portraitSet 对平；默认 dry-run）
pnpm exec tsx scripts/tools/real-person-assets.mts reconcile \
  --asset asset-xxxxxxxx --from <清单文件.txt|json> --apply --label "客户控制台资产详情页截图"

# ② 两段式出定妆照（第一段视频路出身份母版；第二段图生图出其余角度；机器像不像只留证，不触发重做）
pnpm exec tsx scripts/tools/portrait-set-from-asset.mts \
  --asset asset://asset-xxxxxxxx --character <角色ID> --library <角色库> \
  --out-dir <角色目录>/portraits/_derived --angles front,threeQuarter,closeup,side \
  --engine two-stage --stage-a-angles front --refs 2 \
  --verify-against <已验收成片帧.jpg> --install --activate   # 机器像不像只留证；独立诊断不接入成功原片正式接受

# ③ 人类看过 8 张后记录验收（机器不代替签字；人类明确否决才阻断）
pnpm exec tsx scripts/tools/portrait-agent.mts accept --character <角色ID> \
  --by "<验收人>" --note "<依据/原话，例如：这 8 张可以的，都 ok 的>"
```

> 角度映射由 **Agent 读截图缩略图**给出（标 `angleGuess`，属"机器/Agent 判读、非客户逐张确认"）；
> 平台侧权威清单只提供 ID 与文件名，**不猜角度**——两者分工不要混。

### 6.2 职责边界：两套工具是**一条流水线的两层**（以哪个为准）

> 2026-10-01 收口：§6.0/§6.1 是同一件事的前后两段，**不存在两套竞争实现**，也不是"看谁先跑"。
> 以后遇到"到底用哪个"按下面这张表走；只有一处例外需要顺序约束（见末尾）。

| 问题 | 以谁为准 | 实现位置 |
|---|---|---|
| 客户截图/清单里**哪些 asset ID 有效**、顺序、来源文件名、组 ID、证据 | **清单对账层**（§6.0） | `real-person-assets.mts` + `packages/video-studio/src/real-person-asset-sync.ts` |
| 主档 `assetId` / `referenceAssets` / `referenceAssetSources` 的写回 | **清单对账层** | 同上（`reconcile --apply`，写前备份、写后自检） |
| 每个**角度槽位**怎么来、"像不像"谁判、产物写哪 | **出图/装机层**（§6.1） | `portrait-set-from-asset.mts`（两段式出图 + 机器像不像**只留证**）→ `portrait-set-install.mts`（写档 + `verifyPortraitSet` 复核）→ `portrait-agent accept`（**人类验收放行**，机器不决策） |
| 角色档案 `portraitSets`（`files`/`artifacts`/`active`/`source-map.json`） | **出图/装机层** | 同上；本层不对 `referenceAssets` 做任何推断 |
| 管线消费 | 待新生成 G-RP1 读**主档**（对账层）；明确请求的前期关键帧读**角色档案**（装机层），成功原片后期不重开身份评审 | `scripts/tools/full-chain-film.mts` |

**唯一顺序约束**：`reconcile` 会按清单重排 `referenceAssets`，并把**同 ID 保留的 `angleGuess` 之外的新 ID 标成"待客户确认"**。
因此正确顺序是：**先 §6.0 对账（ID 对了）→ 再 §6.1 出图装机（角度对了）**；对账后发现 ID 有变化，必须重跑角度映射那一遍，
不要拿旧的 `portraitSets` 当"已确认"。两层各写各的文件（主档 vs 角色档案），所以重跑任一层都不会覆盖另一层的产物。

四条硬经验（真机实测，别再踩）：
1. **图端点不吃 `asset://`**（400 `invalid url`）——asset 参考只能走**视频端点**取首帧；
2. **参考图 2 张最好**（角度对应那张 + 主素材）；4 张不同服装/光位混投会让脸跑偏；
3. **只对"人脸是真的"负责**（客户口径 2026-10-01）：发型/发色/妆造/服装/配饰/品牌标识/背景灰调差异**不得**判不合格
   （真人本来就会变），造型只作软性偏好；主素材若是古装/生活照，也**不要**因此把造型一致性当硬闸；
4. **机器像不像只留证、不决策**（T-2026-1001-0007）：阈值 88 的逐张实测保留为证据，但**不阻断、不触发重做**；
   8 张直接交人类验收（`portrait-agent accept`，`via=owner-acceptance`），人类明确否决才可以退回；该独立工具的旧参数不得接回已成功原片的正式后期接受；
5. **追加不重来**：后续补角度用 `--archive-refs <角色目录>`，以**已发布定妆照**为参考、旧版本保留——保证客户先后发布的视频人物一致。
