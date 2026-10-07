# WorkLoom Growth 视频调用指南：AI 工作台先读，再执行

> guideVersion: 2026-10-07.1
> 适用仓库：`workloom-ai/WorkLoom-growth`；代码基线：`73767dc51658171e97673969780f06ca52994b7a`。
> 读者：Codex、DeepSeek Harness 及能调用本仓 CLI / stdio MCP 的 AI 工作台。

本指南把已成功视频作业的经验固化为调用纪律，帮助工作台从用户原话走到系统前期、渲染、后期和交付核验。先读取本仓能力，冻结人、商品、平台、时长、账号调性、声音与特殊要求，再走现有官方流程。不能把另一个仓库的功能、成片或测试结果算成本仓能力。

## 1. 工作台的第一步：读取本指南全文

从当前仓库根执行：

```bash
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs describe growth.video.workbench.guide
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
```

第三条返回 JSON，`result.markdown` 是本文件完整正文，同时返回仓库/产品身份、版本、路径、SHA-256 和能力限制。此能力只读本仓固定文档，不需服务端、供应商密钥或模型调用，不生成、不渲染、不花钱。MCP 客户端先 `tools/list`，再调用 `workloom_growth_video_workbench_guide`，参数 `{}`，收到的也是同一份正文。

命令、目录或文档读取失败时，保留错误并停止依赖它的动作，不能拿别仓路径、记忆中的参数或临时脚本顶替。CLI 的 `--root` 与 MCP 的 `WORKLOOM_PRODUCT_ROOT` 应指向实际目标仓；阅读返回的 repository 和 productId，避免把三个同源仓混用。工作台接入方式见 [AGENT-CLIENTS.md](AGENT-CLIENTS.md)，标准出片 runbook 见 [ai-video/README.md](../bundles/ai-video/README.md)。

## 2. 从用户原话冻结作业合同

**按每条短片重新规划，不把成功样片变成固定模板。**总时长遵循用户明确要求；用户未指定时，由视频管线结合目标平台、内容和预算提出方案，并标明这是系统规划。镜头数、逐镜时长和镜头编排由正式视频管线按叙事、商品展示、台词、节奏、可用素材及当前生成能力自主拆分；只有用户明确指定的项才作为作业固定项。工作台不得沿用上次的「6 镜」「每镜 5 秒」或镜头顺序替管线做决定。版本数按本次需求和所选正式交付入口核对。

把用户原话保留为 `rawIntent`，在本地作业资料中逐项写清下表。已有明确答案直接采用；只有确实缺少不可自行取得的必需信息，才要求补充。后续提示词、镜头卡、渲染参数、配音和后期必须能追溯到这份合同。

| 冻结项 | 必须记录 | 缺失或冲突时怎么处理 |
|---|---|---|
| 指定人 | 角色档案 ID、平台授权素材、人物属性、授权范围/有效期；哪些镜头出镜 | 指定真人缺档案/授权则停。不能默认为陈卓、改换 AI 人物或猜性别 |
| 商品 | 用户明确商品名、品牌、档案、真实图/使用范围、不能改写的事实与卖点 | 营销片没有商品锚点则停，不能编商品或参数 |
| 平台 | 抖音/小红书等具体目标、画幅、字幕方式、交付分辨率 | 不用默认平台覆盖用户指定平台 |
| 时长 | 目标秒数、允许误差、分镜时长之和、口播长度 | 不以文件名里的“30s”代替实测，不擅自加速声音凑时长 |
| 账号调性 | 账号 ID/已批准档案、受众、语气、视觉、开场和 CTA | 不把通用“爆款”风格套到指定账号上 |
| 声音 | 原生音频、指定声音/音色、对白原文、允许的旁白/BGM、音频保留边界 | 禁止用另一音色、TTS 或换词代替用户指定声音 |
| 特殊要求 | 必须保留/禁止出现的内容、镜头顺序、商品露出、参考用途、验收条件 | 执行器不支持时记为阻塞，不能悄悄删要求 |
| 费用与恢复 | 允许的生成范围、已有 project/run/job、供应商任务与已生成素材 | 先查回执和现有产物，不能为“试一下”重复付费 |

