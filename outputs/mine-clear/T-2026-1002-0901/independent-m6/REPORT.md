## 覆盖率声明

- 范围内文件总数：157；精读：149；机检/脚本解析：2；抽样：6；未读：0。范围是 24 张排雷卡与 OBS-01..19 关联源码、测试及直接合同；仓库跟踪文件总数为 3127，本轮没有宣称全仓精读。
- 本次相对 audit 基线的变更文件 79 个：72 个精读、2 个锁文件全量解析、5 个大型文件/历史文档选段阅读。其余 78 个所选文件是直接依赖与验收合同，精读与新增依赖选段分别落在逐文件表。
- 未读/抽样清单及原因：[file-coverage.csv](file-coverage.csv) 逐文件列 mode、行段、原因和 SHA。2 个 B 文件为 pnpm-lock.yaml 与 runtime package-lock.json；6 个 C 文件逐项见清单；原五个为 CHANGELOG.md、OPEN_SOURCE_COMPONENTS.md、router.ts、suite.ts、full-chain-film.mts；重置补查的assembly.ts仅510..665及805..940选段，未称全量阅读。巨型路由/通用套件/影片脚本只读受影响 diff 与关键实现段；历史文档只读本轮修复段和邻接上下文。未重读其余无关业务链，不能把机检覆盖说成理解覆盖。
- RDAS v3.1 276 项逐项登记：pass 9 / fail 0 / not-run 100 / manual-missing 167，见 [coverage.json](coverage.json) 与 [coverage.csv](coverage.csv)。这张表登记完整检查项协议；未执行完整阈值的 native/UX 条目仍为未验证，native历史实测失败与当前QA门分别单列，不能据fail=0推导没有实测失败。pass只表示所列目标的已测断言，未执行项均无豁免；源码专项复验/合同继承558/558不等于RDAS276/276。原冻结源density首次3/4仍为失败，原阈值复测4/4的四个用例只计一次。
- Tier 计数：T1 5/52、T2 4/201、T3 0/23。未执行 267 项的理由、影响、owner、补做门槛逐项落在 coverage；真实用户、正式跨平台、真实供应商、业务交付和长期协议未测，均明示 D。

# Growth 独立 M6 专项报告（RDAS v3.1 · R2 · 源码基线 1e471c3）

生成时间：2026-10-04T05:32:31.451409+08:00。fixed_by=`codex-root-T-2026-1002-0901`，verified_by=`growth_m6`。本验收者不改产品源码、Git、CNB或原始父任务台账；验证器与修复者不同。父任务明确另行授权真实acceptance执行器仅更新新版execution-ledger与唯一run/index/stdout，实际执行状态单列。测试仅使用已授权的本机模拟数据库/独立夹具及本地进程，没有真实供应商付费触发。

**当前结论：源码专项条件通过。当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。** 当前接受基线完整SHA为 `1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8`，所选产品测试实际基线为 `7fee3a6a5563d41c568463994764d3883eb7667d`，保留浏览器实际基线为 `f0a11286a49419fb7909088e2d170f4dde7b60c6`；各组只按原wrapper记录直接执行或明示有效输入合同继承。24卡和19项观察均逐项有证据。最终职场控制加载精确生产构建CSS，在减少动效偏好下运行原生绘制/投影、真实鼠标、首帧定位、用户滚动与可选drop分支；日志、测试源码和实际结果分别登记，原无CSS夹具通过仅为有限证据。唯一目标用例共558；当前接受源码在本558功能矩阵实际执行0例，另558例按明示完整有效输入合同继承（192旧核心、130个7fee核心替换、45个d6 Canvas、148个f0a Floor、7个7fee Stage及36个7fee产品用例）；真实current MCD卡/角色断言另列分母。原并行8超时、density首次3/4、历史native实际失败与所有职场红回执都保留；观察器修正明确列出。`source_scoped_merge_eligible=true`、`production_release_eligible=false`；正式Windows/Apple信任链、真实模型、完整UX和经营结果仍未验证。原09bcPNG/24快照缺口和两次QA.env误删已明确更正。**[A源码；B实际命令/状态；C截图；D正式平台/经营及原失败因果]**

源码范围外的实际安装依赖另有6个完整文本读物（CNB UI package/index/language及三CSS），见[floor-external-read-inventory.json](floor-external-read-inventory.json)；这些不是仓库跟踪文件，不混入上述N。只读了调用相关合同，不宣称整个UI/R3F/Drei依赖的语义覆盖。编译后的139675B生产CSS以全量B指纹/链接解析冻结，名牌、投影、相机和命中由实际产品/依赖运行，没有复制实现。**[A所列外部文本；B编译CSS/实际运行]**

## 环境与资产指纹

| 项 | 冻结值/事实 | 证据等级与范围 |
| --- | --- | --- |
| 三基线 | audit=42ead347c65a5cc343bcd290702d53a7fcdb1687；repair=04099407ca73085e5d87f5c4d33ca9bba64f3374；acceptance=1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8 | B Git/SHA 元数据 |
| 分支/工作树 | task/T-2026-1002-0901；验收冻结时 working_tree 空，原 repair 是当前祖先 | B 实际 Git 查询 |
| 目标档位 | 源码专项本机真实进程/PG；ws-geo data_mode=simulated；HTTP 测试设置 NODE_ENV=production；不是 P 域 deployed 验收 | B 实际环境查询 |
| 租户/数据库 | tenant-demo / ws-geo；owned loopback growth_audit；PostgreSQL 17.11 (Postgres.app) | B environment-db.json |
| 工具/浏览器 | Node v24.19.0；Playwright 1.63.0；独立空白 Chromium 154.0.8037.95；安装 Electron 44.1.1 | B 安装元数据/实际进程；没有“最新”版本主张 |
| OS/架构 | ProductName:		macOS; ProductVersion:		15.7.3; BuildVersion:		24G419；arm64 | B sw_vers/进程实际环境 |
| 供应商/模型 | 独立夹具 provider keys 清空，review 使用 mock；实际 paid supplier calls=0；真实返回 model ID/version 未验证 | B 测试环境合同 + D 能力指标 |
| 提示词/preset | 85 文件；aggregate SHA256=115ff24afbf1513143521e43b1d5969d07e5f60c3b54e4e8aab7dd276cdf5e1a | B 文件指纹 |
| 技能文本 | 94 文件；aggregate SHA256=19c6f48be4e7261fcc6be17373d033639af4c93c3889f4897b41bf199f20b4d0 | B 文件指纹 |
| 围栏 | 16 文件；aggregate SHA256=75521ae3b34bda69959b45b9ce5a56c8b41fd117b107a38120af6d787960d845 | B 文件指纹 |
| bundle/种子/记忆 | 3 bundle manifests；2 seed files；2 memory/review implementation files；各文件与 aggregate hashes 见 asset-fingerprint.json | B 指纹；不冒充资产全量语义理解 |
| 依赖锁 | pnpm lock importers=12/packages=711/snapshots=718；runtime npm lock packages=135；逐文件hash在baseline-acceptance.json | B 全量 JSON/YAML 解析 |
| 评审/数据集 | growth_m6 单独源码审阅+确定性断言；558 唯一目标用例/原始 1370 广域用例；无 LLM judge、无业务 gold/holdout、无双评分 κ | B 断言结果 + D 未测指标 |
| 价格/统计 | 真实供应商价格表未冻结/未执行；无业务 Wilson CI/标准化权重/因果判定；确定性测试不当独立业务样本 | D 未验证，明确无结果效益主张 |

精确源文件 hashes、三基线与变更清单见 [baseline-acceptance.json](baseline-acceptance.json)；prompt/skill/fence/bundle/memory/seed/lock 的逐文件与 aggregate hashes 见 [asset-fingerprint.json](asset-fingerprint.json)。数据库原 5 条 server-error 记录 E-13019..E-13023、seq 4104..4108 及 prev/hash 未删除，见 [environment-db.json](environment-db.json)。浏览器环境指纹来自独立空白页；职场控制实际渲染产品组件并记录逐例几何、点击与滚动结果。两者都不是完整真实用户研究。**[B]**

前8组执行于原repair040或父通道修复3bfb；a403补了film-worker/pack/suite-geo，09bc/0f3补引导/截止，ad4a补Live2D/临时WebGL。未变runtime/gateway/auth/release按Git diff及冻结hash继承；parent scope在3bfb、geo在a403、guide9与React4+3在ad4a执行。955e的87desktop、8transient、4ready、5真实PG、4welcome、8server、4density及全仓typecheck/两CJS均独立重跑，构成296个历史唯一用例。新增职场组的真实执行SHA、原样命令、源码/CSS/夹具hash与可能的字节相等继承逐项见 [floor-final-verification.json](floor-final-verification.json)。其中historical_955e_source_rebinding逐项对比完整核心Git输入子树和原冻结所选blob；改变的P0调用方与修复文档明确排除历史继承，改由当前浏览器/原生门及精读判定。旧版九个运行wrapper本来没有source_before/after字段，原字段保持原样，没有补造当前执行SHA；它们是继承的历史合同证据，新的MCD实际执行另列。携带ready四例的portable pair实际8/8，其中重复ready四例不再计入新welcome组。原时间/SHA不改写为均在最终接受提交重跑。**[A完整旧文+精确新diff；Bhash/diff/原始命令；D原wrapper缺失的执行SHA]**

当前 main.cjs 与 bootstrap.test.cjs 相对955e已改变，完整旧296组不能整体继承。旧desktop87、guide9与transient8从本轮唯一分母移除；准确7fee3a6实际执行desktop113、guide9与transient8，共130例，旧不受影响核心仅192例按完整未变Git树/blob与原所选文件继承；root package与runtime metadata的解析等价边界分别登记。bootstrap独立60/60另有实际日志，但已包含在desktop113，不重复计入。以上Stage7、产品36、desktop113、guide9和capture8的实际运行来源保持7fee；Floor148保持f0a、Canvas45保持d6，其余核心192保持已有冻结来源。f0a至7fee逐一比较完整web递归blob时，只有实际重跑的Stage源与新增Stage测试两文件不同；不能说从f0a至7fee整个web树未变。当前依赖版完整9个源树/blob相等；pnpm完整字段归一化只允许确切0.4.0 selector与唯一gh-pages边差异，runtime npm134包全字节相等。558例按这个有界合同继承，未写成新源码重跑。具体替换与执行记录见current_core_control_replacements及native_observer_subset，没有伪造旧wrapper缺失的SHA。**[B完整Git输入与实际原始运行；A完整源码合同；D原缺失执行字段]** 本轮accepted=1e471c3仅依赖部署边改变，以上130个7fee替换例及192旧核心都按严格有效输入继承；当前558矩阵实际执行数为0，独立modern角色断言另列，不把二者混为同一分母。

OBS19（rootOBS23）是在最终7fee真实repair-role执行到MC016时发现的新High：GHSA-vfj7-8cjw-p6xm通过live2d→gh-pages→globby→fast-glob→micromatch→braces3.0.3进入当次245生产依赖图；前15卡实际绿而MC016 exit1，后续当轮未执行。原run/输出/hash与38份7fee源码/原生/报告冻结文件都保留，见[mc016-new-high-advisory-red-review-7fee.json](mc016-new-high-advisory-red-review-7fee.json)与[mc016-red-readback-official-7fee.json](mc016-red-readback-official-7fee.json)；此前旧245/零公告没有冲销这个新red。官方[GitHub Advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)当次读取为High、受影响≤3.0.3、patched=None；没有虚构可升级的补丁。**[B实际registry/原run/官方元数据；D利用可达性]**