该合同是 AI 的作业纪律；本次指南不新增生产硬闸或自动验证所有字段的能力。系统现有红线、角色/商品绑定、字段规范、参数与产物闸继续按真实代码执行。

## 3. 按系统官方流程推进

1. **查能力和环境。**先读指南，调用 `growth.repo.readiness` 与 `growth.video.gen.catalog`（后者需要服务端就绪）；执行 `pnpm video:doctor` 检查媒体工位。缺依赖、额度不足或目标能力未接通时保留失败事实。
2. **先分流。**用户需求进入系统视频工位/标准派活入口，由 `video.studio.start` 走营销、叙事、口播解释片或澄清分流。CLI 场景可运行 `route-video.mts`，保存分流记录；判 `clarify` 时先解决缺项，不能替用户进入付费渲染。
3. **系统生产前期和提示词。**由本仓预生产管线产出剧本、镜头与提示词，绑定冻结的人/商品/场景和原话。不要为了绕过缺入口手写“看起来能跑”的镜头卡、改剧情或跳过规范步骤。定妆照需要时复用已批准档案；没有新的用户否决，不重复出图或让机器相似度触发付费重做。
4. **读取并核对正式前期产物。**用 `growth.video.production.shots` 读取服务端项目镜头和资格，核对合同中的每个固定项；MCP 只读能力不会替你创建项目或启动前期。系统正式产物尚未就绪时停止，不能拿本地草案冒充。
5. **取得计划，才进入执行。**`growth.video.production.plan` 返回预览命令与前置清单；它本身不启动任何任务。将其参数与正式镜头文件、分流记录、brief、账号和声音合同逐项核对，再使用现有 CLI 执行本仓官方出片链。按 `execution.command/args` 逐参数调用，避免拼接未经转义的用户原话。
6. **先恢复，再考虑补跑。**固定 project、work/out 目录和输入，不主动用 `--no-resume` 清掉复用条件。平台任务已提交却状态未知时查原任务；账户欠费/额度错误先解决账户状态。只有已有记录证明哪个镜头需要更改、且变更被授权，才走逐镜返修；同提示词不盲重试。
7. **完整后期并核验。**保留官方 compose、color、subtitle、BGM、cover、mux、master、deliver 的实际记录；不在系统外用临时 ffmpeg、临时封面或手工音轨替换伪装交付。`growth.video.production.status` 用来读阶段结果，`growth.video.delivery.inspect` 用来核对清单和实际文件 SHA-256。缺阶段、未核实声音/时长、清单缺件或摘要不符都不能宣称完成。

预生产归档的 `attempt-*.shotlist.json` 可能明确带 `draft:true`，还必须补齐片型必备标签和证据并经过正式渲染前硬闸；文档不能把归档草稿提升为已放行镜头。

本仓预生产的实际入口在 `apps/server/src/video/router.ts#studioRouter.start`，再进入 `studio-worker#startVideoProjectRun`；CLI 出片入口是 `scripts/tools/full-chain-film.mts`。两者职责不同，不能把本地 `production.plan` 返回 `ready:true` 解释为系统正式生产资格已通过。

当前 Studio 的 `intent` 最多 2000 字符，可带 `metadata`；完整 brief 仍需留在项目资料，并可放入 `metadata.brief` 传入服务，不能只留一个短标题。新建与补跑入口目前都显式按 `durationSec:30` 构建管线意图。非 30 秒需求须在启动前记录这一差异，并核对正式前期实际时长；不能因 metadata 写了目标秒数就假定下游已兑现。发现固定项被改写时停止进入付费渲染，使用能保留实际请求的已有项目/规范镜头卡路径，或如实报告缺口。

## 4. 安全调用例子与三个场景

只读发现与计划：

```bash
node scripts/workloom-agent.mjs invoke growth.repo.readiness
node scripts/workloom-agent.mjs describe growth.video.production.plan
node scripts/workloom-agent.mjs invoke growth.video.production.plan --input-file work/film/plan-input.json
node scripts/workloom-agent.mjs invoke growth.video.production.status --input-file work/film/status-input.json
node scripts/workloom-agent.mjs invoke growth.video.delivery.inspect --input-file work/film/delivery-input.json
```

`plan-input.json` 只使用当前 schema 支持的字段：`title`、`projectId`、`platform`、`shotlistPath`、`routePath`、`outDir`。例如：

```json
{
  "title": "已冻结的用户需求原话",
  "projectId": "VID-CUSTOMER-01",
  "platform": "抖音",
  "shotlistPath": "work/film/shotlist.json",
  "routePath": "work/film/route.json",
  "outDir": "work/out-VID-CUSTOMER-01"
}
```

该输入不承载完整声音/商品/账号合同，不能用它覆盖生产资料。`status-input.json` 用 `{ "projectId": "VID-CUSTOMER-01", "workDir": "work/vm-VID-CUSTOMER-01" }`；`delivery-input.json` 用 `{ "projectId": "VID-CUSTOMER-01", "outDir": "work/out-VID-CUSTOMER-01" }`。使用项目实际目录，避免读错默认示例。

| 用户场景 | 正确动作 | 用户不用这条纪律会发生什么 |
|---|---|---|
| 指定 CEO 为某商品拍抖音片 | 冻结真人/商品/平台/时长/声音，先走系统营销前期，复用已批准人物和商品档案 | 会用错人、商品没有绑定或消耗额度后才发现身份不符 |
| 已有合格镜头，只改字幕或封面 | 先读原项目状态和交付清单，再走正式返修影响分析；复用原镜头 | 整片重渲花钱，或外部手工修改导致清单失效 |
| 指定原生声音、剧情顺序和精确时长 | 核对本仓是否支持所需音频路径，不能满足就保留阻塞，不替声、不重排、不拉速 | 看似产出成片，实际声音/剧情/时长已违背原始需求 |

## 5. Growth 当前能力边界

本指南基线下，Growth 已有分流、正式前期、全链 CLI、阶段账本和交付核验入口。已存在不等于当前机器、账号与依赖已经就绪，也不等于本次已重新做过真实付费生成验收。

- **没有 Growthtest 的标准后期新入口。**此基线没有 `scripts/tools/film-standard-post.mts`、`packages/video-studio/src/standard-post-contract.ts`，CLI 不含 `--standard-post`。不要复制别仓命令或声称本仓已支持。
- **没有 Growthtest 的 nativeaudio 专用契约。**普通全链的 `voice` 阶段可能补 TTS 旁白；要求“只用原生声音/指定声线、禁止替声”的项目不能直接当作同一能力执行。能力不足必须停在付费动作前，不使用 TTS 或另一音色兜底。
- **MCP 提供读取和预览。**本轮新增的是指南读取；视频创建、渲染与交付不会因为工具菜单多了一条指南而自动接通。
- **后期仍遵循本仓现有执行器。**文档不会把旧自由后期路径升级成新标准后期机制，也不授权随意重剪、替声或绕过正式产物回执。
- **不自动发布到社交平台。**交付清单核验完成只代表本地交付核验；外发需要独立业务授权和真实远端回执。

## 6. 从用户指令到交付的耗时怎么记录

下面的「30 秒、6 镜、五交付版本」仅是本次历史样本的计时条件，不是生产默认参数或通用交付数量，也不参与拆镜决策。新作业按管线实际镜头数、逐镜时长、生成类型和所需版本重新估时；17–30 分钟及 25 分钟不作为全局超时或验收闸。

本仓本次只做指南和发现能力，不新增模型/渲染/TTS 调用，因此**没有本轮 Growth 的正常全程实测值**。不能拿“缓存后期重跑几秒”“历史试跑含修复等待”或跨仓成功样本当作本仓正常 SLA。

**跨仓规划参考（D 级估算，2026-10-07）：**已成功的 Growthtest 30 秒、六镜、五交付版本样本，可作为相近任务的排期参考。角色、商品、授权素材和本机依赖齐全，单轮通过、无欠费/人审等待/返修时，从完整指令到前期提示词、渲染、后期、QA 和本地打包建议预留 **17–30 分钟，排期约 25 分钟**。这不是 Growth 的速度实测，也不表示 Growth 已接入该样本的标准后期或原生音频机制。