本轮接受源码1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8只改变根manifest selector、pnpm唯一snapshot依赖边、runtime metadata两输入hash和修复文档四文件；[pnpm10.x overrides](https://pnpm.io/10.x/settings#overrides)说明精准parent selector与减号移除依赖语义。确切[pixi-live2d-display v0.4.0 manifest](https://raw.githubusercontent.com/guansss/pixi-live2d-display/v0.4.0/package.json)的该gh-pages调用位于deploy脚本，发布入口为dist/types。根helper只扫描12个发布文件的literal import/export/单字符串require，文件指纹不变；这是B静态元数据，未宣称已精读上游所有源码或证明任意动态加载不可能。具体来源/读段见[dependency-official-provenance.json](dependency-official-provenance.json)。**[A本地完整manifest/diff；B上游发布元数据和literal引用扫描；D任意动态语义]**

独立完整YAML解析及不可变Git复核验证12 importers、711 package节点/integrities、718 snapshots、其余manifest字段完全相等，只有确切0.4.0 selector与一个gh-pages边按预期移除；134个桌面npm-lock包全字节相等，16输入metadata只有两个已验证hash不同。9个递归源树/blob相等，见[dependency-1e47-structural-binding.json](dependency-1e47-structural-binding.json)与实际执行的[dependency-functional-input-inheritance.json](dependency-functional-input-inheritance.json)。558控制用例保留原7fee/f0a/d6/旧核心的原argv、时间与执行SHA：本558例矩阵在当前接受提交实际运行0例、按该有界输入合同继承558例。当前registry审计、新.6 app/payload/DMG字节、冷两模式/首装/重启/真实已有客户升级、真实诊断GUI和modern23卡独立acceptance均另验，未从继承推出绿。**[B完整有效输入等价；A原完整相关源码；D未执行边界]**

本轮实际current registry审计197个生产依赖，所有严重级0、advisories={}且muted=[]；实际repair/acceptance run、输出SHA与开始/结束时间见[mcd-acceptance-verification.json](mcd-acceptance-verification.json)。原High红回执、之前native.5和新native.6分别保留。MC001实际MCD合同运行bootstrap60项，是历史完整desktop113的子集；没有把MCD60项标成当前重跑113。23卡/逐卡assertion不是558功能用例或经营分母。**[B实际source/security/角色元数据；D未来公告和完整能力]**

当前modern repair的首MC001尝试因不同提交的evidence-index混写被执行器拒绝：assertion exit2、driver exit1/1.052s；原JSON/log保留于[evidence__mcd-repair-1e471-current.json](../artifact-index.json)（原件未包含，见索引）。正确建立当前index后的另一轮在MC014实际82/83失败：滚动日期夹具已积累九日18条模拟metrics，C15先看到16条、随后C16再插入当日两条。root先完整保存18条原模拟行，再在自有loopback假库事务中恢复七日14条前置，移出的四条原行保留，biz_events仍88条未变；这是夹具前置恢复，没有改产品或把原run写绿，见[evidence__mcd-geo-date-drift-prerequisite-restored.json](../artifact-index.json)（原件未包含，见索引）及[evidence__mcd-repair-1e471-index-current.log](../artifact-index.json)（原件未包含，见索引）。之后24卡/38条repair及独立23卡/37条acceptance都是新的实际运行。**[A先前完整seed/suite合同；B实际root夹具/原run与独立回读]**

本验收者本轮另保留两个观察器错误：第一次app探针错传outputs-not-used文件名，原MODULE_NOT_FOUND wrapper仍exit1；依赖等价观察器最初将npm-lock的135条含root记录误期望为134，实际只读Git证据为135总记录/134非root包且旧新全字节相等。纠正只收紧这两个正确计数与文件入口，其余完整等价guard不删；原脚本与失败边界见[dependency-owned-observer-corrections.json](dependency-owned-observer-corrections.json)。首次等价错误只有当时终端观测，没有原wrapper/log，不补称完整原始命令回执。**[B实际字节/原日志；D未保留原终端全文]**



## 证据分级、类型与七环

按用户要求，A 指完整源码精读得出的实施结论，B 指全量机检/实际命令与 DB 状态，C 指选段或截图样本，D 指推断或未验证。RDAS 更强的结果 A 还要求真机实测、至少两类独立证据及业务外部回执；本报告不把“源码 A + 单次测试 B”自动升级为生产经营结果 A。下面的实施判断与测试数字分开标注，选段链路始终保留 C。**[A/B/C/D 定义]**

| 证据类型 | 本轮来源 | 边界 |
| --- | --- | --- |
| R Runtime | 命令耗时、HTTP 状态、工具调用次数、permit consumption、job terminal state | 确定性夹具指标；不是业务可靠性分布 |
| P Page | 1440/390 几何 JSON 与截图；root 原生 workplace/stage 样本 | C 样本；没有完整真手机/读屏/点击协议 |
| L Ledger/DB | 实际审批/thread/plan/permit/event/job 状态；原5条系统错误保持 | owned fake growth_audit；没有外部经营系统对账 |
| C Command | 目标组、typecheck、locks、audit、广域原 run/窄复测日志 | 命令按原环境执行；失败日志同样保留 |
| X External receipt | 历史与当前准确源码的继承CNB状态分别绑定；fake-CNB 发布合同单元测试 | 真实供应商/渠道交付回执不存在；fake-CNB不是X生产回执 |
| H Human judgment | 真实业务人工评审缺失；growth_m6代理做源码与截图审阅 | 代理审阅不冒充人工评分、双评或真实用户研究；κ未测 |
| T Telemetry | parent component frames、tool counters、job error/log与system.error契约 | 没有真实模型token/成本OTel生产轨迹 |
| S Statistics | 命令/断言的描述性数量 | 无Wilson业务区间、pass^k、bootstrap因果估计或LLM judge校准 |

| 七环 | 本轮证据 | 缺环影响 |
| --- | --- | --- |
| 1 任务 | 带m6/audit标记的thread、approval和公共film start fixture | 能定义测试单位；不能定义真实经营分母 |
| 2 轨迹 | 实际runtime/job日志与参数/冻结hash记录 | 没有真实供应商Agent生产轨迹 |
| 3 工具调用 | 本地counter、实际子进程、本地cine-kb/continuity、父通道frame | 外部动作被禁用/替代，不推导外部成功 |
| 4 环境状态 | 真实loopback PG终态、started/consumed和job失败/完成断言 | 可证明所列本地状态和失败关闭 |
| 5 外部回执 | 真实模型/渠道/经营回执缺失；fake-CNB仅合同测试 | O/P业务完成不能成立 |
| 6 业务数据 | 无KPI/订单/获客转化等真实结果数据 | 不能量化经营价值 |
| 7 归因 | 无对照/准实验/线下工时核对 | 不能宣称AI贡献或自主价值提升 |

## 四层判定与专项执行

| 层 | 本轮证据/缺失 | 判定 |
| --- | --- | --- |
| L 基础 | 558个唯一专项用例，实际PG/HTTP/子进程/React/Chromium/源码；完整L矩阵未重跑；当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | 专项条件通过；完整L层未验证 |
| U 体验 | 两种桌面视口和少量原生截图；无用户研究、真手机、无障碍完整旅程 | 未验证；C样本不能替代全任务成功率 |
| O 交付 + ADR | 结构合同与模拟失败关闭；真实交付件分母0，金标/回执/KPI/工时缺失 | 结构合规/能力未验证 |
| P 生产实测 | 供应商调用0；实际返回模型版本、配额账本与真实产物均缺失 | 未验证 |

| 独立运行组 | 结果/断言 | 退出码 | 耗时 | 原始证据 |
| --- | --- | --- | --- | --- |
| runtime-repro | 9/9 | 0 | 27.032s | [runtime-repro.log](runtime-repro.log) |
| gateway-permit | 20/20 | 0 | 2.173s | [gateway-permit.log](gateway-permit.log) |
| parent-channel-after | 13/13 | 0 | 4.045s | [parent-channel-after.log](parent-channel-after.log) |
| auth-http | 11/11 | 0 | 17.066s | [auth-http.log](auth-http.log) |
| film-public-success | 5/5 | 0 | 44.140s | [film-public-success.log](film-public-success.log) |
| film-public-missing-output | 1/1 | 0 | 27.347s | [film-public-missing-output.log](film-public-missing-output.log) |
| film-public-deadline | 1/1 | 0 | 17.526s | [film-public-deadline.log](film-public-deadline.log) |
| release-video | 17/17 | 0 | 11.341s | [release-video.log](release-video.log) |
| surface-7fee-desktop | 113/113 | 0 | 13.131s | [surface-7fee-desktop.log](surface-7fee-desktop.log) |
| geo-supplement | 83/83 | 0 | 23.202s | [geo-supplement.log](geo-supplement.log) |
| surface-7fee-guide-lifecycle | 9/9 | 0 | 0.248s | [surface-7fee-guide-lifecycle.log](surface-7fee-guide-lifecycle.log) |
| web-lifecycle | 4/4 | 0 | 58.755s | [web-lifecycle.log](web-lifecycle.log) |
| web-lifecycle-independent-fixed | 3/3 | 0 | 66.864s | [web-lifecycle-independent-fixed.log](web-lifecycle-independent-fixed.log) |
| surface-7fee-guide-transient | 8/8 | 0 | 0.241s | [surface-7fee-guide-transient.log](surface-7fee-guide-transient.log) |
| questline-ready-after | 4/4 | 0 | 27.117s | [questline-ready-after.log](questline-ready-after.log) |
| welcome-progress-after | 5/5 | 0 | 22.639s | [welcome-progress-after.log](welcome-progress-after.log) |
| welcome-client-after | 4/4 唯一新用例（实际run 8/8；重复4例不再计数） | 0 | 27.453s | [welcome-client-after.log](welcome-client-after.log) |
| welcome-server-after | 8/8 | 0 | 63.950s | [welcome-server-after.log](welcome-server-after.log) |
| ceremony-density-final-repeat | 4/4 | 0 | 72.738s | [ceremony-density-final-repeat.log](ceremony-density-final-repeat.log) |
| floor-canvas-production-final | 24/24 | 0 | 129.428s | [floor-canvas-production-final.log](floor-canvas-production-final.log) |
| floor-canvas-boundary-production-final | 14/14 | 0 | 79.701s | [floor-canvas-boundary-production-final.log](floor-canvas-boundary-production-final.log) |
| floor-canvas-initial-viewport-production-final | 7/7 | 0 | 17.823s | [floor-canvas-initial-viewport-production-final.log](floor-canvas-initial-viewport-production-final.log) |
| scene-f0-default | 28/28 | 0 | 59.462s | [scene-f0-default.log](scene-f0-default.log) |
| scene-f0-drop | 55/55 | 0 | 56.707s | [scene-f0-drop.log](scene-f0-drop.log) |
| scene-f0-edges | 29/29 | 0 | 34.331s | [scene-f0-edges.log](scene-f0-edges.log) |
| scene-f0-hover | 33/33 | 0 | 27.792s | [scene-f0-hover.log](scene-f0-hover.log) |
| scene-f0-safety | 3/3 | 0 | 15.915s | [scene-f0-safety.log](scene-f0-safety.log) |
| surface-7fee-product-tests | 36/36 | 0 | 2.639s | [surface-7fee-product-tests.log](surface-7fee-product-tests.log) |
| surface-7fee-layout | 7/7 | 0 | 24.274s | [surface-7fee-layout.log](surface-7fee-layout.log) |
| welcome-typecheck | 955e 全仓类型检查通过 | 0 | 220.798s | [welcome-typecheck.log](welcome-typecheck.log) |
| dependency-audit | 历史245依赖/零公告原回执；7fee新High已重新打开MC016 | 0 | 3.151s | [dependency-audit.log](dependency-audit.log) |
| web-lifecycle-typecheck | 补充前端类型检查通过 | 0 | 21.979s | [web-lifecycle-typecheck.log](web-lifecycle-typecheck.log) |
| welcome-main/helper-syntax | 955e 两 CJS 语法检查通过 | 0 | 6.443s/6.442s | [welcome-main-syntax.json](welcome-main-syntax.json) / [welcome-helper-syntax.json](welcome-helper-syntax.json) |
| repair/MC-016 current-audit | 197实际依赖/各级公告0/muted[] | 0 | 15.454s | [mcd-acceptance-verification.json](mcd-acceptance-verification.json) |
| repair/MC-106 current-audit | 197实际依赖/各级公告0/muted[] | 0 | 2.790s | [mcd-acceptance-verification.json](mcd-acceptance-verification.json) |
| acceptance/MC-016 current-audit | 197实际依赖/各级公告0/muted[] | 0 | 7.863s | [mcd-acceptance-verification.json](mcd-acceptance-verification.json) |
| surface-7fee-runtime-lock | 精确输入锁校验通过，实际执行版本见原wrapper | 0 | 0.292s | [surface-7fee-runtime-lock.log](surface-7fee-runtime-lock.log) |
| surface-7fee-web-typecheck | 冻结目标的前端类型检查通过 | 0 | 2.533s | [surface-7fee-web-typecheck.log](surface-7fee-web-typecheck.log) |
| surface-7fee-web-build | 冻结目标的实际生产构建与客户端文案边界检查通过；构建 CSS 与浏览器加载字节相同 | 0 | 2.992s | [surface-7fee-web-build.log](surface-7fee-web-build.log) |

558个唯一目标用例逐个含前置、步骤、预期、实际及日志/状态字段，见 [case-matrix.json](case-matrix.json) 与 [case-matrix.csv](case-matrix.csv)。当前desktop113/历史release17/GEO83从原始named logs提取，异步helper/HTTP/runtime/PG/Chromium保留逐例状态；React和server保留完整测试源码用例名+精确选中文件聚合实测，只有verbose日志存在时才引用逐例运行行。便携pair执行8例，复制的ready四例只计一次。此为用例计数，不是expect调用次数或业务样本；重复run不叠加抬高置信度。**[B全量机检/描述性统计；A所列用例合同]**

广域 `packages/base` 原 run：79 files 中 76 pass / 3 fail；1370 tests 中 1355 pass / 8 fail / 7 skip，exit 1，833.144s。失败为 bundles/bundles.test.ts 5 条阈值超时、dev-bridge/dev-bridge.test.ts 2 条阈值超时、post-audio-stems.test.ts 1 条 spawnSync ETIMEDOUT。原阈值下窄复测 bundles 11/11（17.095s）、dev-bridge 30/30（5.633s）、audio 2/2（121.430s），均 exit 0。**原并行 run 仍为失败**；“共享主机资源争用”只是一种解释，未做CPU/I/O/进程归因，不能声称根因已确认。**[B 原失败及窄复測；D 根因解释]** 见 [base-pg.log](base-pg.log)、[base-bundles-single.log](base-bundles-single.log)、[base-devbridge-single.log](base-devbridge-single.log)、[base-audio-single.log](base-audio-single.log)。

官方文档对 testTimeout 与同步子进程 timeout 的说明支持“到达阈值”这个读取方式，不能替代项目根因分析。来源为 [Vitest testTimeout](https://vitest.dev/config/testtimeout)、[Node child_process spawnSync](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)，读取时间为 2026-10-03；本项目实际安装版本由上表元数据冻结，没有依赖“最新版本”推断。**[外部技术事实来源；B日志/D因果]**

继承 root 的 a403 CNB #318 状态回执：static 20.2s、db 37.3s、test 3m14s 均 success；回执 head 为 a403，pipeline statuses.sha 为平台合并试算 SHA a661e9d3378c92bed92099d470cee0613f054670，不能混写成源码 HEAD。独立者没有读取 CNB 凭据或亲自发起 API 调用；见 [evidence__cnb-status-pack-fix.json](../artifact-index.json)（原件未包含，见索引）。这些源码 CI 闸不豁免 final native default 的实际 red，也不证明有正式签名 Release。**[B继承CI元数据]**

历史0f3三闸18.5s/34.2s/3m10s成功（statuses.sha=6ab9b23e87295f4f850168adc136fe490d181833），ad4a三闸20.4s/35.4s/3m12s成功（statuses.sha=01ed0a2c033c381bfc85e328d31eb5ac2944b950）。历史955e回执static18.4s/db32.7s/test3m15s全部success，pull.head/source_head为955e，平台合并试算statuses.sha=8e9169ed1a0f94866c4d0a0213acc772a2a75883；记录时main仍audit基线、PR318 WIP/risk-review且未合并。见 [evidence__cnb-deadline-source-status.json](../artifact-index.json)（原件未包含，见索引）、[evidence__cnb-avatar-source-status.json](../artifact-index.json)（原件未包含，见索引）、[evidence__cnb-welcome-source-status.json](../artifact-index.json)（原件未包含，见索引）。这是root API回执的独立内容/哈希复核，验收者没有CNB凭据/API写操作；不豁免native/正式发布条件。**[B继承CI元数据]**

当前准确接受提交的继承CNB回执三闸均绿：source_head=1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8；平台合并试算statuses.sha=85dd94e78f9da5c85aaf16fc7b98716bf4d3f565；详见 [cnb-dependency-source-1e47.json](cnb-dependency-source-1e47.json)。root执行API，growth_m6核对公开回执内容与SHA；没有凭据读取或API调用。 d6的协议static-gate原失败保留，原因和源码运行断言分别登记，后来的绿不倒改该记录；源码专项结论不豁免受保护合并与正式发布条件。**[B继承CI元数据；D未满足平台条件]**

新版MCD acceptance-role由真实growth_m6会话实际执行，24卡中除MC-106正式平台附条件卡外23卡逐项通过；root先实际完成24卡/38条repair断言，本验收者实际完成23卡/37条acceptance断言，75条唯一run的argv/角色/source/输出SHA已独立回读。来源/逐卡observations见[mcd-acceptance-verification.json](mcd-acceptance-verification.json)。 新MCD执行与本报告已有专项测试分开计数，不以root代写actor、旧结果或结构校验代替真实growth_m6执行；原始台账与历史结果不覆盖。MC-106的本机QA和正式平台条件仍由原生附录逐项判定，未因此豁免未测平台。**[B实际执行/哈希；D尚未执行或正式条件]**

实际严格MCD gate exit0/2.526s、handoff exit0/2.487s；23张closed、MC-106一张open且有明确regression。实际交接单为[handoff.json](../artifact-index.json)（原件未包含，见索引），原输出和bounded-transition复核见[mcd-gate-handoff-verification.json](mcd-gate-handoff-verification.json)。交接仅给dedicated execution-ledger增加handoff和updated_at，cards/assertions/三基线及原始台账/失败结果均未改变；pre/post散列分别记录，原acceptance回读hash仍绑定交接前不可变快照。 **[B实际门禁/交接与逐字段hash复核；D正式平台条件]**

## 24 张排雷卡逐项结论

| 卡 | 原问题/修复合同 | 等级 | 结论与限制 | 实现定位（函数名） | 证据 |
| --- | --- | --- | --- | --- | --- |
| MC-001 | 桌面环境构造引用作用域外的 RUNTIME，首次启动抛异常 | A 源码 + B 实测/机检 | 环境构造不再引用作用域外变量；首启路径、路径带空格/中文的源码合同有断言。a403 实际首装通过，后续渲染门槛另列。 | buildDesktopEnvironment / bootstrap.cjs | surface-7fee-desktop.log |
| MC-002 | 客户端精确依赖锁未随仓库实际依赖更新，载荷门禁失败 | B 依赖图/锁/机检回执 | 仓库精确锁与当前输入一致；三目标原生依赖清单有机检。Windows 实际安装和签名尚未验证。 | .workloom-runtime-deps/metadata.json and precise manifest | mcd-acceptance-verification.json;dependency-1e47-structural-binding.json;locks-parser.json |
| MC-003 | 工作区源码复制进 node_modules 后破坏相对路径与模块单例 | A 源码 + B 实测/机检 | 工作区模块通过保留源目录的桥注册复用同一实例；源码复制不遍历嵌套 node_modules/循环链接，越界与递归目标失败关闭。 | registerWorkspaceModules / copyRuntimeSources | surface-7fee-desktop.log |
| MC-004 | 载荷漏影片辅助模块，备线遗漏种子与白板工具依赖 | A 源码 + B 实测/机检 | 三条装包线的白名单、影片 helper 与构建产物路径已读；真实子进程能导入并运行本地阶段。完整 Windows/应急安装包未运行。 | pack-electron-payload.sh / pack-macos.sh / pack-windows.sh | surface-7fee-desktop.log;film-public-success-results.json |
| MC-005 | 生产环境公共 loginAs 无身份验证，非示例工作区可取得 owner 身份 | A 局部源码 + C 选段 + B 实测 | 真实 production-mode HTTP：匿名非示例 owner 登录 403；匿名受保护路由与坏 JWT 401；可信本机能力只签发服务端已配身份。 | desktop-auth.ts / tenancy/auth.ts / trpc/context.ts; authRouter selected handler | auth-http-results.json |
| MC-006 | 外部动作先执行后授权，审批并发可产生重复副作用 | A 源码 + B 实测/机检 | 动作前授权、单线程认领与一次性执行凭证有实际 DB/计数断言；原批准、并发/重放、末事件失败后重放均受控。外部供应商动作被本地计数器替代。 | runQuest / authorizeToolExecution / gatewayAppend / runQuestForThread | runtime-repro-results.json;gateway-permit-results.json |
| MC-007 | 缺参和低相关性标记跳过全部围栏，人工审批可越过 block 红线 | A 源码 + B 实测/机检 | 缺参/低相关性标记与人工审批不能越过 block；拒绝路径工具调用数为 0。此结论限列明的动作与冻结上下文。 | runQuest fence waterfall and final permit validation | runtime-repro-results.json;gateway-permit-results.json |
| MC-008 | plan_unverified 在存计划之后才标记，重放可绕过未批准的审核 | A 源码 + B 实测/机检 | plan_unverified 先落入存储计划；首跑与重放保持 pending_review，工具调用数为 0。 | runQuest plan persistence and relevance replay | runtime-repro-results.json |
| MC-009 | 编辑后采纳只记录新值，实际工具继续执行原参数 | A 源码 + B 实测/机检 | 编辑后采纳在普通和高风险审批下均实际执行 amount=2，且只执行一次。 | decide / edited plan validation / runQuest | runtime-repro-results.json |
| MC-010 | 把 queued 算进运行并发，十条待办且零运行时队列停滞 | A 源码 + B 实测/机检 | 0 running + 10 queued 不再自锁；全局队列扫描同时处理了原有模拟 T-154/T-155，已披露环境影响。 | sweepQueuedThreads | runtime-repro-results.json |
| MC-011 | 已驳回的 cancelled 线程可被普通 run 重新挂起 | A 源码 + B 实测/机检 | 已驳回 cancelled 线程被普通 run 拒绝；终态不被重新挂起，工具调用数为 0。 | runQuestForThread terminal-state guard | runtime-repro-results.json |
| MC-012 | 驳回记忆 ID 不含工作区，同原因在第二工作区导致审批回滚 | A 源码 + B 实测/机检 | 两个不同工作区按相同原因驳回均成功；记忆键包含工作区，两笔审批都 rejected、线程都 cancelled。 | decide workspace-bound rejection preference memory | runtime-repro-results.json |
| MC-013 | 影片工位子进程缺 TypeScript 加载器，worker 分支仍未接通 | A 局部源码 + C 选段 + B 实测 | 公共 start/status 通过真实 TypeScript 子进程运行 cine-kb/continuity 与冻结输入；缺上游/超时任务保持 failed；新父通道作用域缺口由 13 个控制例封闭。付费生图/生视频能力未验证。 | startFilmJob / handleComponentRequest / FullChainFilmWorker / FilmLedger | film-public-success-results.json;film-public-missing-output-results.json;film-public-deadline-results.json;parent-channel-after-results.json |
| MC-014 | GEO 围栏引用 publish_job，组合对象模型没有该类型 | A 源码 + B 实测/机检 | publish_job 在对象模型内；A-10/B-03/B-04 通过。服务端 5xx 遥测按完整合同识别，原 5 条记录及哈希链保留，补充 GEO 83/83 通过。 | geo-growth/schemas/objects.json and suite-geo.ts | geo-supplement.log;environment-db.json |
| MC-015 | 影片预览建议命令未转义用户字符串，中文路径和分号破坏参数 | A 源码 + B 实测/机检 | POSIX 命令参数中的空格/中文/分号等保持字面值，并提供 PowerShell 表达；实际参数断言通过。 | video.mjs preview command and structured argv | release-video.log |
| MC-016 | Live2D 间接工具链含四个安全公告，需按实际可达面处理 | B 依赖图/registry 回执 | 7fee真实repair audit出现High GHSA-vfj7-8cjw-p6xm，原run仍失败；1e471精确去掉pixi-live2d-display@0.4.0未使用的gh-pages部署依赖边，完整锁/其余输入等价。本轮精确提交实际registry审计为197生产依赖、各级公告0且muted[]，实际run/输出SHA独立读回。旧245/零公告仅历史；未做任意动态加载/利用可达性或未来公告保证。 | Exact pixi-live2d-display@0.4.0 deployment-only dependency removal; actual registry production audit | mcd-acceptance-verification.json;mc016-red-readback-official-7fee.json;dependency-official-provenance.json |
| MC-101 | 修复客户端启动和各载荷工作区模块装配 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | MC-001..004 的源码装配修复已复验；a403 实际首装/重启回执通过。默认渲染失败及后续版本重验仍保留，Windows/正式信任链另有条件。 | MC-001 + MC-002 + MC-003 + MC-004 | surface-7fee-desktop.log;mcd-acceptance-verification.json;dependency-1e47-structural-binding.json;locks-parser.json;surface-7fee-desktop.log;surface-7fee-desktop.log;film-public-success-results.json |
| MC-102 | 封闭生产匿名成员登录与占位签名配置 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | MC-005 的生产匿名登录、可信本机会话与 JWT 拒绝路径已复验，未以浏览器本地持有 token 代替身份检验。 | MC-005 | auth-http-results.json |
| MC-103 | 统一线程认领与外部动作前的权限审批红线检查 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | MC-006..007 的动作前授权、原子认领和 block 红线有实际 DB 状态及独立计数证据。 | MC-006 + MC-007 | runtime-repro-results.json;gateway-permit-results.json;runtime-repro-results.json;gateway-permit-results.json |
| MC-104 | 修复计划持久化审批编辑队列终态与跨工作区记忆 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | MC-008..012 的存储计划、编辑参数、队列并发、线程终态与跨工作区记忆均有原始状态证据。 | MC-008 + MC-009 + MC-010 + MC-011 + MC-012 | runtime-repro-results.json;runtime-repro-results.json;runtime-repro-results.json;runtime-repro-results.json;runtime-repro-results.json |
| MC-105 | 接通影片入口并统一对象语义与安全命令输出 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | MC-013..015 的影片公共入口、本地子进程、对象合同与安全参数输出已专项复验；模型生产产物质量未验证。 | MC-013 + MC-014 + MC-015 | film-public-success-results.json;film-public-missing-output-results.json;film-public-deadline-results.json;parent-channel-after-results.json;geo-supplement.log;environment-db.json;release-video.log |
| MC-106 | 清理间接依赖并完善渲染验收与平台发布硬门禁 | 按所覆盖卡 A/B/C 分别判定；当前Mac QA B，正式平台 D | 依赖公告、渲染冒烟源码与发布失败关闭合同已审阅；17 个假 CNB 发布/参数断言通过。截图前后 DOM、Welcome 终态/响应归属、ready 单次自动打开、缺 runtime 恢复、65 人团队及职场原反例分别独立复验。当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | MC-016 + main.cjs/render-smoke.cjs rendering gate + cnb-desktop-release.mjs publication gate | mcd-acceptance-verification.json;mc016-red-readback-official-7fee.json;dependency-official-provenance.json;surface-7fee-desktop.log;surface-7fee-guide-lifecycle-results.json;release-video.log;inherited/evidence__client-生产修复 首次客户__render-default.json |
| MC-017 | 演示重置在非交互模式绕过确认，未识别客户工作区且缺少删除前备份 | A 源码 + B 实测/机检 | 原8/8反例与dotenv11/12反例保留；准确7fee3a6的12/12重置控制属于desktop113完整套件，不重复计数。非交互须显式确认，生产/远端/未知/非示例工作区拒绝；非空0600备份先于删除，事务重查并发客户，SQL/迁移失败停止。命令为PATH替身，没有真实重置或恢复。seed示例日志与字段默认值的静态差异尚未复现；保留未明确示例工作区的拒绝。 | scripts/reset.sh confirmation / connection target / backup / transaction and scripts/reset-safety.test.mjs | surface-7fee-reset.log;reset-discovery-origin.json;surface-7fee-runtime-lock.json |
| MC-018 | 启动诊断导出遗漏 JSON/连接串秘密，覆盖文件未收紧权限且保存错误逃出恢复流程 | A 源码 + B 实测/机检 | 修复前完整87ab源函数的12项实跑为2通过/10失败；初始夹具1/10、纠正后2/10、另组export0/2及候选正则长串0/1分别保留。准确7fee3a6的12/12合成日志/临时文件控制属于desktop113，也包含于bootstrap60，不重复计数。完整诊断文本中的已列秘密字段、URI用户信息、授权头脱敏，保留主机/版本/错误码；读失败关闭句柄，取消不写，POSIX新建/覆盖文件写前0600，dialog/open/write错误留在恢复页。审计42ead与发现87ab仅两函数字节等价，不改写执行来源。实际安装启动失败页动作区“导出诊断”与macOS原生保存面板已独立核对当前原生回执，详见本地QA附录。字段脱敏不证明任意日志匿名化；Windows ACL未验证。 | apps/desktop/electron/main.cjs diagnosticText / handleSplashAction(export) and bootstrap.test.cjs diagnostic group | surface-7fee-diagnostic.log;diagnostic-discovery-origin.json;diagnostic-official-provenance.json |

MC-106 的依赖图部分为 B；当前原生状态见附录，不能用source_status推导正式全平台客户流程通过。大路由和完整影片脚本只有列明段落为 C；其局部调用链下的 gateway/worker/ledger/procedure 等完整实现为 A，实际 HTTP 与 child-worker 结果为 B。**[A/B/C/D]**

## 19 项附加观察与独立发现

| 项 | 主题 | 证据等级 | 状态/限制 | 来源 |
| --- | --- | --- | --- | --- |
| OBS-01 | Human portrait rejection persists; named CLI denial | A source / B inherited CLI | source verified; inherited CLI executed by root | portrait-decision.ts;inherited/evidence__portrait-cli-production-final-fixed.json;release-video.log |
| OBS-02 | Delivery artifacts require nonempty exact SHA-256 manifests | A | verified | release-video.log |
| OBS-03 | LoomMate narrows and restores automatic-announcement state | A source / C UI sample | source verified; 1440/390 sample does not prove every clickable task | LoomMate.tsx;inherited/evidence__ui-responsive.json |
| OBS-04 | First-day guide exits before native workplace/stage pixel assertions | A source / B helper timing / C inherited native sample | 0f3 bounded guide/deadline controls verified; a403 actual guide race and later 09bc clean avatar failure preserved; Current exact native: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | surface-7fee-desktop.log;surface-7fee-guide-lifecycle-results.json;inherited/evidence__mac-final-default.log;inherited/evidence__mac-guide-clean-default.log |
| OBS-05 | CNB full branch/tag ref binding | A | fake-CNB exact-ref regressions verified; no live public Release was created by this verifier | release-video.log |
| OBS-06 | C-client generated projection matches current UI and bundle digests | B | root machine checks inspected; independent code metadata inspected | inherited/evidence__static-release-production-final.json |
| OBS-07 | Independent parent component method/stage/shot scope gap closed | A | original four allowed reservations reproduced; new thirteen bound-scope controls pass | parent-channel-results.json;parent-channel-after-results.json |
| OBS-08 | Independent never-resolving renderer observation deadline gap closed | A source / B actual asynchronous timing | original 09bc pending probe exceeded configured deadline; 0f3 waits race against remaining deadline and nine independent controls pass | render-guide-probe-results.json;surface-7fee-guide-lifecycle-results.json;surface-7fee-desktop.log |
| OBS-09 | Native-diagnosed Live2D asynchronous ownership and temporary WebGL probe lifecycle | A source / B actual React controls and inherited native diagnostic | ad4a three asynchronous boundaries and stale-model disposal pass four committed plus three independent React controls; capability probe releases its temporary context; Current exact native: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | web-lifecycle.log;web-lifecycle-independent-fixed.log;surface-7fee-desktop.log;inherited/evidence__native-avatar-diagnostic.log |
| OBS-10 | Independent stale scene sample permits an actually covered screenshot | A source / B exact-function clock/page controls | Original seven-pass/one-fail probe accepted the old overlay=false after a 3.6s wait while capture actually saw overlay=true. Exact-source counterexample now rejects; before/after-capture DOM assertions and eight original controls pass without threshold relaxation. | render-guide-transient-results.json;surface-7fee-guide-transient-results.json;surface-7fee-desktop.log |
| OBS-11 | Independent welcome terminal-write and ready-edge reopen races | A source / B actual React and PostgreSQL | Original actual-hook four cases had one reopen failure; actual PG five cases had two completed-to-nonterminal regressions. Original four/five controls, four new welcome response-ownership cases and eight committed server cases pass at the exact fix. Terminal saves append no fake after events; only explicit replay clears completion. Native original guide failure is not causally attributed from these fixture results. | questline-ready-before.log;questline-ready-after.log;welcome-progress-before-results.json;welcome-progress-after-results.json;welcome-client-after.log;welcome-server-after.log |
| OBS-12 | Same-version install sentinel cannot skip missing runtime recovery | A source / B actual filesystem failure-injection controls | Actual required runtime/Node/PG/client entry existence and runtime version now participate in staging. Three missing/version cases enter atomic recovery; injected failure retains the original database/config/sentinel and removes temporary directories/lock. Exact final native recovery/restart is a separate platform gate. | surface-7fee-desktop.log;bootstrap.cjs;bootstrap.test.cjs |
| OBS-13 | 65-person team density and long-label content overflow | A source / B actual Chromium geometry / C four screenshots | The first rectangle-only probe passed but visual review found seven long names at each width with scrollHeight48/clientHeight35. The stronger content-overflow expectations passed after max-content rows and nonshrinking labels. The first frozen-source run was three-pass/one-fail because the 390-width ready selector exceeded 15s; that original result is retained. An identical-script repeat at the original navigation90s/ready15s thresholds passed all four cases at955e and preserves all65 actors/labels, no label/text/page overflow, reachable last actor, 14-person fallback and no errors/external requests. Timeout cause is unproven; desktop fixture is not a real phone or cold native proof. | ceremony-density-text-before-results.json;ceremony-density-final-results.json;ceremony-density-final-repeat-results.json;density-source-history.json |
| OBS-14 | Canvas physical label/actor allocation, production CSS coordinates and initial visible viewport | A full source / B actual native Canvas/TextMetrics, physical clicks and real scroll / C screenshots | Original 955e labels/profile counterexamples, the production-CSS physical click failures and aad blank initial viewport remain immutable. Final acceptance uses actual production CSS, measured native paths/glyphs, true mouse callback deltas, first painted frame, all65 actors, task-card corners, Unicode title, wheel/poll/resize controls. No-CSS greens are limited fixtures; raw native-coordinate outside lists do not prove physical out-of-screen actors. Observer corrections retain original expectations and evidence. | floor-final-verification.json;floor-canvas-source-history.json;floor-production-css-correction.json;floor-css-coordinate-observer-correction.json;floor-browser-first-paint-observer-correction.json;floor-canvas-initial-viewport-production-results.json;floor-canvas-scroll-trace-results.json |
| OBS-15 | 3D projected bodies and HTML labels, actual profile/task clicks and optional drop branch | A full selected product implementation / B actual WebGL/DOM Range/projection/physical clicks / C screenshots | Frozen original955e productionCSS 28 controls were 6pass/22fail. Final controls use imported product R3F/Drei/avatar/cinematic and actual camera/GazeRegistry/DOM; no layout, target, camera or hitbox algorithm is copied. Default and optional enabled onDropTask branches are distinct; current P0 does not pass onDropTask and the supplemental branch is not a business task dispatch. Original observer and harness failures are preserved, not relabeled as product results. | floor-final-verification.json;floor3d-production-before-corrected-results.json;floor3d-source-history.json;floor3d-harness-live-correction.json;floor3d-drop-observer-extension.json |
| OBS-16 | Actual Stage Canvas height and native capture-time geometry gate | A complete Stage/main/test source / B actual browser and exact-function failure controls / C current screenshots | The original c083 lower-scene cutoff, production-CSS150/440px counterexample and failed observer controls remain preserved. Retained7fee Stage/CEO7/7 was actually reexecuted, not inherited after the Stage floor geometry changed. Current desktop113, capture8 and bootstrap60 also retain their actual7fee execution SHA; bootstrap is counted inside desktop. Final packaged cold-native proof has now passed the separately recorded actual local QA gate. The described desktop113/capture8/bootstrap60/product36/Stage7 executions occurred at7fee; at the accepted dependency-only commit their complete effective source/input contract is inherited through the strict separate comparison. No raw wrapper argv/time/source field or screenshot execution origin was rewritten. Exact new .6 native and actual MCD roles remain separate gates.; Current exact native: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | scene-f0-historical-red-origin.json;scene-f0-layout-results.json;floor-final-verification.json;surface-7fee-desktop.log;surface-7fee-native-observer.log;surface-7fee-guide-transient-results.json;scene-f0-screenshot-review.json;floor-native-c083-screenshot-review.json;surface-7fee-layout-results.json;surface-7fee-screenshot-review.json |
| OBS-17 | Connected Fiber HTML portal includes the actual CEO plaque in label separation | A complete Labels/test and actual caller/dependency source / B imported production-CSS scene and React tests / C current screenshots | The actual connected-Fiber-portal failure and original18-worker CEO overlap remain preserved. Retained7fee selected product36/36 includes the original34 floor/label/task-drop controls plus two Stage surface geometry cases; retained7fee Stage/CEO7/7 was actually reexecuted. Prior148 Floor3D body/plaque/drop/hover/safety controls keep their actualf0a source and exact unchanged closure;45 Canvas controls keep their actuald6 source. Static samples and pointer fixtures do not establish full UX or all native hit targets. The described desktop113/capture8/bootstrap60/product36/Stage7 executions occurred at7fee; at the accepted dependency-only commit their complete effective source/input contract is inherited through the strict separate comparison. No raw wrapper argv/time/source field or screenshot execution origin was rewritten. Exact new .6 native and actual MCD roles remain separate gates.; Current exact native: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | scene-f0-historical-red-origin.json;surface-7fee-product-test-results.json;scene-f0-layout-results.json;floor-final-verification.json;scene-f0-screenshot-review.json;floor-native-c083-screenshot-review.json;surface-7fee-layout-results.json;surface-7fee-product-test-results.json |
| OBS-18 | Actual native Stage floor coplanar depth conflict and minimal vertical separation | A complete Stage/test/cinematic and direct source closure / B actual geometry and current production-CSS Stage controls / C four controlled pixels and original native image | Original f951 v.4 default/safe exited0 but the actual default Stage PNG contained large torn black/blue fragments; safe vector2d cannot clear default3D. The root before/after browser control used identical fixture/CSS/camera/actors and changed only the reviewed Theater base height, from cap=-0.02 to cap=-0.05 below reflector=-0.02. Original valid day/night geometry2/2 failures and the limited first observer error remain separate. The two actual7fee geometry cases plus7fee Stage/CEO7/7 passed; both minimal after pixels are clean in the reviewed frames. The original run stays f951, the root dirty counterfactual is not relabeled to the accepted commit, and newly packaged cold-native samples have now passed the separately recorded actual local QA gate. The described desktop113/capture8/bootstrap60/product36/Stage7 executions occurred at7fee; at the accepted dependency-only commit their complete effective source/input contract is inherited through the strict separate comparison. No raw wrapper argv/time/source field or screenshot execution origin was rewritten. Exact new .6 native and actual MCD roles remain separate gates.; Current exact native: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | stage-surface-source-review.json;stage-floor-counterfactual-pixel-review.json;stage-floor-official-provenance.json;floor-native-f951-screenshot-review.json;surface-7fee-product-test-results.json;surface-7fee-layout-results.json |
| OBS-19 | New production audit High advisory reopens MC016; exact unused deployment edge removed | A complete local manifest/diff / B whole dependency metadata and actual registry run / D arbitrary dynamic behavior or future advisories | The actual7fee repair run MC016 failed on High GHSA-vfj7-8cjw-p6xm via live2d>gh-pages>globby>fast-glob>micromatch>braces3.0.3; the old245 zero-audit result did not supersede it. The exact0.4.0 selector removes the unused upstream deployment edge, without an install hook, mute, threshold relaxation or changes to peer/runtime package artifacts. Complete importers/packages/integrities/other snapshots and134 desktop npm-lock bytes are equal. Actual current-source registry metadata197/zero/all-severities/muted[] has now been independently hash-read back from real MCD runs. All558 functional case executions retain their original source and are inherited only for the strict reviewed effective inputs. New .6 app/payload/DMG, current CI and actual repair/acceptance roles are distinct gates; no arbitrary exploit-reachability claim. | mc016-new-high-advisory-red-review-7fee.json;mc016-red-readback-official-7fee.json;dependency-1e47-structural-binding.json;dependency-functional-input-inheritance.json;dependency-official-provenance.json;mcd-acceptance-verification.json |

独立编号保持稳定；root台账新观察为OBS07..23，具体映射如下，见 [observation-mapping.json](observation-mapping.json)。同数字不自动代表同主题，root额外两项已纳入MC003/MC014合同，并未漏验。独立OBS14涵盖rootOBS16的Canvas/CSS/首帧定位，独立OBS15涵盖rootOBS17的3D；独立OBS16/17分别涵盖rootOBS18的Stage高度与rootOBS19的CEO portal边界；新增独立OBS18对应rootOBS22的舞台地面最小几何修复，原运行、dirty对照与当前接受SHA分开登记。独立OBS19对应rootOBS23，重新打开既有MC016的新High公告与精准部署依赖删除，不新增MC019卡。**[B范围映射]**

| root台账编号 | 独立报告引用 | 主题 |
| --- | --- | --- |
| OBS-07 | OBS-07 | Parent component method/stage/shot binding |
| OBS-08 | MC-003 | Source-copy exclusion of developer dependencies |
| OBS-09 | MC-014 | Complete server telemetry exception contract |
| OBS-10 | OBS-04, OBS-08 | Delayed guide mounting and remaining renderer deadline |
| OBS-11 | OBS-09 | Live2D unmount ownership and temporary WebGL release |
| OBS-12 | OBS-10 | Scene screenshot capture-time DOM state |
| OBS-13 | OBS-11 | Welcome terminal-write, stale-response and ready-edge races |
| OBS-14 | OBS-12 | Same-version missing-runtime recovery |
| OBS-15 | OBS-13 | 65-person team grid and long-label overflow |
| OBS-16 | OBS-14 | Canvas labels, production CSS coordinates and initial visible viewport |
| OBS-17 | OBS-15 | 3D projected label allocation, physical body/plaque clicks and optional drop branch |
| OBS-18 | OBS-16 | Stage collapsed Canvas height and actual native capture-time geometry |
| OBS-19 | OBS-17 | CEO plaque collision through the actual connected Fiber HTML portal |
| OBS-20 | MC-017 | Confirmed local example reset, private backup and transactional customer recheck |
| OBS-21 | MC-018 | Diagnostic field redaction, private export and startup-failure-page recovery |
| OBS-22 | OBS-18 | Native Stage floor coplanar depth conflict and minimal vertical separation |
| OBS-23 | MC-016, OBS-19 | New High production advisory and exact unused live2d deployment-dependency removal |

新 OBS-07 在原 040 的 source-faithful handler probe 中，四种伪绑定可先创建组件预占：image 请求伪装 cine-kb、video 伪装 plates、镜头后缀错绑/缺失。provider key 清空、fetch 禁用，networkCalls=0。root 增加 method/stage/shot/project 冻结合同检查后，13 个正/反控制例通过；伪请求在预占前失败，合法 image 对照只到达 PROVIDER_UNCONFIGURED。原红证据 [parent-channel-results.json](parent-channel-results.json) 保留，修复后 [parent-channel-after-results.json](parent-channel-after-results.json) 与源码 `handleComponentRequest`/scope validation 分别给出独立状态与实现依据。此处只是所列合同已封闭，不能称整个影片生产链无可利用缺陷。**[A源码+B实际状态；完整影片其他分支C]**

最初 GEO 78/81 失败于 E-01..03：原系统错误事件的 receipt/model_trace 为空且 actor=system/object=server_request，没有被 suite 识别为合法服务端 telemetry。补充检查使用明确 type/action、作用域、完整 after 字段及无外部工具/receipt/modeltrace 的系统5xx合同，含系统名伪装行业动作/外部动作/错作用域的反例；新增 E-07/E-08 后 83/83。原 5 条事件及链不删除，原 78/81 结果 [geo.json](geo.json) 与失败记录 [geo-failed-records.json](geo-failed-records.json) 均保留。**[A server index+suite合同；B DB及补充suite]**

独立新增 OBS-08：09bc 的循环虽检查截止，却直接 await renderer probe；20ms配置下的永不返回探针在外部156ms watchdog时仍pending。此为一个失败控制，原结果中的观察与assertion两行不可算两个独立样本。0f3每次probe用剩余截止Promise.race，清理timer并拒绝晚到状态；独立9/9控制通过，原hung控制在21ms返回closed=false。见 [render-guide-probe-results.json](render-guide-probe-results.json)、[render-guide-bounded-results.json](render-guide-bounded-results.json) 与 [desktop-final.log](desktop-final.log)。源码完整精读，实际异步返回有原始时序，未扩大10s产品默认阈值。**[A源码+B实际异步控制]**

OBS09由root真实09bc诊断的null appendChild引出。ad4a在插件import、model.from、初始expression三个await边界后检查disposed；未加入stage的迟到模型主动destroy。独立执行提交内4个实际React/jsdom控制（import退出、late model、expression退出、正常ready），另写3个实际组件控制（双core未加载就退出、size变化与late model交错、frame变化与旧expression交错），全部通过。新组件保有唯一active画布/ready，旧实例不补注册动作/时钟。desktop82含临时WebGL释放和失败控制；主smoke缓存布尔能力，不在每轮重新建GPU上下文，原60s/10s产品截止未变。Pixi/voice为本地替身，这组证明异步组件合同，不替代真GPU或正式client冷启。见 [web-lifecycle.log](web-lifecycle.log)、[web-lifecycle-independent-fixed.log](web-lifecycle-independent-fixed.log)、[desktop-lifecycle.log](desktop-lifecycle.log)。root原4例中的3条失败与修复4/4见继承red/green；独立的4+3是另次执行。**[A源码+BReact/命令；D最终native]**

临时上下文使用 `WEBGL_lose_context` 的行为依据 [Khronos 扩展规范](https://registry.khronos.org/webgl/extensions/WEBGL_lose_context/)；独立harness首错误修复采用精确alias匹配，依据 [Vite resolve.alias](https://vite.dev/config/shared-options.html#resolve-alias) 对正则规则和匹配顺序的说明。二者均在本轮读取；本项目实际源码调用和测试结果单独由上述 A/B 证据支持。**[官方技术来源；不替代运行证据]**

OBS10（root OBS12）原反例：最初DOM状态overlay=false，等待3.6s时页面重新被引导覆盖，旧函数仍采纳最初状态而接受截图。原8例7绿1红的clock/page结果保留；955e在截图立即前后分别取真实DOM状态，拒绝旧状态和拍摄期间重新覆盖，原8例全部通过，产品截止没有放宽。见 [render-guide-transient-results.json](render-guide-transient-results.json)、[render-guide-transient-after-results.json](render-guide-transient-after-results.json)。这是验收器假绿缺陷，不将它当作原真机guide未关闭的因果证据。**[A精确函数源码+B实际反例/时钟控制]**

OBS11（root OBS13）有两个独立原失败：实际React hook原4例3绿1红，用户关闭后ready=false→true重新打开；真实PG原5例3绿2红，completed/done后旧in_progress/paused覆盖了已完成行、清空completed_at并令shouldShow=true。955e增加每次挂载只自动打开一次、客户端保存序号/终态意图/卸载归属、服务端completed终态SQL条件。原4/5反例、4个新增welcome请求时序控制、8个已提交unit/PG合同均通过；重复/迟到completed不增加假进度或第二次完成事件，明确replay仍可重新开始。见 [questline-ready-before.log](questline-ready-before.log)、[questline-ready-after.log](questline-ready-after.log)、[welcome-progress-before-results.json](welcome-progress-before-results.json)、[welcome-progress-after-results.json](welcome-progress-after-results.json)、[welcome-client-after.log](welcome-client-after.log)、[welcome-server-after.log](welcome-server-after.log)。**[A完整hook/service/SQL及直接依赖+B实际React/PG]**

OBS12（root OBS14）来自自有QA cache清理：保留support VERSION却删除runtime时，旧同版本sentinel直接跳过组装，随后读runtime/VERSION失败。新bootstrap在跳过前同时检查实际runtime版本与必需Node/PG/tsx/vite/helper/defaults，3种缺失/版本控制进入原子恢复；故障注入保持原DB/config/VERSION/.bootstrapped并清理锁/暂存目录。87desktop包含这个真实文件系统恢复测试；它证明所列rollback合同，精确新native恢复和升级仍为另一条平台门槛。见 [desktop-welcome.log](desktop-welcome.log)、[evidence__desktop-recovery-marker-before.json](../artifact-index.json)（原件未包含，见索引）、[evidence__desktop-recovery-marker-after.json](../artifact-index.json)（原件未包含，见索引）。**[A完整bootstrap+B实际FS故障注入；D完整native]**

OBS13（root OBS15）先用rectangles机检4/4，却在四图目视看到长岗位名画出框外；加强scrollHeight/clientHeight与scrollWidth/clientWidth后，两宽各7处溢出，原2绿2红保留。增加max-content行和不压缩的avatar/label后，同源同内容通过。精确955e首次run仍3/4：390实际ready selector在15s超时；同脚本原90s导航/15sready阈值复测72.738s、4/4，两个宽度均65actor/65label、零文字/标签/页面溢出、末项可见、region可聚焦、14人原布局与零pageerror/外网请求。四张复测图已逐一目视审阅。原red不改写，“共享资源导致”没有性能归因，只能为D推断；桌面窄视口不是真手机。见 [ceremony-density-text-before-results.json](ceremony-density-text-before-results.json)、[ceremony-density-final-results.json](ceremony-density-final-results.json)、[ceremony-density-final-repeat-results.json](ceremony-density-final-repeat-results.json)、[density-source-history.json](density-source-history.json)。**[A组件及依赖+B几何/原阈值实跑+C四图；D原超时根因]**

[Playwright官方locator.waitFor说明](https://playwright.dev/docs/api/class-locator#locator-wait-for)支持“等待给定状态至timeout”的解释；本轮读取原文核对默认visible状态及显式timeout。它说明此处15s确实是该API等待阈值，不能替项目判断组件定时器/浏览器/主机资源的根因。**[官方技术来源；B本地日志/D因果]**

OBS14（rootOBS16）原955e Canvas两种独立观察器分别为6/24和7/24，均复现18人名牌/字形重叠及档案误选。使用真实生产CSS后，最初raw-native坐标观察器为19/24；其中outside仅表示native绘制坐标与CSS矩形基准不一致，不能当成相同数量的角色实际出屏。保留原结果并将原生绘制点映射到真实CSS坐标，旧7d仍20/24：idle390仅4/18、asking9/18、blocked5/18、working3/18正确档案；这是实际物理点击反例。最终用相同测量与真实鼠标回调增量验证人物与字形分离、整卡点击、Unicode悬停、65人首帧与真实滚动。**[A源码+B实际native/CSS/鼠标；C截图]** 见 [floor-canvas-production-before-results.json](floor-canvas-production-before-results.json)、[floor-canvas-production-physical-before-results.json](floor-canvas-production-physical-before-results.json)、[floor-final-verification.json](floor-final-verification.json)。

该修复的aad阶段初始视口仍6/7：65idle390首帧有65名牌却没有一张可见，region358×380、layout1590×1686、scroll0/0。原生setter委托追踪记录期望653/362.5而实际0/0，随后Canvas bitmap改变，microtask仍是旧extent。root同源CSS最小DOM诊断和过渡关闭对照分别保留，不替代产品验收；d6同一7例实跑已7/7，390桌面窄宽首帧26张可见、653/363，1440桌面28张可见、760/437，真实滚轮后的poll/resize保持位置。前两次boundary首帧的CSS检查观察器问题也保留12/14原回执；当前观察器在同一受控产品绘制帧经过native浏览器截图提交后取DOM值，必须断言没有额外产品RAF帧，原65逐人鼠标断言没有删除。**[A几何容器即时更新+B原生trace/实际首帧；D未测平台因果]** 见 [floor-canvas-initial-viewport-production-results.json](floor-canvas-initial-viewport-production-results.json)、[floor-canvas-scroll-trace-results.json](floor-canvas-scroll-trace-results.json)、[floor-browser-first-paint-observer-correction.json](floor-browser-first-paint-observer-correction.json)。

[W3C CSS Transitions的transition-property定义](https://www.w3.org/TR/css-transitions-1/#transition-property-property)说明初始值为all，none排除属性过渡，过渡中读取的计算值可能是中间状态；本轮读取原文。实际0.01ms规则和产品滚动先后来自所读源码与上述真实浏览器回执，规范本身不证明某次产品失败。**[官方技术来源；A/B本地证据分别列明]**

OBS15（rootOBS17）原955e在真实生产CSS下28例6绿22红；原生HTML/Range名牌重叠和误点均实际复现。d6改了投影名牌但默认28仍26绿2红：idle390实际actor09命中plaque05→profile05等五处，working1440实际本体点被任务名牌截获，仅7/18正确档案；可选onDropTask原28为24绿4红，72×96透明锚点例如01→drop04→profile04、asking02→drop10。所有名牌布局与名牌点击当时已绿，不能据它们冲销本体误选。两个d6原red完整保留，交给独立于验收者的修复会话；最终控制仍保留每一条原28要求。**[A完整Floor3D/labels/allocator/TaskDrop源码+B实际elementFromPoint与回调；C图]** 见 [floor3d-production-final-results.json](floor3d-production-final-results.json)、[floor3d-production-drop-final-results.json](floor3d-production-drop-final-results.json)。

最终职场运行的源码继承与额外drop合同以 [floor-final-verification.json](floor-final-verification.json) 为准。每个运行组保留其实际执行SHA，后续文档提交只在祖先及相关源、依赖和CSS字节相等时继承；没有把旧命令改名成在新SHA重新执行。可选drop实际浏览器DataTransfer/DragEvent控制若执行，使用真实物理目标的elementFromPoint与原生构造器，但事件为synthetic dispatch，不能写成OS拖动、服务端派单或经营产物。P0当前没有传该prop；它属于已有组件能力的附加边界。所有无生产CSS夹具的历史绿仅为有限诊断，所有harness编译/alias/path/坐标修正均保留，零产品用例的harness失败不计为产品失败用例。**[B执行/哈希；D未测OS/经营；A接口边界]**

五组原有实际Floor3D浏览器控制的执行SHA为f0a11286a49419fb7909088e2d170f4dde7b60c6；Stage/CEO7的实际执行SHA为7fee3a6a5563d41c568463994764d3883eb7667d。6个所选产品文件、36例在实际7fee执行、按明确有效输入继承到本轮接受源码，保留Floor/Canvas组只按明示完整闭包字节继承。实际构建以[surface-7fee-web-build.json](surface-7fee-web-build.json)绑定，CSS与原139675B相等。当前36张图的阅读/原执行归属见[surface-7fee-screenshot-review.json](surface-7fee-screenshot-review.json)；32张未变Floor图保持原执行/阅读来源，4张Stage/Floor图在7fee实际运行后直接审阅、保留原执行提交；没有制造新的历史Floor截图。窄窗口和65人职场按内部滚动展示局部，不能从单图宣称全部同时可见。长气泡可能覆盖自己的名牌；完整气泡/字形可见交集有实际DOM/Range断言，完整打扰协议未测。**[B逐组实际执行/完整输入与构建；C逐张图；D真手机/完整体验]**

独立安全负例探针首次在浏览器执行前因 string alias 把 three/examples 子路径接到模块文件而失败，原脚本、argv、日志与退出码保留。仅改为精确全名正则别名后，实际中文回退3项通过；没有改产品语言策略、预期或时限。确切安装版本的 [Vite v8.3.0 resolve.alias 文档](https://github.com/vitejs/vite/blob/v8.3.0/docs/config/shared-options.md#resolvealias) 支持正则别名配置，直接本机错误与调用代码才是本次原因依据。来源、失败与修正分别见 [floor-c083-safety-alias-correction.json](floor-c083-safety-alias-correction.json)、[floor-c083-safety-final-provenance.json](floor-c083-safety-final-provenance.json)。报告 manifest 最初误写 useQuestline 的目录而在历史 Git guard 处停止；纠正为真实 onboarding 两个文件后仍完整比较相同合同，没有省略 guard，见 [floor-c083-manifest-path-correction.json](floor-c083-manifest-path-correction.json)。**[A探针/调用合同；B原失败与实际复测；外部官方配置事实]**

另外执行65人idle390/working1440、18人queued390/collab1440，以及新poll对象/逆序、resize、真实wheel相机变化、全员disabled后的命中/投递清除合同；短中文与合法长中文/Unicode气泡在1440/390分别检查真实hover触发、Range行数、内容溢出与身体指针可达。合法中文组保留原29项并新增4项完整气泡/每个字形在Canvas、滚动区与视口交集内的断言，共33项；等待真实computed visibility可见，没有只按宽高写绿。原未经登记English/camel状态字符串与预期原样显示的诊断不作为产品缺陷；两宽实际中文安全回退另成独立3例负例组，原稿与原结果保留。新增观察脚本源自已授权fresh fixer，全文核对后改own路径、隔离端口和结果归属；另记录真实event.isTrusted并加false断言，由growth_m6独立执行。其代码来源不冒充独立原创。原28/55要求与产品算法均未替换，实际组数/逐例结果见manifest，来源与原稿SHA见 [floor3d-supplement-observer-provenance.json](floor3d-supplement-observer-provenance.json) 和 [floor3d-drop-trust-observer-extension.json](floor3d-drop-trust-observer-extension.json)。**[A产品合同；B实际独立执行/脚本来源；C所读图；D真手机/完整UX]**

[WHATWG DOM的Event.isTrusted说明](https://dom.spec.whatwg.org/#dom-event-istrusted)与[HTML DragEvent处理模型](https://html.spec.whatwg.org/multipage/dnd.html#the-dragevent-interface)在本轮读取：脚本dispatchEvent的事件为非trusted，浏览器实际拖放还有其协调的处理与安全模型。本地控制逐条记录实际isTrusted=false；因此可证明React/DOM投递处理合同，不能推导已完成OS手势或真实业务派单。**[官方技术来源；B事件与回调；D未执行模型]**

OBS16/17（rootOBS18/19）来自c083 v.3真实冷default/safe。两条命令分别exit0/61.780s和exit0/56.198s，ready/guide/65team断言满足，但独立直接查看8张原生PNG仍看到Stage下部平黑与CEO名牌交叠，因此 [floor-native-c083-screenshot-review.json](floor-native-c083-screenshot-review.json) 保持blocking_visual_observations非空、localQAfalse。原生绿退出码不能覆盖像素red。root随后用真实生产CSS的进口组件重现：两宽Stage实际Canvas150px/region440px、职场CEO与员工16/18交叠；原layout3绿4红、portal2绿1红、截图观察器4绿2红均以原bytes保留，见 [scene-f0-historical-red-origin.json](scene-f0-historical-red-origin.json)。初次缺CSS的结果只作有限证据，路径allow修正没有改产品或原阈值。**[B继承原生/组件实跑；C原8图；A当前Stage/Labels/main完整源码]**

当前Stage明确440高度，CEO查询包含真正scene边界内的Fiber connected Html portal。Stage/CEO7/7在7fee3a6a5563d41c568463994764d3883eb7667d实际运行；准确7fee3a6的产品36/36、desktop113/113与capture8/8实际通过，bootstrap60是desktop子集。截图前后都检查实际Canvas/region/live-context和CEO碰撞；mouth/blink/gesture后经现有“收起为小球（不挡界面）”DOM处理LoomMate遮挡，不称OS手势。4张Stage/Floor图在7fee直接审阅、按有效输入合同继承，旧f0a Stage图及v.4碎裂原图仍保留，不能按旧Stage hash继承当前行为。实际两宽440填充及CEO分离不等于完整用户旅程；精确新app冷native另验。依赖portal实现已读取确切安装版本的[Drei Html源码](https://raw.githubusercontent.com/pmndrs/drei/v10.7.8/src/web/Html.tsx)及[React Three Fiber Canvas源码](https://raw.githubusercontent.com/pmndrs/react-three-fiber/v9.7.0/packages/fiber/src/web/Canvas.tsx)。**[A完整源码；B准确实跑/输入归属；C四图；D完整体验]**

OBS18（rootOBS22）由独立审阅真实f951 v.4默认原生舞台PNG发现：当次default/safe均exit0，但默认3D地面有大块黑蓝碎条与横向撕裂，vector2d安全模式没有该地面、不能冲销默认模式的像素red。8张原图及原回执保留在[floor-native-f951-screenshot-review.json](floor-native-f951-screenshot-review.json)。原源码CineFloor y=-0.02与Theater圆柱中心-0.09、高0.14使上顶盖名义y=-0.02；root最小前后对照仅把中心降到-0.12，顶盖=-0.05，与反射面相隔0.03，其他camera/actors/rig/CineFloor/CinePost/CSS与fixture保留。独立逐张看before/after×1440/390，before两宽碎裂、after两宽该大块碎裂消失；四图与原dirty运行归属见[stage-floor-counterfactual-pixel-review.json](stage-floor-counterfactual-pixel-review.json)，after的HEAD仍f951+未提交源，未改写成当前接受SHA。原首观察器误把光柱openEnded boolean当数字的0/2只是有限harness失败；纠正后原真实SSR day/night二例在原几何下2/2失败，几何/发现证明见[stage-surface-source-review.json](stage-surface-source-review.json)。准确7fee3a6新增真实Stage→Theater→CineFloor及实际Three CylinderGeometry的day/night两例、Stage/CEO7与完整所选产品36例已实跑通过。新native图和pack字节仍按实际本地QA附录另验；源码/浏览器绿不覆盖原v.4像素red。**[A完整源码与调用/几何；B实际源/SSR/浏览器合同；C四张最小对照及原8图]**

确切Drei v10.7.8 [MeshReflectorMaterial源](https://raw.githubusercontent.com/pmndrs/drei/v10.7.8/src/core/MeshReflectorMaterial.tsx)的反射pass只暂时隐藏自身parent再渲染scene，没有移除这个其他圆柱；[Three.js官方相机手册](https://threejs.org/manual/pages/cameras.html)说明有限深度精度可能无法稳定决定近表面的前后。原文、已读范围与SHA见[stage-floor-official-provenance.json](stage-floor-official-provenance.json)。这些官方行为为机制依据，本次实际最小几何对照与原始pixels才定位这个修复点，不据文档推导所有GPU/相机永无深度冲突。**[官方主来源；A/B/C本机证据分列]**



诊断导出MC-018（rootOBS21）原完整87ab运行以最终12断言重放，实际2绿10红；原audit42ead仅diagnosticText与handleSplashAction函数字节与87ab相等，整文件不同，独立Git证明与原执行归属见[diagnostic-discovery-origin.json](diagnostic-discovery-origin.json)。初始null夹具纠正、另组export0/2和候选长串正则0/1均各自保留，没有写成原源码同一次失败。准确7fee3a6的12/12合成日志/真实临时文件控制覆盖引号/转义字段、连接URI与授权头、200KB有界文本及错误上下文、读失败关闭句柄、取消不写、新建/覆盖权限和保存故障。它们包含于desktop113及bootstrap60，不重复增加分母；执行凭据为[surface-7fee-diagnostic.json](surface-7fee-diagnostic.json)、[surface-7fee-diagnostic.log](surface-7fee-diagnostic.log)。实际客户端门槛是启动失败页动作区的“导出诊断”链接与macOS原生保存面板，不能将源码VM控制说成已操作系统菜单或已完成真实GUI导出。当前GUI状态另见原生附录。**[A完整源码；B原始运行/函数字节/临时文件权限；C真实4PNG；B实际GUI/公开导出和0600；D完整UX与WindowsACL]**

Node确切v24.19.0官方[fs API文档](https://github.com/nodejs/node/blob/v24.19.0/doc/api/fs.md#fswritefilesyncfile-data-options)说明writeFileSync的mode只作用于新建文件；fchmodSync作用于打开的描述符，已分配描述符需及时关闭。因此覆盖旧文件的权限与finally清理要由实际源码和控制例证明。文档原文件与已读API行段/哈希见[diagnostic-official-provenance.json](diagnostic-official-provenance.json)；只读这四个API段，不宣称整篇文档语义精读，官方行为不替代本机测试。**[官方技术事实来源；A/B本地合同分列]**

当前准确安装包的真实失败页由root以空QA Resources触发，实际CUA导出动作→macOS保存面板→Cancel→再次保存→实际Replace确认→同支持参考恢复页→安全退出，runner exit0/374.362s。9项实际GUI/导出断言、10份完整AX状态与4张直接查看的原PNG见[native-dependency-diagnostic-export-independent-review.json](native-dependency-diagnostic-export-independent-review.json)及[native-dependency-diagnostic-screenshot-review.json](native-dependency-diagnostic-screenshot-review.json)；导出1062B合成诊断，10个秘密字段值缺失、3个中文/阶段/错误码上下文保留，原0644目标在取消后bytes/hash/mode不变，真正覆盖后本验收者实际stat为0600并与公开文本全字节比对。源码12例、真实GUI9例与截图C证据各自登记，9例不叠加到源码专项用例分母。legacy actual_native_menu字段仅代表失败页动作，未声称操作macOS系统菜单；真实成功retry及GUI保存故障未执行，故障恢复只由源码控制支持。**[B实际GUI回执/公开文本与模式；C四图；D完整UX/WindowsACL]**

## 原生包附录（本地 QA 已复验；正式平台条件保留）

当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 当前验证元数据为 [floor-native-verification.json](floor-native-verification.json)；原生执行者为root，本验收者只独立复核回执、截图、私有状态的哈希/权限元数据和实际安装字节。未打开私有配置或数据库内容，也没有把root执行写成独立执行。**[B实际产物/回执；C截图；D正式平台条件]**

历史7fee3a6/.5包的首次无CDP默认冷启动实际exit1/56.336s：Live2D/avatar已ready，mouth0.45、blink1、gesture1、写失败0与65人团队已记录，但原JSON没有firstDayGuide/workplace/reportStage字段，也没有Stage图。原wrapper/log/JSON与两PNG共6份保持原SHA，原字段没有补写sourceSHA；执行源码归属由root准确包回执及当时明示绑定，见[native-surface-default-original-red-review.json](native-surface-default-original-red-review.json)。命令日志未保存具体异常原因，network service restart与磁盘压力均没有被证明为唯一根因，该原run保留失败。同一包后来在全新空support、原截止时间与原断言下另跑default-repeat62.780s和safe65.681s均exit0；成功默认控制明确选择mac-surface-default-repeat.json及对应render/retention，没有倒改mac-surface-default.json。本验收者直接看完这两次的8张原PNG，默认Stage地面大片黑蓝碎裂已消失、440场景填充与CEO牌分离见[floor-native-surface-screenshot-review.json](floor-native-surface-screenshot-review.json)；安全模式首张PNG只采到中间过渡点，不能据它声称opening vector人物已完整呈现，vector telemetry与后续2D场景另作B级证据。图样本不证明完整opening时序、全部GPU或完整UX。**[B继承实际命令/状态与独立文件hash；C直接8图及原2图；D首红因果/完整体验]**


独立实际读取当前0.1.0-fix.20261003.6安装应用：4条CJS与准确Git源相等，app.asar SHA256=68f4c953a300237a55ceedb0e0dc7c77f361c581cbac046aed8a49431471706c；完整压缩payload 500741404B、SHA256=89d813bd9bee83c7471b623dbb43c7c9d702afa78e3fe06bcf94adec02a33a53。实际流读2093个声明对应文件，其中2021条与不可变Git blob直接比对、72条与实际当前构建输出及原root闭包回执比对，0差异；另14237条runtime常规文件没有逐内容hash，不作全runtime语义通读主张。DMG 630770886B、SHA256=91190f08bc8c0db9dddbe2946e0a7bbc179d00f4e0988494d6ecd2f861f17397，独立hdiutil verify、只读mount及实际asar/payload/version/codesign一致检查均通过，挂载已卸除、挂载应用未启动。见[dependency-final-app-byte-probe-results.json](dependency-final-app-byte-probe-results.json)、[dependency-final-payload-byte-probe-results.json](dependency-final-payload-byte-probe-results.json)、[dependency-final-dmg-byte-probe-results.json](dependency-final-dmg-byte-probe-results.json)。实际冷默认/safe、首装/重启和真实已有客户升级（本轮v0.1.0-fix.20261003.5→v0.1.0-fix.20261003.6）由root执行，五身份/配置/凭据/工作区字段及fixtureId前后相等、POSIX0600回执由本验收者比对，私有内容未打开、私有hash没有独立重算，见[native-dependency-state-preservation-review.json](native-dependency-state-preservation-review.json)。原v1→.5此前真实升级链另按历史回执保留，不写成未执行的本轮直接v1→.6。资格仅为本机ad-hoc QA；正式Apple signing/notarization和Windows运行仍缺失。**[B独立实际字节/安装/公开回执；C已列8图；D正式平台]**

当前依赖版的payload/app/DMG构建原失败及闭包JSON命名碰撞分别保留；后续缓存/观察器纠正只形成新的独立run，原输出、退出码与SHA不改写。

| 实际构建/观察步骤 | 退出码/耗时 | 性质 | 原证据 |
| --- | --- | --- | --- |
| mac-dependency-payload | exit124/1800.327s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-payload.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-payload-cached | exit1/5.867s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-payload-cached.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-payload-cached-proxy | exit0/215.768s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-payload-cached-proxy.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-dir-build | exit1/223.730s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-dir-build.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-dir-build-cached | exit1/244.220s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-dir-build-cached.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-dir-build-cached-final | exit0/17.647s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-dir-build-cached-final.json](../artifact-index.json)（原件未包含，见索引） |
| mac-dependency-dmg-build-cached | exit0/30.608s | root实际执行；growth_m6独立回执/hash复核 | [evidence__mac-dependency-dmg-build-cached.json](../artifact-index.json)（原件未包含，见索引） |

完整来源与纠正边界见[native-dependency-build-attempt-preservation-review.json](native-dependency-build-attempt-preservation-review.json)；最终成品另由实际app/payload/DMG字节探针证明。**[B实际root构建与独立最终字节；D原失败归因的未证部分]**


| 当前精确原生步骤 | 实际结果 | 范围/独立核对 | 证据 |
| --- | --- | --- | --- |
| cold-default | exit0 /72.395s | root actual cold owned client run; independent retained JSON/log/pixel-state/hash/stat review; no verifier UI launch | [evidence__mac-dependency-default.json](../artifact-index.json)（原件未包含，见索引） |
| cold-safe | exit0 /106.950s | root actual cold owned client run; independent retained JSON/log/pixel-state/hash/stat review; no verifier UI launch | [evidence__mac-dependency-safe.json](../artifact-index.json)（原件未包含，见索引） |
| fresh | exit0 /30.874s | root actual exact app/bootstrap/PG health; independent command/log and before/after identity/version/hash review | [evidence__mac-dependency-fresh.json](../artifact-index.json)（原件未包含，见索引） |
| restart | exit0 /5.612s | root actual exact app/bootstrap/PG health; independent command/log and before/after identity/version/hash review | [evidence__mac-dependency-restart.json](../artifact-index.json)（原件未包含，见索引） |
| upgrade | exit0 /34.298s | root actual exact app/bootstrap/PG health; independent command/log and before/after identity/version/hash review | [evidence__mac-dependency-upgrade.json](../artifact-index.json)（原件未包含，见索引） |
| actual-installed-diagnostic-export | exit0 /374.362s | Actual root installed startup failure page/export action/save dialog with synthetic logs; independent exact app/archive, public exported text and POSIX mode review. Source unit and UI executions remain separate. | [native-dependency-diagnostic-export-independent-review.json](native-dependency-diagnostic-export-independent-review.json) |

以下a403/09bc/ad4a/955e/c083均为历史，不能被当成当前源码包的运行记录。历史原red、独立控制、诊断与普通冷启动分开登记；c083原生ready绿但像素red见上节，仍为HOLD。

root 构建 a403 QA2（0.1.0-fix.20261002.2）的 electron-builder DMG exit 0，725.038s。DMG 630673906 bytes，SHA256 b549b50818d04bf87fd04675518d3a3a81fe598e7b2ea64ef8b3fed2896c0484；载荷 SHA256 f0a9e7c32b1b7e8895cd008fcb29cc609454c19a39bac374cd11d56ed3c96995，四条关键路径 source/payload digest 相同，hdiutil 校验成功。此为 root 执行回执、独立元数据复核，正式 Apple notarization/平台 trust 不存在，`signed_platform_release=false`。**[B继承产物元数据]** 见 [evidence__final-dmg-fingerprint.json](../artifact-index.json)（原件未包含，见索引）、[evidence__final-payload-fingerprint.json](../artifact-index.json)（原件未包含，见索引）。

| 实际a403原生步骤 | 结果 | 执行者/独立复核 | 证据 |
| --- | --- | --- | --- |
| fresh 首装 | exit0 /252.480s | root执行；growth_m6读JSON/log | [evidence__mac-final-fresh.json](../artifact-index.json)（原件未包含，见索引） |
| restart 重启 | exit0 /29.996s | root执行；growth_m6读JSON/log | [evidence__mac-final-restart.json](../artifact-index.json)（原件未包含，见索引） |
| default 默认渲染 | exit1 /117.151s：引导退出后仍覆盖页面 | root执行；growth_m6读失败回执与log；保留原失败 | [evidence__mac-final-default.log](../artifact-index.json)（原件未包含，见索引） |
| upgrade 升级/safe渲染 | a403精确版本未完成该组 | 不以其他版本回执补填该历史组 | D 对该历史版本未验证 |

旧 `mac-dmg-smoke-session-final.json` 为 builder ETIMEDOUT，`mac-dmg-smoke-session-fixed.log` 结束于 ENOSPC；它们不是真实 smoke 成功。旧 safe production 退出 1（avatarReady=false、renderMode=null）同样保留为失败。先前版本 fresh/restart/upgrade/default 可作历史证据，不能替代精确最终包。有界轮询已在0f3覆盖延迟挂载、粘住 overlay、缺按钮、evaluation error与永不返回探针；当前门槛按本附录开头的精确回执判定。**[A源码+B继承失败/独立控制；D正式条件]**

09bc包的复用夹具默认渲染失败与全新客户默认渲染失败分别保留：复用夹具的服务端welcome已完成，不能以该夹具检验首次welcome avatar；全新默认客户370.288s退出1，welcomeReady=true、avatarReady=false、renderMode=null，发生在guide helper之前。日志中的network service restart是观测，不是已证实根因。0f3源码guide/deadline已过，不因此冲销这两个原生失败；root继续原生诊断/包复验。**[B继承实际失败；D因果]** 见 [evidence__mac-guide-clean-default.log](../artifact-index.json)（原件未包含，见索引）、[evidence__mac-guide-reused-fixture-failed-render-default.json](../artifact-index.json)（原件未包含，见索引）。

同一09bc包随后在原失败support重试并启用loopback CDP：exit0/134.013s，实际Live2D与引导/职场/舞台断言通过。并行诊断随后出现 `TypeError: Cannot read properties of null (reading 'appendChild')`；这是另一条已观测异步归属缺陷，不能断言它就是原cold 60s未ready的原因。该重试有已有support和诊断，不是新最终包干净首次成功。最小生命周期guard和late-model清理源码已在ad4a复验。见 [evidence__mac-guide-loading-diagnostic.json](../artifact-index.json)（原件未包含，见索引）、[evidence__mac-guide-loading-diagnostic.log](../artifact-index.json)（原件未包含，见索引）、[evidence__native-avatar-diagnostic.log](../artifact-index.json)（原件未包含，见索引）。**[A补修源码+B继承实测；D原冷启因果/正式条件]**

ad4a实际冷默认客户回执721.660s、exit1：avatarReady/live2d、嘴型peak0.45、blink2、gesture1、writeFailures0和65人vector团队均满足，但firstDayGuide shown/clicked/supported=true、closed=false。失败renderJSON和两PNG以唯一名称保留；本验收者对三文件bytes/SHA及JSON状态独立核对，不能被源码绿或另次diagnostic绿冲销。另一个全新support启用CDP的旧ad4a包实际exit0/276.612s，guide.closed=true；observer265.836s，80frames/5progressresponses/1条Response.json UnexpectedEOF。五响应中先completed/done1790964738086，后in_progress/summary1790964741000，属于观测到的时序问题；不将它当作原冷默认失败的唯一原因。诊断五文件hash一致，仍仅属该历史包。见 [evidence__mac-avatar-default.json](../artifact-index.json)（原件未包含，见索引）、[evidence__native-avatar-default-render-default.json](../artifact-index.json)（原件未包含，见索引）、[evidence__mac-avatar-guide-diagnostic-v2.json](../artifact-index.json)（原件未包含，见索引）、[evidence__native-guide-diagnostic-v2-frames.json](../artifact-index.json)（原件未包含，见索引）、[native-955e-history-integrity.json](native-955e-history-integrity.json)。**[B继承实跑+独立状态/hash核对；D原失败因果/正式平台]**

原ad4a安装app的实际四CJS与源一致、payload2a32c85d22f64db30c9e13b8b5241c8be969eac814980bdf0b4e0a325099a54b（500725222B）、2080条source/build回执与实际源hash复核通过，codesign --verify为ad-hoc；独立字节结果见 [current-artifact-recheck-results.json](current-artifact-recheck-results.json)。历史955e payload root pack exit0，版本v0.1.0-fix.20261003.2，archive SHA439aa48a173f14bca43f8b6a58c1e9f6a0eb68fa105e9dc982ee12218c8edb37、500729046B；root2083运行文件hashclosure无差异。随后独立流读该实际archive的2083条运行文件：2011条与不可变955e Git blob直接比较，72条构建输出与root原packer源回执比较，0差异；未选择14227条其他runtime文件作内容hash，不称全runtime语义/字节覆盖。实际四个安装CJS与不可变源、asar digest及ad-hoc codesign也通过。该历史500MB字节复核已经完成，初次ENOSPC仅属于执行前harness失败，原回执保留。见 [welcome-payload-stream-recheck-results.json](welcome-payload-stream-recheck-results.json)、[welcome-artifact-cjs-recheck-results.json](welcome-artifact-cjs-recheck-results.json)、[native-historical-completion-integrity.json](native-historical-completion-integrity.json)。**[B独立实际archive/asar/CJS字节；72构建源为B继承回执；D正式trust]**

历史955e安装app的root指纹为app版本0.1.0-fix.20261003.2、app.asar SHA844f8e4f964f26156972c0200370e255e0da74631ac7cf12671cb754e739b087、四CJS source/shipped相等、payload与上述archive相同，见 [evidence__welcome-app-fingerprint.json](../artifact-index.json)（原件未包含，见索引）。第一次真实cold default没有CDP，exit1/561.676s；完整37行log显示bootstrap03:15:28健康通过，03:16:36实际页面仍“正在确认访问范围”，productReady/welcomeReady=false、actorCount0、avatarReady=false、renderMode=null，尚未进入welcome/guide。失败JSON和原PNG两文件bytes/SHA已独立核对，PNG目视也是访问等待页，见 [evidence__mac-welcome-default.log](../artifact-index.json)（原件未包含，见索引）、[evidence__native-welcome-default-render-default.json](../artifact-index.json)（原件未包含，见索引）、[native-955e-history-integrity.json](native-955e-history-integrity.json)。日志两次network service restart与全机资源压力都是观测，未证明唯一原因；另次成功不将这个原run写绿。执行前ENOSPC和随后只清我方31个可重建cache文件的回执仍在 [welcome-recheck-environment-not-run.json](welcome-recheck-environment-not-run.json)、[density-cache-cleanup.json](density-cache-cleanup.json)；之后实际字节复核已完成并单列。private_state_retained布尔本身不代表配置hash/0600，明确收据的模式/保留状态与root报告hash另列。**[B继承native实跑/独立hash+C原PNG；D原失败根因/正式gate]**

| 历史955e后续步骤（非当前包） | 实际结果 | 性质/边界 | 独立核对证据 |
| --- | --- | --- | --- |
| 原失败support/CDP诊断 | exit0/167.315s | warm、复用原fixture、启用CDP；不作冷首次成功 | [native-welcome-followup-integrity.json](native-welcome-followup-integrity.json) |
| 全新空support默认冷复测 | exit0/342.554s | 无CDP；mouth0.358875/blink2/gesture1/写失败0；guide关闭，65team与18/65场景前后无overlay | [evidence__mac-welcome-default-repeat.json](../artifact-index.json)（原件未包含，见索引） |
| 全新空support安全冷模式 | exit0/278.350s | vector2d/webglfalse；mouth1/blink2/gesture2/写失败0；相同guide/team/场景条件 | [evidence__mac-welcome-safe.json](../artifact-index.json)（原件未包含，见索引） |
| 首次安装/再启动 | exit0/249.425s与33.789s | 真实app/bootstrap/PG健康；root before/after身份/凭据/配置/客户工作区hash相等，私有内容未打开 | [native-historical-completion-integrity.json](native-historical-completion-integrity.json) |
| 旧v1升级客户装种/升级前 | exit0/234.076s；版本v0.1.0-fix.20261002.1 | 这是旧版安装，不是最终新包升级成功；Unicode fixture与instance/system/config/工作区hash前状态保留 | [evidence__native-welcome-upgrade-state-before.json](../artifact-index.json)（原件未包含，见索引） |

warm observer真实39个页面样本、50条网络记录（26request/23response/1failed）、2error，watch exit1/170.634s；不是“50次HTTP请求”。cold复测与safe的15个公开render/PNG hash以及配置stat0600由独立小probe检查，warm/复测/safe共27份公开留存回执再次hash一致。私有配置只stat，hash来自root公开状态，不宣称打开并重算。原冷失败不改写，也不从后续成功推导资源根因。见[native-welcome-followup-integrity.json](native-welcome-followup-integrity.json)、[native-historical-completion-integrity.json](native-historical-completion-integrity.json)。**[B实际回执/hash/模式；C所读四图；D原失败因果]**

历史955e asar/payload不可变字节留存，重复停止QA app壳和旧v1压缩cache已按root清理收据移除；旧v1完整载荷500700440B没有保留，仅原hash、旧asar、真实旧客户runtime/DB/config/VERSION/log与成功装种/前状态保留。因此不声称能够重新hash已删的旧v1载荷，也不从文件名推导其源绑定。见[evidence__floor-pre-pack-owned-cleanup.json](../artifact-index.json)（原件未包含，见索引）、[evidence__floor-old-app-shell-cleanup.json](../artifact-index.json)（原件未包含，见索引）。此留存边界与最终新包实际升级回执分别判定。**[B继承清理收据/独立公开hash；D未留存旧载荷]**

证据保留限制与更正：root披露原09bc冷失败PNG被诊断覆盖，原字节没有保留；失败命令JSON/log仍在。诊断JSON与四图独立命名，不能冒充原失败图。24条诊断快照文件被同名runner元数据覆盖，只从stdout恢复6条并逐项比对；其余18条未恢复。此前两处清理确实随runtime目录删除了任务生成runtime/.env，分别是“引导修复 默认客户”和“生命周期 默认客户”；旧“DB/config/VERSION/log全部保留”文字对该配置不成立，由最终correction逐项取代。DB/VERSION/log保留，属于随机自有QA配置，没有客户配置或供应商凭据。后续v2另存qa-retained-config.env：本验收者只stat确认存在/0600，未打开私有内容；root报告配置SHA为继承值，不写成独立重算。首个错误映射draft标为discarded/is_evidence=false，没有用作结论。见 [evidence__native-config-preservation-correction.json](../artifact-index.json)（原件未包含，见索引）、[evidence__native-avatar-diagnostic-snapshots-retained.json](../artifact-index.json)（原件未包含，见索引）、[evidence__native-guide-diagnostic-v2-retention.json](../artifact-index.json)（原件未包含，见索引）、[native-955e-history-integrity.json](native-955e-history-integrity.json)。**[B留存/更正/模式元数据；C诊断图样本；D未留存原图/其余18条；私有内容未读]**

## U 域记分卡

| 指标 | 实测/缺失 | 规范门槛 | 判定 |
| --- | --- | --- | --- |
| P0/P1/P2任务成功率 | 未测；实际用户N=0 | 100%/≥90%/≥80% | D 未验证 |
| 关键任务时间/点击数 | 未测；命令耗时不是用户任务时间 | 按角色/任务预算 | D 未验证 |
| 错误恢复/数据丢失 | bootstrap错误路径单元断言已测；完整用户恢复率未测 | ≥95%/0 | A合同+B单元；D体验率 |
| 5秒/首击/树测 | 未测 | ≥80% | D 未验证 |
| SUS/UMUX-Lite/SEQ/CSAT | null；没有参与者量表 | 按规范门槛 | D 未验证 |
| NASA-TLX | null | ≤50或不劣化10% | D 未验证 |
| WCAG AA/axe/键盘/读屏/缩放 | 完整协议未执行 | 0 critical/serious且P0任务可完成 | D 未验证 |
| AI披露复述/申诉/撤销 | 未测 | ≥80%/100%/100% | D 未验证 |
| 打扰/偏好遵守 | LoomMate源逻辑精读；1440/390截图和mate切换样本 | 静置打扰0/偏好违反0 | A源码+C样本；D全旅程 |
| 跨端/回归 | 1440/390 scrollWidth匹配viewport；390为桌面窄视口，非真手机 | 六OS/浏览器+真实手机/弱网及≤10%劣化 | B几何+C图；D完整协议 |

## O 域记分卡

| 指标 | 实测/缺失 | 规范门槛 | 判定 |
| --- | --- | --- | --- |
| pass@1 / pass^k | null；真实任务N=0 | P0≥80%，成熟≥90%；k=5/8 | D 未验证 |
| 工具正确率/步数预算 | local counter与选定公共子进程状态已测；无任务质量gold | ≥95%/≤预算 | A合同+B局部状态；D能力率 |
| 硬约束/软约束 | 列明block/permit/parent scope反例被拒绝 | 0/≥98% | A+B专项；D所有经营任务 |
| 引用覆盖/幻觉率 | 未测真实产物 | ≥95%/≤2% | D 未验证 |
| 完整率/按时率/一次通过率 | null | ≥98%/≥95%/≥85% | D 未验证 |
| 业务KPI/护栏 | 无真实业务数据/因果基线 | 达标且不劣化 | D 未验证 |
| 每结果成本/ROI/HMPO | null；命令费用不充当经营ROI | 预算内/可算 | D 未验证 |
| 假成功/幂等/降级 | missing-output与deadline终态failed；单次permit不可复用 | 0/100%/可用 | A+B列明控制；D完整结果链 |
| 红队可利用用例 | OBS07列明scope缺口已闭环；完整OWASP/记忆投毒/外部渗透未执行 | 0可利用 | A+B专项；D全域 |

## P 域记分卡

| 指标 | 实测 | 要求/限制 | 判定 |
| --- | --- | --- | --- |
| 环境档位 | 源码本机fixture；root本机client-runtime初始化 | 需真实client-runtime/deployed任务矩阵 | D P阈值未满足 |
| 内置模型就绪与返回版本 | 未触发真实模型；不依据配置字段认定就绪 | 每模型≥1真实任务+returned model ID | D 未验证 |
| 推理/多模态/工具循环 | 0真实provider任务 | 真实trace+回执 | D 未验证 |
| 生图/生视频 | 0图/0视频；本地知识/continuity测试不属于生图/视频产物 | 规范配额与产物/回执 | D 未验证 |
| 预算/账单 | 无provider配额账本；paid成本未测 | 真实调用前硬闸+可复算账本 | D 未验证 |
| 链路深度 | local public-dispatch/child-worker；generation被配置拒绝 | dsh/model-gateway/gen-http/product-dispatch按实测标注 | B本地链；D真实模型链 |
| 被拦任务 | 合法image对照PROVIDER_UNCONFIGURED属预期安全控制，非生产通过 | 生产任务blocked不得写passed | D生产未验证 |

## ADR / HIR 自主交付表

| 岗位 | AL声明/实测 | N/覆盖% | ADR-0/1±CI/2 | HIR/HIR-NI±CI | H1/H2-H4/H3+H4 | HMPO中位/P90 | KPIΔ±CI/护栏 | 夹具过滤 | 离线调整/AVR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| GEO/影片相关岗位（本轮未取真实业务样本） | null/null | N=0；覆盖%未定义 | null/null/null；无WilsonCI | null/null；无WilsonCI | 均null；无人工工时 | null/null | 均null | 真实交付件过滤前0、过滤后0；确定性夹具全部排除；13个已知自有工作区/3作业保留；另5个integration-prefix共享夹具未推断caller | 未应用调整；AVR象限未测 |

交付单位应是带契约、可判定结果与去重键的真实经营产物；本轮没有该数据集，不用事件条数、一次性授权或 558 个用例代替分母。fixture标记、suite/apr-suite/apr-e/T-suite前缀、测试标题/近零时长与独立租户必须过滤；本轮只统计残留而不计算自主率。最新只读快照 [fixture-residue-welcome.json](fixture-residue-welcome.json)：13个已知自有工作区（原runtime/permit11+前后welcome2）、3个影片作业保留；另5个integration-prefix共享测试工作区单列，不从前缀推断root/verifier归属。原快照 [fixture-residue.json](fixture-residue.json) 的11/3同样保留。模拟T-154/T-155在全局队列扫描也被推进；初始化helper对owned fake DB queued audit-th作了暂停，不能声称只影响自身前缀。事件只增不删，真实业务交付件N仍0。**[B只读残留/原状态；D ADR/HIR/AVR]**

制度性 H1 与非制度性 H2–H4、H3+H4 严重介入、HMPO/线下调整均无数据，结果写 null 而非 0%；无对照和真实业务护栏，不能宣称自主价值提升，也不能把未知硬分到 AVR A/B/C/D 某象限。**[D]**

## 12 条发布红线检查

| # | 红线 | 本轮判定/证据 | 范围与等级 |
| --- | --- | --- | --- |
| 1 | 治理被绕过 | 列明before-action/block/permit/parent scope拒绝控制未命中；OBS07原命中已闭环 | A+B专项；D全系统未下结论 |
| 2 | 关键任务不可完成 | 当前精确本地QA首装/重启/升级及两模式通过；完整真实用户任务仍未执行 | B当前QA专项；D完整用户旅程/正式平台 |
| 3 | 演示与真实混淆 | ws-geo=simulated；报告未把mock/local状态写成真实经营成功 | B模式查询；D全部界面披露协议 |
| 4 | 秘密与客户数据 | 独立证据导出排除.env/raw state；模式扫描无literal token/credential URL/非空凭据字段 | B导出机检；D全客户数据渗透/PII协议 |
| 5 | 无回执宣告完成 | 本地missing-output/deadline失败；真实外部业务回执不存在 | A+B控制；D生产完成阈值 |
| 6 | 发布门禁未全绿 | 当前准确接受提交的继承CNB回执三闸均绿：source_head=1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8；平台合并试算statuses.sha=85dd94e78f9da5c85aaf16fc7b98716bf4d3f565；详见 [cnb-dependency-source-1e47.json](cnb-dependency-source-1e47.json)。root执行API，growth_m6核对公开回执内容与SHA；没有凭据读取或API调用。 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 正式签名平台产物未完成。 | B按准确源码/QA回执逐项；D正式全平台产物，不声明全域绿 |
| 7 | 假成功 | 两种真实子进程失败控制保持failed，未转finished | A+B所列本地控制；D所有生产结果 |
| 8 | 越权自主 | 匿名owner403、JWT边界401；permit20及parent13绑定拒绝 | A源码+BHTTP/DB/frame；D完整外部渗透 |
| 9 | 结果不可对账/造假 | 原5事件/hash保留，失败receipt同样保留；没有制造业务数字 | B账本及留痕；D真实业务对账 |
| 10 | 体验/无障碍阻断 | 当前精确本地QAguide/场景及浏览器点击已复验；历史guide red保留；完整读屏/键盘证据缺失 | B专项执行/历史red；D完整UX未验证 |
| 11 | AI/合成未披露 | 无真实生成产物或用户复述测试 | D 未验证 |
| 12 | 红线只靠LLM评审 | 独立结论由代码/实际HTTP/DB/调用数/child终态裁决，未用LLM judge | A方法+B断言；不代表业务指标已满足 |

这张表只判定有证据的局部控制，不声称12红线在全产品“均未命中”。历史关键任务/体验red保留；当前QA门按精确包单列，正式平台/完整UX和生产业务门槛缺失仍不满足完整发布判定。**[A/B/D]**

## 统计与校准

| 项 | 值/方法 | 允许结论 |
| --- | --- | --- |
| 样本量 | 558唯一目标用例；1370广域原test；43窄复测；density原3/4与复测4/4分别留痕但只计4例；真实交付件0/真实用户0/paid供应商0 | B确定性断言数量，不可充当经营样本 |
| 重复/独立性 | 单组复测不与原run叠加计算IID样本；same fixture不算新业务件 | 不报告夸大的通过率置信度 |
| 比例/时长区间 | 无业务WilsonCI；无用户中位/P90/bootstrap；仅报告命令实际时长 | D长期/效益统计未验证 |
| pass^k/k | 未按真实任务多次试验协议执行 | D 未验证 |
| 双评/κ/LLM校准 | growth_m6与root职责分离；无双评分者κ/校准集；LLM judge未用 | 无能力评分一致性主张 |
| 冻结 | source/locks/prompt/skill/fence/bundle/seed哈希齐；真实模型/价格/gold/holdout缺失明示 | 只冻结本轮所测对象 |
| 舰队可比性 | 当前为Growth源码专项；growthtest/growthmatrix不在本报告分母 | 不进行舰队经营能力排名 |

## 失败、修复与验收器校验

| 事件 | 原实际 | 处理与复验 | 未解决界限 |
| --- | --- | --- | --- |
| 父通道作用域OBS07 | 原040四种绑定伪装可预占 | root修复；独立13控制例通过，networkCalls=0 | 真实供应商/完整影片业务分支未验 |
| GEO系统遥测合同 | 原78/81，E01..03失败 | 完整server_request/system.error合同+反例；原记录留存；83/83 | 不把系统例外泛化到行业/外部动作 |
| workspace源码复制 | 递归遍历node_modules/循环链接风险 | root补安全copy；完整代码/8相关test阅读，955e desktop87/87 | 各平台实际产物仍须独立验 |
| 广域8超时 | exit1/1355pass+8fail+7skip | 原阈值窄复测43pass；原red不改写 | 原因未做性能归因 |
| 浏览器指纹harness | 首次MODULE_NOT_FOUND @playwright/test | 改用已安装playwright-core peer，实际空白Chromium指纹成功 | 工具脚本缺陷，非产品UX失败；原log保留 |
| DB查表harness | 首次events relation 42P01 | 只读查biz_events后取到五原事件/hash | 查询脚本错误，非产品修复；未改业务库 |
| a403final default | exit1/117.151s首日引导覆盖 | 0f3源码修复独立通过；历史955e两模式后续通过分别留痕，当前精确新包另列 | 不倒改原run；当前native状态见附录 |
| Live2D卸载归属 | 09bc真实诊断null appendChild；root原4例3失败 | ad4a补三个异步边界与late model销毁；独立4+3例通过 | cold原超时因果未等同；当前native按实际包附录 |
| 独立React harness alias | 首配置缺JSX dev runtime/prefix误匹配，0产品用例执行 | 查Vite官方alias格式/顺序后改精确regex与实际installed入口；3独立例通过 | 工具配置错误，原失败保留；没有产品源码改动 |
| 截图旧状态OBS10 | 原8例7绿1红，实际拍摄时overlay重新出现却接受旧状态 | 955e截图前后重新采样；原8例全部通过，原截止不变 | 不作为原native失败根因 |
| Welcome/readyOBS11 | 原React4例1红；真实PG5例2红，完成被迟到进度覆盖 | 原4/5+新welcome4+server8通过；terminal不会产生假after事件，explicitreplay仍可用 | 不把fixture成功写成精确coldnative通过 |
| 同版本缺runtimeOBS12 | QA清cache后保留VERSION，旧bootstrap跳过组装读runtime/VERSION失败 | 955e三缺失/版本及rollback控制通过；DB/config/sentinel保持 | 旧两处runtime/.env误删由最终correction明示，非产品客户配置 |
| 密集长名OBS13 | rect-only绿但目视发现7长名/宽度溢出；加强断言2绿2红 | max-content与不压缩avatar/label；冻结首次3/4的390ready超时保留，同脚本原阈值复测4/4 | 原超时原因未归因；非真手机 |
| Canvas/CSS/初始视口OBS14 | 955e角色/标签误选，7d实际CSS点击仍red，aad手机首屏65名牌全不可见 | 真实TextMetrics/路径/物理点/callback/原生首帧与滚动；d6原24/14/7均通过，源码字节继承逐项列明 | 历史坐标观察器问题保留；不把无CSS绿当生产CSS |
| 3D投影/命中/可选drop OBS15 | 955e真实CSS6/28；d6默认26/28及drop24/28，身体点被别人的牌/投递锚截获 | 独立修复会话处理后原28要求及可选投递正反控制分别执行；以floor-final-verification为准 | 真实点与DOM/回调记录保留；synthetic drop不是OS/业务派单 |
| Stage/CEO portal OBS16/17 | c083原生exit0但8PNG像素red；CSS组件3/7、portal2/3、observer4/6 | Stage/CEO7实际源7fee3a6a5563d41c568463994764d3883eb7667d；实际7fee3a6产品36、desktop113和capture8通过；bootstrap60是desktop子集，依赖版按有界输入继承 | 新精确安装包8图及两模式已按实际QA复核；完整UX仍未验证 |
| 报告生成入口编码观察 | 普通文件入口实际NonUTF8SyntaxError；严格UTF8/AST/完整字节compile均通过 | 原入口失败回执保留；同一完整原字节以原__file__/__name__执行生成报告，未删guard | 原因未证明；不是产品或原生用例通过，见diagnostic-f951-report-builder-utf8-observation.json |

## 验收债与豁免

| 类型 | 条目 | 原因 | 影响 | 补做门槛 | owner | 豁免 |
| --- | --- | --- | --- | --- | --- | --- |
| 本地QA已复验/正式条件保留 | MC-106 / OBS-04/08..19 最终渲染门槛 / MC-018实际诊断导出 | 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | 本地QA范围可条件放行；不能声明正式全平台Release | 正式平台/信任链发布前 | root 修复；growth_m6 独立复验 | 无豁免 |
| 未执行 | Windows 客户端与正式签名/Apple 公证 | 本机 macOS arm64；本包仅 ad-hoc QA，发布者源码/替身测试不等于正式平台产物 | 不可声称全平台或正式公开 Release 可用 | 相应正式平台发布前 | 产品发布 owner | 无豁免 |
| 未执行 | P0–P3 真实内置模型矩阵 | 独立任务禁止真实供应商；未使用真实生产业务目标与支付回执 | P 域未验证；O 域能力未验证 | 宣称模型生产可用前 | 模型/业务验收 owner | 无豁免 |
| 未执行/人工缺失 | U0–U8 完整体验协议 | 当前只有两宽度与原生截图样本；无真实用户/真手机/读屏/完整 axe/键盘操作链 | U 域未验证，截图不构成全部任务可完成的证据 | 声明完整用户体验验收前 | UX 与产品验收 owner | 无豁免 |
| 未执行 | O0–O9、ADR/HIR、长期可靠性 | 真实交付件分母 0，无业务 KPI/工时四源对账/金标留出/24h 以上长跑 | 不能宣称 AI 经营价值、自主交付率提升或 pass^k | 声明业务或长期效果前 | 业务/统计 owner | 无豁免 |
| 观测失败/窄复测通过 | 广域 packages/base 8 条超时 | 原并行 run 失败；三文件原阈值复测 43 条通过，根因未做性能归因 | 原广域门禁不改写为通过；a403/0f3/ad4a CI 三闸继承回执分别说明 | 如继续主张该主机并行稳定性，需受控资源条件重跑/分析 | 开发/测试 owner | 无豁免 |
| 观测失败/原阈值复测通过 | 955e 密集团队 390 宽 ready 超时 | 首次冻结源 run 3/4，390 ready 15s 超时；同脚本/同阈值复测 4/4，无 source 变化 | 原 red 保留；不能以复测推导资源争用或已解释原超时 | 如要主张高并发主机/真实手机稳定性，按独立设备与资源协议补验 | 开发/平台验收 owner | 无豁免 |
| 裁剪 | 8 个非精读文件与未执行 267 个检查项 | 源码专项范围；历史文档、巨型其他业务分支与缺外部条件的完整协议未重跑 | 不作全仓通读或完整 RDAS 通过 | 扩大对应结论前按 coverage 逐项补做 | 验收 owner | 无豁免 |

完整逐项owner/reason/补做门槛见 [coverage.json](coverage.json) 与 [acceptance-debt.json](acceptance-debt.json)。本报告没有授予任何豁免、绕过红线或为缺失项编造批准日期。缺真实外部条件的协议明示未验证，当前本机门按精确回执判定。**[B范围登记；D未测阈值]**

## 证据导出与索引

证据索引为 [evidence-index.json](evidence-index.json)，每个文件列 SHA256、bytes、等级、类型、来源及命令。独立execution与root继承receipt明确分开；独立原失败及root存续JSON/log保留，已覆盖的root原PNG/完整24快照缺口明示。raw `database-state.json`、`.env`、token-bearing fixture 字段不进入公开索引；影片 fixture 原目录留在本地但不打入共享索引，运行结果/冻结hash仍可溯源。检查仅扫描本独立证据目录与选中的 root 回执，没有读 CNB/供应商/人工凭据。产品源码、真实客户状态和原任务台账未改动；实际MCD写入自有测试状态及dedicated-ledger、唯一run/index已授权并单列。本独立目录本次不含需要改写的凭据值，父任务若脱敏其分享副本，应以其变换说明为准。**[B导出模式扫描；不是全系统秘密安全保证]**

复跑入口为 [run_check.py](../artifact-index.json)（原件未包含，见索引） 与各组 JSON 中的 command；查询/测试依赖原本机 owned fixture 环境，公共源码复现 helper 位于本目录。不能在未知生产目标直接重放 seed/夹具；这条界限来自所测环境，不改变已授权的本机复验范围。所有未测经营数据为 null，所有绕过式处理均未引入。

## 收尾报告

- 已完成：24张卡与19项独立观察、root23观察映射逐项源码/合同复核；157跟踪文件（149精读/2机检/6选段）与6个外部安装文本清单；558唯一用例及逐例case matrix；实际PG/HTTP/子进程/React/Chromium正反控制、真实CSS下Canvas/WebGL几何/身体与名牌点击、首帧/滚动、投递边界；955e全仓typecheck及原反例历史留存，准确7fee3a6的desktop113+guide9+capture8实际执行取代相应旧104例，CPU与Stage/CEO7按真实执行来源及本轮有效输入继承分列，原28/55/29/33/3保留原执行SHA并逐输入冻结，新增职场类型检查/生产构建与36直接PNG审阅；原失败与原阈值窄复测分别留痕；276条覆盖/缺口；环境资产指纹、U/O/P/ADR、红线、统计、验收债、历史原生实际字节/回执与配置更正及SHA索引。当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 当前接受源码CI三闸已核对，专项合并条件满足。
- 未完成/未覆盖：本机原生QA专项已经实际完成；正式Windows/Apple信任链等仍未完成。 Windows正式运行与签名公证、真实模型/回执/成本、完整用户/无障碍/真手机、O/ADR/长跑缺条件；8阅读裁剪明确。广域8超时、density390ready和历史955e冷访问等待原因未归因；09bc原PNG/18快照缺口不能补称完整；旧v1完整压缩载荷没有保留，原hash与真实升级客户前状态留存。
- 自主追加事项及理由：父通道伪method/stage/shot/project、永不返回renderer、截图旧状态、实际ready重开/PG完成覆盖、长名内容溢出、Canvas生产CSS物理点击/初始空视口、3D身体/名牌/投递锚交叉误选、原生舞台共面地面碎裂等独立反例交回不同修复者并回归；新增permit全字段/末事件失败重放、JWT HTTP、公共child missing/deadline和synthetic投递正反边界；只读保留system5xx/残留、原生实际字节与config更正，避免假修复、假绿及证据污染。
- 采用的假设：本轮按父任务已授权的原22卡及后续专项问题共24卡 M6 执行，新增reset MC-017与诊断导出MC-018；未在缺真实用户/业务/平台条件时重走完整 276 协议。所有 fixture 为 owned loopback fake DB 数据或合成诊断日志/临时文件；使用本地counter/mockreview不作为供应商或经营结果。若有新SHA或最终native证据到齐后继续更新，不把源码专项报告当最终客户发布凭据。
- 置信度：列明源码修复与确定性状态控制为高（完整核心源码+实际PG/HTTP/child/React/Chromium正反例）；当前本机原生资格按独立字节/回执判定；全平台、生产模型和经营效果未验证；历史所有失败保留；density/职场两宽几何为B、所读图为C，旧超时稳定性根因未验证。
- 建议复核：1）MC006/007与OBS07动作前拒绝/预占/consumed；2）OBS11的完成终态SQL和客户端迟到response/ready原反例；3）OBS14/15的真实CSS身体/牌/投递物理点击与最终精确包两模式/旧客户升级及配置/DB身份回执。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？24卡与19独立观察/root23映射逐项落表；非专项276协议/8阅读裁剪、原red与当前native资格逐项明示，没有暗中缩范围。
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？独立测试、发现交回、当前原生/角色门禁/交接与正式报告均按实际状态自行完成；尚缺正式平台/经营条件逐项保留验收债，不向用户追加无必要选择。
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？源码A、机器B、选段/截图C、未测D分开，实际失败/残留/继承来源保留；没有把夹具升格成经营效果。
- [是] 经得起资深工程师逐行审查？逐文件SHA/阅读行段、逐例预期实际、原始命令、变更祖先、正反例与局限齐备；当前native/CI按精确回执判定，缺条件明示。