| 环节 | 规划时间，D 级 | 前提与口径 |
|---|---:|---|
| 需求与资料读取、系统前期和提示词 | 2–5 分钟 | 人物、商品与授权资料已齐；未单独测量正常模型前期延迟 |
| 六镜按现有顺序提交到供应商成功 | 8–10 分钟 | 首镜通过，剩余镜头单轮生成，无付费重试 |
| 取片与本地技术检查 | 0.5–2 分钟 | 正常网络，单列下载与探针开销 |
| 母版、软字幕版、三个风格版后期 | 5–8 分钟 | 对应 Growthtest 成功样本；本仓实际支持范围仍以第 5 节为准 |
| 本地 QA、交付清单与打包 | 1–3 分钟 | 不含社交平台外发、人工响应或完整研发验收 |

上述分段算术为 16.5–28 分钟，取整并留余量为 17–30 分钟。已有合格素材只做后期的跨仓规划参考是 **6–12 分钟（D）**。样本可复算事实（B）：六个供应商任务的 `created→succeeded updated` 各为 66–82 秒，六项相加 435 秒；仅两任务实际重叠，活动区间并集为 391 秒。最终后期记录 31 步累计 `ms=285697`，即 4 分 45.697 秒，但缺独立流程起止墙钟。这些组成部分来自不同轮次，既不是正常端到端实测，也不能把最早到最晚的修复空档算成正常渲染时长。

记录四个时点：用户原话与必需素材冻结完成；系统提示词/正式前期就绪；供应商渲染取得实际文件；官方后期及交付核验完成。首次总耗时是最后一个时点减去第一个；前期、渲染、后期各段分别计算。人审/用户补资料/欠费等待单列；缓存命中、已有素材补跑和返修样本分别标明。

`growth.video.production.status` 返回账本 `firstAt`、`lastAt`、各阶段计数与失败项；详细阶段记录在 `<workDir>/logs/<projectId>/stages.jsonl`，其中 `at`、`ms`、`cached`、`invoked` 说明实际执行与复用。端到端缺某一时点时就写“未测/缺证据”，不从超时阈值或影片秒数推算正常时间。

交付汇报至少包含：原需求固定项是否满足；正式母版/字幕/封面/变体/清单路径；阶段和摘要核验结果；真实生成次数与复用；各段实际耗时及等待时间；仍缺什么。未经核验的产物标为候选，不以“文件存在”替代完成。

## 7. 功能优先级与不做范围

| 优先级 | 固化的具体行为 | 对用户的作用 |
|---|---|---|
| P0，本次已内置 | 从 CLI/MCP 读取同一固定指南；先冻结用户固定项；指出正式前期、恢复、交付核验入口 | 防止用错仓、改人换声、绕流程或把未核实产物说成完成 |
| P1，本次已内置 | 计划输出指南锚点；AGENTS.repo、README 和现有 runbook 引导先读；客户端载荷只复制这一固定指南 | 新会话和安装后的运行目录能找到同一份规则，避免靠对话记忆 |
| P2，后续独立任务 | 增加本仓从指令到交付的完整正常耗时实测；新增生产机制后更新能力边界 | 用本仓证据给排期，不误用缓存重跑或跨仓成绩 |

本次不新增生产执行 MCP 工具、不移植 Growthtest 的标准后期/原生音频机制、不升级模型或供应商、不生成新的样片、不自动外发社交平台，不解除隔离副本的同步边界。

## 8. 维护和回归

只读指南能力的测试命令：

```bash
node --test scripts/agent-capabilities.test.mjs scripts/video-capabilities.test.mjs scripts/pack-workspace-modules.test.mjs
node scripts/workloom-agent.mjs list
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide
pnpm capabilities
pnpm capabilities:check
git diff --check
```

修改本仓生产入口或新增标准后期/音频契约时，更新本指南的能力边界与版本，并重新核对 CLI/MCP 返回正文、目录发现、路径与 SHA-256。受控共享文档和其它仓库的生产机制不在本指南修改范围内。
