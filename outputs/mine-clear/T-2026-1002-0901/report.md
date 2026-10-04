## 覆盖率声明

- 范围内文件总数：**3127**；精读：**196**；机检/脚本解析：**2687**；抽样：**10**；未读二进制内容：**234**。范围为修复源码 `1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8` 的整个跟踪树，按最佳证据互斥计数。另生成的交付记录不混入源码理解度。
- 本次从固定审计基线改变 **79** 个产品文件：精读 72，机检 2，大型实现或历史文档选段 5，未读二进制 0。其余文件的阅读沿用只接受逐字节未改变的旧证据；独立验收记录的完整阅读以当前 SHA 校验。
- 未读/抽样清单及原因：[逐文件覆盖率清单](file-coverage.csv) 和 [范围与裁剪摘要](coverage-summary.json)。234 个二进制资源只核对大小、类型和 SHA，不代表逐件视觉审查。剩余文本接受全量哈希/元数据机检，不冒称全量精读。
- 裁剪采用“全量机检 + 安全、运行时、影片工位、客户端和发布链的精读”。没有穷尽全部连接器、所有业务页面与巨型成片脚本的每个分支；这是明确的覆盖边界。后续 Growthtest/Matrix 需各自目标仓验证，此报告不能替代它们的验收。

## 证据分级

A＝相关源码完整阅读；B＝全量机检、元数据或实际命令/状态；C＝选段源码、截图和交互样本；D＝推断或未验证。实际运行结果单列，源码 A 不自动成为生产业务结果 A。完整 RDAS 276 项登记在 [independent-m6/coverage.csv](independent-m6/coverage.csv)；已登记不等于已执行，各项实际状态和未执行原因逐项列明。

# Growth 全问题修复与独立专项验收

任务 `T-2026-1002-0901`，修复者 `codex-root-T-2026-1002-0901`，独立验收者 `growth_m6`。读者为产品负责人、客户端交付负责人和接收实验副本的工程师。原审计的失败记录保留；这份报告回答修复后的行为与证据。

## 用大白话解释

原来最危险的三件事是：陌生人可能拿到店主身份；任务可能先动手再检查权限；系统禁止的动作可能被缺参或审批绕过去。现在陌生访问被拒绝，动作先验权限和审批，同一任务同时续跑只有一个执行者，系统红线仍然有效。人改过的参数按新值执行；写动作没有最终回执时明确失败并待核对，不自动再次动手。[A：认证、gateway、运行循环；B：生产 HTTP 和真库计数测试；路由大文件选段 C]

后续复核还发现，演示重置在无人值守时可能直接走到删库，缺少客户工作区识别和先备份。新增MC-017单列为P0，原8组替身测试全部失败；修复后12组控制分别检查确认、目标、客户类型、私有备份、SQL和迁移失败。只有已明确确认的本机纯演示库可进入流程，实际删除事务还会锁定并重查客户状态。全部复现和回归使用命令替身，没有对真实客户库执行删除。[A/B；真实客户重置未执行]

客户启动诊断另有MC-018 P1：原导出会保留JSON/带空格的秘密和数据库连接密码，覆盖旧文件不能收紧权限，保存失败还会逃出恢复页。当前在日志、错误摘要与读取错误中按字段和URI脱敏，新建/覆盖文件先设私有权限再写内容，取消不写、保存失败允许重新选择。原完整Git源重放12项为2pass10fail，修复与独立回归另列；200KB候选正则的21.6s性能失败也保留，最终边界扫描通过2s控制。字段遮蔽不能代表任意日志匿名化，Windows ACL仍需Windows实机。[A/B；完整日志匿名化与Windows ACL D]

最后逐项执行时，官方依赖审计新增HIGH公告，旧运行MC-016真实失败。排查上游0.4.0发布包后，仅移除其发布文档所用gh-pages依赖边；保留PIXI运行组件、固定版本及公告检查。12个工作区importer、运行期134依赖锁和64个Web构建文件均按实际字节核对，生产审计通过。静态导入机检与相同运行字节只能支持B级限定继承，不能宣称任意动态路径已穷尽；当前源码的逐卡MCD仍重新运行。[A：精确配置；B：完整锁解析、构建比较与审计]

原来一些任务看起来在跑，实际会被队列计算、终态恢复、跨工作区驳回记忆和影片子进程装配问题卡住。相应合同已修复，并按原失败断言复测。影片本地阶段真正经过公开入口、子进程和父通道；缺阶段、缺产物、超时不能假报完成。付费供应商成片效果仍需真实回执另验。[A/B；生产成片 D]

客户端方面，修复运行目录、精确依赖、工作区模块路径和漏文件。实际包和独立验收又抓到引导遮罩迟到、renderer 永不返回、数字人卸载后迟到回调、截图使用旧采样、引导完成后被迟到请求降级、运行缓存丢失却被旧标记跳过、65人姓名标签重叠、2D/3D职场误选、舞台Canvas只有150px而场景440px、员工牌匾遮住负责人牌匾，均补了失败与成功控制。当前 Mac 包与源码逐字节对齐；冷启动、实际几何与像素、私有状态保留以本报告下列实际收据判定。Windows 原生运行、平台正式签名、公证和行业信任链仍有独立门禁。[A/B；截图样本C、正式跨平台发行 D]

## 基线、归属与接口

| 项 | 值与含义 |
| --- | --- |
| 审计基线 | `42ead347c65a5cc343bcd290702d53a7fcdb1687`；原始证据没有改成绿色 |
| 修复/验收源码 | `1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8`；完整祖先关系在独立 baseline 和本台账记录 |
| 源码分支 | `task/T-2026-1002-0901`，CNB Issue 316 / PR 318 |
| 三条原 P0 | MC-005/006/007 源码合同由独立角色复验；不是只跑开发 mock 登录 |
| 发布判断 | 源码专项、Mac 本地 QA、正式原生发行、RDAS 生产域分别记录 |
| 代码归属 | Growth 实验车道；本次没有回流公共基座、平台中枢或其他行业语义 |

不存在新数据库迁移。沿用 `threads`、`approvals`、`biz_events`、`org_memory` 和已有影片账本，RLS 与只增事件保留。`threads.status` 和已保存计划驱动恢复；审批 snapshot/gesture 保存最终参数、指纹与审核标记；`biz_events.decision.kind` 追加 `execution_started` 和最终 `execute`，不回写旧事件。新驳回记忆身份含租户/工作区，旧记忆不删除。[A，运行循环、gateway、approvals、原始 SQL]

内部接口 `authorizeToolExecution(gateway, ctx, draft)` 在落开始事件前检查权限，返回内存中的只消费一次凭证，绑定租户、工作区、主体、session、审批、对象、动作、工具、步骤与参数。最终 `gatewayAppend*` 拒绝错绑或复用凭证；不是可伪造的 JSON 字段。`runQuest` 使用租户/工作区/thread 组合的数据库会话锁，`finally` 解锁和归还连接。[A，gateway.ts / loop.ts]

认证的公开 `loginAs` 在 production 抛 FORBIDDEN；可信本机通道只接受服务预配身份及 loopback 高熵 capability，错误 key 返回 UNAUTHORIZED。影片 `film.start` 接受 projectId、固定 workerName、JSON document、1..64 stages、options 与受限预算，返回 jobId/projectId/attempt/runId/running；`film.status` 按 RLS 返回状态，不属于当前工作区则 NOT_FOUND。公开面不接受任意入口路径、门裁定或自报完成证据。[A：desktop-auth.ts、film-router.ts；C：主路由被改 handler]

## 方案比较与异常路径

| 选择 | 收益 | 成本/风险/适用前提 | 本次决策 |
| --- | --- | --- | --- |
| 数据库会话锁 + CAS + 开始/最终两条事件 | 执行权跨进程受控；权限先于副作用；不明写结果可检测 | 需持有独立连接并明确断线/失败语义；外部幂等或对账仍需供应商支持 | 已实施；保持既有数据结构和调用方 |
| 统一持久队列与租约 worker 重构 | 可分离调度和长任务、集中重试与租约管理 | 迁移范围较大，仍必须有前置权限、幂等和回执；需要额外恢复协议 | 后续候选；没有以架构重写替代当前缺陷修复 |
| 保留源码目录并生成实体 ESM 入口 | 相对资源路径和模块单例一致；无软链 Windows 复制可用 | exports/目标路径必须验证；运行期依赖仍需精确锁 | 已实施，三条装配入口使用受控 helper |
| 全量预编译成统一运行树 | 可减少动态 TypeScript 装载 | bundle/SQL/资源/子进程路径需新契约与完整迁移 | 后续候选；没有引入新运行依赖 |

比较中的架构成本为 D 推断；已实施行为为 A。错误处理覆盖：无权限/错绑拒绝在外呼前；缺参继续 pending_review；block 维持暂停；写工具抛错记录失败并保留开始证据；缺最终回执或产物不能完成；子进程截止失败并提示已签发供应商任务需对账；renderer 观察受剩余硬截止约束；迟到模型被销毁且不能重装监听。[A/B]

## 18 个问题的逐项结果

| 问题 | 修复后的具体行为 | 证据/限定 |
| --- | --- | --- |
| MC-001 · P1 · 桌面环境构造引用作用域外的 RUNTIME，首次启动抛异常 | Source path construction verified; actual native versions remain separately bound in the native addendum. Current exact native status: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-002 · P1 · 客户端精确依赖锁未随仓库实际依赖更新，载荷门禁失败 | The exact accepted dependency inputs and both complete lock graphs are machine-compared; metadata differs only in the two input hashes. Actual current runtime-lock execution is separately recorded by the real MCD roles. Historical desktop113 and its subsets keep7fee execution metadata; Windows native remains unverified. | B；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-003 · P1 · 工作区源码复制进 node_modules 后破坏相对路径与模块单例 | Canonical identity and relocation test plus all eight module/source-copy tests pass; native rendering is separately gated in the exact-version addendum. Current exact native status: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-004 · P1 · 载荷漏影片辅助模块，备线遗漏种子与白板工具依赖 | Required helper and dist whitelist reviewed; child imports and local stages run. Entire Windows/emergency installers were not executed. Current exact native status: 当前精确新客户包的源、实际 app/payload/DMG 字节、冷默认/安全模式、首装/重启和真实旧版升级已独立复核；本地 QA 专项放行，正式 Windows/Apple trust/模型/UX 条件仍保留。 | A source / B payload；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-005 · P0 · 生产环境公共 loginAs 无身份验证，非示例工作区可取得 owner 身份 | Anonymous production owner login is 403; protected anonymous and malformed JWT cases are 401; trusted capability only selects server-configured identity. | A / router C；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-006 · P0 · 外部动作先执行后授权，审批并发可产生重复副作用 | Before-action denial, one approved execution, permit binding and failed-final non-replay pass; supplier side effects are replaced by local counters. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-007 · P0 · 缺参和低相关性标记跳过全部围栏，人工审批可越过 block 红线 | Unconditional block remains paused before/after approval and flagged contexts; prohibited tool-call count is zero. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-008 · P1 · plan_unverified 在存计划之后才标记，重放可绕过未批准的审核 | Stored plan contains plan_unverified; first and repeated run stay pending_review without tool execution. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-009 · P1 · 编辑后采纳只记录新值，实际工具继续执行原参数 | Both ordinary and high-risk edited approvals execute amount=2, exactly once. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-010 · P1 · 把 queued 算进运行并发，十条待办且零运行时队列停滞 | 0-running/10-queued fixture advances. Global scan also touched existing fake T-154/T-155; residue is disclosed. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-011 · P1 · 已驳回的 cancelled 线程可被普通 run 重新挂起 | Rejected thread remains cancelled and executor calls remain empty. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-012 · P1 · 驳回记忆 ID 不含工作区，同原因在第二工作区导致审批回滚 | Same rejection enum in two separate workspaces succeeds; both approvals are rejected and both threads cancelled. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-013 · P1 · 影片工位子进程缺 TypeScript 加载器，worker 分支仍未接通 | Public child local stages and frozen hashes pass; missing output/deadline fail closed. Newly found component scope defect is fixed and independently tested; paid generation remains unverified. | A / full-chain C；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-014 · P2 · GEO 围栏引用 publish_job，组合对象模型没有该类型 | publish_job now has a declared object model; A10 and B03/B04 pass. Strict system-error contract fixes unrelated E01..03 false failures without deleting original rows. | A source / B suite；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-015 · P2 · 影片预览建议命令未转义用户字符串，中文路径和分号破坏参数 | POSIX command preserves special characters literally, and PowerShell representation is present. | A；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-016 · P2 · Live2D 间接工具链含四个安全公告，需按实际可达面处理 | Actual exact-source registry audits returned197 production dependencies, zero advisories at every severity and no muted findings; original7fee High run remains failed. Old245/zero-advisory receipts are historical only. Literal published-module reference inspection does not establish every dynamic behavior or exploit reachability; no future-advisory assurance is made. | B；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-017 · P0 · 演示重置在非交互模式绕过确认，未识别客户工作区且缺少删除前备份 | Actual original8/8 failed discovery and later dotenv counterexample remain retained. Retained12/12 reset controls are included in complete desktop113/113 at the actual7fee execution source with synthetic configuration and PATH command substitutes; no customer or real database was reset. Explicit confirmation, production/remote/unknown/customer refusal, private nonempty backup and pre-deletion transaction recheck are source/test contracts. A statically observed seed log/default mismatch remains unexecuted; reset refusal for workspaces not explicitly marked as examples is preserved. Real production restore/backup operational quality is not established by these controls. These retained desktop113/subset controls keep their7fee execution provenance and are inherited only through the complete effective-input comparison; actual current MCD card runs are separately recorded. | A source / B PATH-only controls；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| MC-018 · P1 · 启动诊断导出遗漏 JSON/连接串秘密，覆盖文件未收紧权限且保存错误逃出恢复流程 | Original complete87ab runtime with the final12 assertions actually passed2 and failed10; initial fixture correction, separate0/2 export red and candidate0/1 long-text slowdown are retained separately. Retained12/12 source controls are included in desktop113/113, use synthetic fields/local temporary files and cover quoted/escaped secrets, connection URI/auth headers, bounded200KB context, read-handle cleanup, cancel, new/overwritten0600 files and dialog/open/write failures. Function-byte equality links the audit42ead code location to discovery87ab, without relabeling a runtime. Actual installed startup-failure-page action and native save-panel execution remain a separate current-native gate. This is field masking, not arbitrary log anonymization; Windows ACL and real customer diagnostics remain unverified. These retained desktop113/subset controls keep their7fee execution provenance and are inherited only through the complete effective-input comparison; actual current MCD card runs are separately recorded. | A source / B actual synthetic controls and function-byte equality；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |

每张卡的原失败触发、代码位置、修复实现、可运行 command、断言结果与独立验证字段均在 [ledger.json](ledger.json)。`verified` 只适用于问题卡所列源码合同。MC-106 含完整双平台发行要求，仍保持 fixed/附条件；没有借源码通过把 Windows 或正式发行标为完成。

## 联动补修与复测

| root 编号 | 行为 | 独立记录对应 |
| --- | --- | --- |
| OBS-01 | 机器意见不抹除定妆照人类否决，新增 CLI 具名驳回 | OBS-01；[evidence/portrait-cli.json](evidence/portrait-cli.json) |
| OBS-02 | 交付检查验证必需产物 SHA-256，拒空清单和摘要不匹配 | OBS-02；[evidence/video-capabilities-core.log](evidence/video-capabilities-core.log) |
| OBS-03 | 织伴窄区收起与自动公告后恢复 | OBS-03；[evidence/ui-responsive.json](evidence/ui-responsive.json) |
| OBS-04 | 首日引导后验证无遮罩实际场景 | OBS-04；[evidence/client-生产修复 首次客户/render-default.json](evidence/client-生产修复 首次客户/render-default.json) |
| OBS-05 | CNB 完整分支和标签引用正确绑定 | OBS-05；[evidence/release-contract-production-final.log](evidence/release-contract-production-final.log) |
| OBS-06 | C 端生成投影与 UI/行业包摘要一致 | OBS-06；[evidence/static-release-production-final.log](evidence/static-release-production-final.log) |
| OBS-07 | 独立 M6 发现的父通道方法、阶段和镜号绑定缺口已补修 | independent OBS-07；[evidence/film-channel-parent-unit.log](evidence/film-channel-parent-unit.log) |
| OBS-08 | 遍历前排除开发依赖并拒绝源码链接越界 | independent MC-003；[independent-m6/desktop-supplement.log](independent-m6/desktop-supplement.log) |
| OBS-09 | 系统遥测完整合同与13个反例保留业务动作留痕要求 | independent MC-014；[independent-m6/geo-supplement.log](independent-m6/geo-supplement.log) |
| OBS-10 | 等待实际引导退出并给永不返回的renderer绑定硬截止 | independent OBS-04 + OBS-08；[independent-m6/render-guide-bounded.log](independent-m6/render-guide-bounded.log) |
| OBS-11 | 卸载后迟到模型销毁且WebGL能力探针只分配一次并释放 | independent OBS-09；[evidence/avatar-lifecycle-green.log](evidence/avatar-lifecycle-green.log) |
| OBS-12 | 截图前后重新检查实际场景，拒绝等待期间已失效的旧采样 | independent OBS-10；[evidence/desktop-scene-stale-after.log](evidence/desktop-scene-stale-after.log) |
| OBS-13 | 完成引导后迟到请求不降级状态，关闭首日引导后不被就绪抖动重新打开 | independent OBS-11；[evidence/welcome-terminal-real-pg-corrected.log](evidence/welcome-terminal-real-pg-corrected.log) |
| OBS-14 | 同版本标记存在但运行资产缺失时重建载荷，保留客户数据库和配置 | independent OBS-12 + MC-001 + MC-003；[evidence/desktop-recovery-marker-after.log](evidence/desktop-recovery-marker-after.log) |
| OBS-15 | 65人仪式按可滚动网格完整显示长姓名和角色标签，桌面和390窄视口均可到达末项 | independent OBS-13; ceremony density browser controls；[independent-m6/ceremony-density-final-repeat-results.json](independent-m6/ceremony-density-final-repeat-results.json) |
| OBS-16 | 2D职场按原生文字边界分配人物与名牌，完整卡片点击、首帧可见及用户滚动保留；生产CSS与绘制坐标一致 | independent OBS-14; Canvas label/click/viewport and full-production-CSS controls；[independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json) |
| OBS-17 | 3D职场名牌避让身体，实际身体点击和Canvas原生拖放按员工自身命中，65人相机覆盖边界 | independent OBS-15; actual 3D projection/label/pointer controls；[independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json) |
| OBS-18 | 舞台使用明确440px高度，实际Canvas填满场景且截图前后核对绘制区 | independent OBS-16; actual production stage and native canvas geometry；[independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json) |
| OBS-19 | 员工名牌在所属职场场景查找公司负责人牌匾，覆盖Fiber连接portal并保持场景隔离 | independent OBS-17; connected-portal CEO avoidance and scene isolation；[independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json) |
| OBS-20 | 演示重置确认、目标、客户识别、私有备份与事务并发检查失败关闭 | independent MC-017; separately discovered reset P0 controls；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| OBS-21 | 诊断导出覆盖JSON/连接串秘密、私有文件、长文本和保存失败恢复 | independent MC-018; separately discovered diagnostic P1 controls；[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json) |
| OBS-22 | 舞台实体地台与反射平面保持实际间距，消除原生截图地面撕裂 | independent OBS-18; actual stage solid/reflection geometry and pixel counterfactual；[independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json) |
| OBS-23 | 移除Live2D仅供上游文档部署使用的gh-pages边，关闭新HIGH依赖链 | independent MC-016; official new HIGH advisory and exact unused doc deployment edge removal；[independent-m6/dependency-1e47-structural-binding.json](independent-m6/dependency-1e47-structural-binding.json) |

编号映射以主题为准，详见 [independent-m6/observation-mapping.json](independent-m6/observation-mapping.json)。原父通道红用例、renderer 悬挂控制、组件红运行均保留，修复后同类控制转绿，没有提高原等待阈值。冻结源码的密集仪式原运行3/4包含390就绪超时，同脚本同15s/90s阈值窄复测4/4；两份记录保留，超时唯一根因未证明。[A/B；视觉样本C、根因D]

## 实际测试和限制

| 维度 | 前提与步骤 | 预期/实际 | 证据 |
| --- | --- | --- | --- |
| 正常/权限/错误认证 | production HTTP、非示例假工作区；匿名、错 key、有效 key、非法 JWT | 11/11；匿名不能取 owner，合法本机身份固定 | [independent-m6/auth-http-results.json](independent-m6/auth-http-results.json) |
| 并发/审批/编辑/终态/隔离 | 真 PG + 本地工具计数器；重放、同时续跑、参数修改、十条待办、两工作区同理由 | 9/9；禁止调用为0，批准最多1次， edited 生效，终态保持 | [independent-m6/runtime-repro-results.json](independent-m6/runtime-repro-results.json) |
| 凭证边界 | 20 个权限/凭证错绑/复用/失败最终落账控制 | 20/20；无实际供应商外呼 | [independent-m6/gateway-permit-results.json](independent-m6/gateway-permit-results.json) |
| 影片阶段和产物 | 公开 start/status + 真实子进程；本地 cine-kb/continuity、缺输出、1ms 控制截止 | 成功5项与两个失败关闭场景绿；父通道13项绿 | [independent-m6/film-public-success-results.json](independent-m6/film-public-success-results.json)、[independent-m6/parent-channel-after-results.json](independent-m6/parent-channel-after-results.json) |
| GEO 回归 | 原5条系统错误事件保持；完整遥测合同和13个反例 | 83/83；没有删除失败留痕换绿 | [independent-m6/geo-supplement.log](independent-m6/geo-supplement.log) |
| 演示重置权限/边界/错误 | 含合成.env；psql/pg_dump/pnpm/docker均为PATH替身；无确认、生产/远端/重定向、客户、未知库、备份/SQL/迁移失败及IPv6和配置正控 | 原8组0通过/8失败保留；当前12组需独立实际通过；备份0600、失败停止且不种子 | [evidence/reset-safety-before.log](evidence/reset-safety-before.log)、[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json)，B |
| 诊断权限/秘密/性能/失败 | 合成JSON/dotenv/连接串/授权头、错误摘要、200KB文本、取消/覆盖/保存异常；实际原函数与导出动作 | 原12项2pass10fail；root12/12，属于完整113的子集，不重复相加 | [evidence/diagnostic-complete-original-before.log](evidence/diagnostic-complete-original-before.log)、[evidence/diagnostic-contract-after.log](evidence/diagnostic-contract-after.log)、[independent-m6/ledger-verification.json](independent-m6/ledger-verification.json)，B |
| 桌面/引导/异步生命周期 | 桌面包含真实Canvas几何、负责人牌匾、演示重置和诊断反例；旧控制只在完整输入字节不变范围沿用 | 独立113/113；实际执行源码 `7fee3a6a5563`；当前依赖变更仅按完整输入/锁语义比较作B级限定继承，没有改写执行SHA；完整绑定见case-matrix；各控制保留原执行记录 | [independent-m6/surface-7fee-desktop.log](independent-m6/surface-7fee-desktop.log)、[independent-m6/case-matrix.json](independent-m6/case-matrix.json)、[independent-m6/web-lifecycle-independent-fixed.log](independent-m6/web-lifecycle-independent-fixed.log) |
| 引导请求次序与终态 | 实际React钩子、独立ready抖动、真PG迟到完成/暂停/进度 | 提交钩子8/8，独立ready4/4；独立PG5/5，服务端8/8；完成不回退且不追加假完成事件 | [independent-m6/welcome-client-after.log](independent-m6/welcome-client-after.log)、[independent-m6/questline-ready-after.log](independent-m6/questline-ready-after.log)、[independent-m6/welcome-progress-after-results.json](independent-m6/welcome-progress-after-results.json) |
| 截图期间场景改变/缓存缺失 | 实际主进程异步采样、公开bootstrap真实缺缓存夹具 | 旧采样独立8/8；恢复保留数据库/.env/标记，故障前红保留 | [independent-m6/render-guide-transient-after-results.json](independent-m6/render-guide-transient-after-results.json)、[evidence/desktop-recovery-marker-after.log](evidence/desktop-recovery-marker-after.log) |
| 65人密集仪式 | 1440和390实际浏览器；65人长姓名/标签、滚动末项、小团队对照 | 原冻结运行3/4含390就绪超时；同脚本同15s/90s阈值窄复测4/4，无重叠/文字溢出/页面溢出 | [independent-m6/ceremony-density-final-results.json](independent-m6/ceremony-density-final-results.json)、[independent-m6/ceremony-density-final-repeat-results.json](independent-m6/ceremony-density-final-repeat-results.json)，C |
| Canvas original physical layout/profile/card counterexamples | Actual product Floor/installed naming/GEO scene plus exact production CSS; desktop Chromium; controlled300 native product frames; no external network. | 24/24；原断言及截止没有放宽；实际执行SHA `d6a100b60218` | [independent-m6/floor-canvas-production-final-results.json](independent-m6/floor-canvas-production-final-results.json)，B；截图样本C |
| Canvas first painted frame, long names,65 actors,card edges and mutation boundaries | Actual product first native painted frame, same production CSS; independent65 long-role/Unicode fixtures; desktop and390 narrow widths. | 14/14；原断言及截止没有放宽；实际执行SHA `d6a100b60218` | [independent-m6/floor-canvas-boundary-production-final-results.json](independent-m6/floor-canvas-boundary-production-final-results.json)，B；截图样本C |
| Canvas initial visibility and preserving real manual scroll through poll/resize | Actual product first frame at65 idle390 and working1440, original production CSS and reduced-motion preference; no verifier initial scroll. | 7/7；原断言及截止没有放宽；实际执行SHA `d6a100b60218` | [independent-m6/floor-canvas-initial-viewport-production-final-results.json](independent-m6/floor-canvas-initial-viewport-production-final-results.json)，B；截图样本C |
| 3D actual production-CSS plaques,glyphs,body/profile and task/idle plaque clicks | Actual imported Floor3D/R3F/Drei/BusinessAvatar/cinematic, original exact CSS; native WebGL/RAF; nine original fake18/single actor scenes; default optional-drop disabled. | 28/28；原断言及截止没有放宽；实际执行SHA `f0a11286a494` | [independent-m6/scene-f0-default-results.json](independent-m6/scene-f0-default-results.json)，B；截图样本C |
| Optional onDropTask original28 plus27 actual synthetic browser delivery boundaries | Same actual nine production-CSS/WebGL scenes with the supported component onDropTask prop enabled; currentP0 does not pass this prop; public synthetic task payloads only. | 55/55；原断言及截止没有放宽；实际执行SHA `f0a11286a494` | [independent-m6/scene-f0-drop-results.json](independent-m6/scene-f0-drop-results.json)，B；截图样本C |
| Additional65-person and queued/collab interactions, fresh polling,resize,zoom and disabled-roster boundaries | Actual product/productionCSS/WebGL at65 idle390 and working1440 plus18 queued390 and collab1440. Supported onDropTask prop enabled; synthetic task payloads and actual native mouse/wheel/RAF. | 29/29；原断言及截止没有放宽；实际执行SHA `f0a11286a494` | [independent-m6/scene-f0-edges-results.json](independent-m6/scene-f0-edges-results.json)，B；截图样本C |
| Actual short/long legal Chinese hover text and complete bubble/glyph viewport containment at1440 and390, with profile/plaque and optionaldrop controls | Actual product HoverBubble/Floor3D/productionCSS; four single-agent scenes with short Chinese or long Chinese plus Unicode state text, supported optionaldrop enabled. Browser pointer and actual product gaze/hover listeners; actual computed visibility must be visible. | 33/33；原断言及截止没有放宽；实际执行SHA `f0a11286a494` | [independent-m6/scene-f0-hover-results.json](independent-m6/scene-f0-hover-results.json)，B；截图样本C |
| Separate unregistered English/camel status uses the actual Chinese safety fallback at1440 and390 | Actual imported Floor3D/HoverBubble/installed clientChineseText and exact productionCSS; original unregistered English status string retained in a separate fixture. No optional drop or paid/provider/database I/O. | 3/3；原断言及截止没有放宽；实际执行SHA `f0a11286a494` | [independent-m6/scene-f0-safety-results.json](independent-m6/scene-f0-safety-results.json)，B；截图样本C |
| Actual selected product floor component and layout regressions, including dynamic it.each cases | Actual committed Vitest/React/jsdom or pure allocator tests; original product test timeout; no real GPU/task model inference in this selected group. | 36/36；原断言及截止没有放宽；实际执行SHA `7fee3a6a5563` | [independent-m6/surface-7fee-product-test-results.json](independent-m6/surface-7fee-product-test-results.json)，B；截图样本C |
| Actual current Stage definite440 and connected-portal CEO boundaries under production CSS | Actual imported Stage3D/Floor3D/cinematic/BusinessAvatar; deterministic64 stage team/18 workplace; actual production CSS and desktop Chromium1440/390; no provider/DB/native cold claim. | 7/7；原断言及截止没有放宽；实际执行SHA `7fee3a6a5563` | [independent-m6/surface-7fee-layout-results.json](independent-m6/surface-7fee-layout-results.json)，B；截图样本C |
| 完整业务套件/构建 | root 标准套件、类型、三端构建及 release/onboarding/静态门禁 | 原日志记录各自执行 SHA；套件482/482；不相加成唯一测试样本 | evidence 目录和独立 case-matrix |
| 视口/截图样本 | 1440×900 与390×844真实页面；Mac实际渲染另列 | 无横向溢出，窄屏mini；不是完整 UX、真手机或无障碍验收 | [evidence/ui-responsive.json](evidence/ui-responsive.json)，C |

当前源码逐卡修复的第一次GEO执行实际82/83，C-15在既有假库读到16条演示账号指标；该次C-16又按当天种子补入2条，因此后续只读核对为18条、九个日期。完整阅读`seed-geo.ts`与`suite-geo.ts`后，定位到滚动日期种子与“七天×两账号”测试前提漂移。全部18条原始合成记录先保存，严格核对本任务数据库、端口、数据目录、示例工作区与simulated标记后，只从该临时夹具移出4条超出当前七天的演示指标；事件账本、产品源码、测试断言和等待阈值保持原值。恢复前提后重新实际执行整轮repair；独立acceptance另执行，原失败收据未改写。见 [runs/MC-014-0-1791055106674.json](runs/MC-014-0-1791055106674.json)、[evidence/mcd-geo-date-drift-original-synthetic-metrics.json](evidence/mcd-geo-date-drift-original-synthetic-metrics.json) 和 [evidence/mcd-geo-date-drift-prerequisite-restored.json](evidence/mcd-geo-date-drift-prerequisite-restored.json)。这项操作是测试前提恢复，不是产品修复或生产数据清理。[A：种子/测试完整阅读；B：实际行、事务与执行回执]

独立专项当前目标用例 **558** 条，逐条“前置、步骤、预期、实际”见 [independent-m6/case-matrix.csv](independent-m6/case-matrix.csv)。原广域 base PG 运行保留 1355 pass /8 timeout fail /7 skip（1370用例、79文件），其后在原阈值下分别跑 bundles11、devbridge30、audio2均通过；原广域红结果没有改成绿，也没有把并发资源作为已经证明的唯一原因。[B；原因外推 D]

3D在d6源码的完整生产样式原默认28项实际26通过、2失败，启用旧透明接收区实际24通过、4失败；身体点会被别人的HTML牌子截获。首次65人边界探针也实测26/29，靠近镜头的身体投影在Canvas外。原失败截图、结果、当前反例与逐字节来源保留在 [independent-m6/floor-final-verification.json](independent-m6/floor-final-verification.json)。本轮由新的修复角色解决严格身体避让、同人数轮询扩容保留、同一球体射线拖放与默认相机覆盖，独立角色再跑最终原控制。[A/B；截图C]

状态气泡的第一份长文本夹具含未登记的英文，实际中文安全边界返回了正确的备用中文；该次27/29不能算产品失败。更正为合法中文后尺寸29/29曾通过，但截图抓到390宽度下文字被滚动区域裁切；后来补了完整外框和逐字Range可见性4项，在旧源留下真实32/33红结果，再修复投影位置。最终中文33正控与英文安全负控各自执行，预期没有混用；原27/29、29/29的限定及更正来源均保留。[A/B；截图C]

没有真实业务交付分母，ADR/HIR/ROI、真实模型能力和付费生成效果均未验证。确定性重复用例不当独立业务样本；没有编造 Wilson 区间、用户研究、价格或产出价值。完整 RDAS 的 U/O/P、12红线、统计校准与验收债见独立 [RDAS专项报告](independent-m6/REPORT.md)。[D 未测指标]

## 精确 Mac 原生包

[evidence/dependency-payload-fingerprint.json](evidence/dependency-payload-fingerprint.json) 和 [evidence/dependency-payload-source-closure.json](evidence/dependency-payload-source-closure.json) 证明 2093 个非依赖运行文件与 source/build 字节一致。[evidence/dependency-app-fingerprint.json](evidence/dependency-app-fingerprint.json) 证明主进程、bootstrap、preload、render helper 与同一源码相同；公开资产来自原有本地缓存，产品装配器仍逐个核对固定 SHA。[B]

| 原生用例 | 环境/步骤 | 实际结果 | 证据 |
| --- | --- | --- | --- |
| default | 独立空中文路径，首次bootstrap和真实渲染 | exit0，72.395s | [evidence/mac-dependency-default.json](evidence/mac-dependency-default.json) |
| default-repeat | 独立空中文路径，首次bootstrap和真实渲染 | 未完成，不能标通过 | D |
| safe | 独立空中文路径，首次bootstrap和真实渲染 | exit0，106.95s | [evidence/mac-dependency-safe.json](evidence/mac-dependency-safe.json) |
| fresh | 实际安装程序，独立support；重启/升级复用已有私有状态 | exit0，30.874s | [evidence/mac-dependency-fresh.json](evidence/mac-dependency-fresh.json) |
| restart | 实际安装程序，独立support；重启/升级复用已有私有状态 | exit0，5.612s | [evidence/mac-dependency-restart.json](evidence/mac-dependency-restart.json) |
| upgrade-seed | 实际安装程序，独立support；重启/升级复用已有私有状态 | exit0，234.076s | [evidence/mac-welcome-upgrade-seed.json](evidence/mac-welcome-upgrade-seed.json) |
| upgrade | 实际安装程序，独立support；重启/升级复用已有私有状态 | exit0，34.298s | [evidence/mac-dependency-upgrade.json](evidence/mac-dependency-upgrade.json) |

default 和 safe 分别使用完全不同的全新客户目录；最终正常运行不加 CDP。a403 引导失败、09bc 冷启动 avatar 失败与后来 CDP 暖重试通过各自独立保留，暖重试不当冷启动修复证据。ad4实际全新default用例exit1、721.660s，firstDayGuide.closed=false；随后另一个全新目录的v2 CDP诊断exit0，观察到completed/done之后仍有迟到in_progress/summary，诊断并不能替代原未加CDP失败的修复证明。两组图片和收据独立归档，最终955e冷启动实测另列。旧失败 render PNG 曾被诊断重试覆盖，原 log/JSON及工具图仍有，不能宣称原 PNG 保留；完整诊断快照也曾被同名 runner 元数据覆盖，仅恢复6个实际 stdout 快照，详见 retained-snapshots 和 cleanup 记录。[B/C]

同一955e源码的第一轮全新default实际exit1、561.676s，渲染观察停在“正在确认访问范围”；复用该失败目录加CDP的诊断exit0、167.315s，仅是暖诊断。其observer最终有39次页面采样、50条网络记录（26 request、23 response、1 failed）和2条错误。随后完全不同的新空目录default-repeat、不加CDP的冷复测实际exit0、342.554s；Live2D、口型/眨眼/动作、65人仪式、guide.closed=true和截图前后均无遮罩的职场/舞台通过。原冷失败及其日志/JSON/PNG保持独立，复测通过没有证明第一轮失败的唯一根因，也没有提高原60s/10s阈值。对应收据与5文件保留摘要见 [evidence/native-welcome-default-repeat-retention.json](evidence/native-welcome-default-repeat-retention.json)。[B；截图C、唯一原因D]

重启和升级的私有状态检查见 [evidence/native-dependency-fresh-state-before.json](evidence/native-dependency-fresh-state-before.json)、[evidence/native-dependency-fresh-state-after.json](evidence/native-dependency-fresh-state-after.json)、[evidence/native-dependency-upgrade-state-before.json](evidence/native-dependency-upgrade-state-before.json)、[evidence/native-dependency-upgrade-state-after.json](evidence/native-dependency-upgrade-state-after.json)。当前dependency轮实际升级是 `.5 → .6`，使用升级前即时采集的`.5`摘要；更早`v1 → .5`的原始证据另行保留在 [evidence/native-welcome-upgrade-state-before.json](evidence/native-welcome-upgrade-state-before.json)，不宣称这轮直接从v1升级。检查配置/凭据摘要、随机实例身份、实际PG systemIdentifier和带中文/引号/emoji的客户测试行摘要；只操作本任务创建的QA客户目录，没有读取或写入外部客户数据。最终DMG实际挂载、拷出、签名与app.asar/payload核对记录见 [evidence/dependency-dmg-fingerprint.json](evidence/dependency-dmg-fingerprint.json)。[B]

安装包采用本地 ad-hoc 签名，未公证、未带正式行业 bundle trust；因此不作为客户 stable 正式发行承诺。Windows x64 未在本机解析/执行安装器，也未运行 pgvector DLL、普通用户安装/卸载/升级。源码合并后已实际创建 source-bound `v0.1.0` 候选并触发现有 signed 双平台 native pipeline；两个原生 Prepare 均因匹配的 group runner 未分配而失败，实际构建、签名、真机和发布步骤未执行。签名凭据和行业 trust 是否就绪不能从 Prepare 失败外推。[B：实际流水线；D：未执行平台条件]

历史c083/v.3应用default61.780s与safe56.198s均exit0，但8张实际截图仍暴露舞台下部黑区和负责人牌匾相交，独立像素复核因此判QA未通过。两轮原件和旧app.asar/payload字节另行保留，不能拿exit0代替视觉合同。之后f951/v.4几何通过，实际PNG仍有舞台地面撕裂；完整读取发现实体地台顶面和反射平面重合。OBS-22将实体地台下移3cm，保留舞台相机、灯光、材质、动画和事件；两条几何反例及两个视口最小截图对照分别验证。GPU撕裂的唯一根因未证明，最终dependency包按实际像素另判。当前包核对截图前后Stage场景与Canvas高度一致、WebGL可用、负责人牌匾无相交，也在数字人口型/眨眼/动作完成后通过实际“收起为小球”按钮释放场景空间。[A/B；截图C、唯一原因D]

本次最终包在独立QA支持目录与空Resources入口展示真实启动失败页，通过该页面的导出动作和系统保存对话框保存合成日志诊断。实际应用/主进程摘要、导出字节/权限和秘密缺失/上下文保留断言见 [evidence/native-dependency-diagnostic-export.json](evidence/native-dependency-diagnostic-export.json)；这是当前机器上的实际客户UI检查，与源函数的12条夹具用例分开留证。历史字段actual_native_menu在本轮指失败页动作，实际操作面见action_surface；未验证macOS系统菜单的导出入口。[B；GUI截图C；系统菜单D]

## 可复跑、发布与边界

复跑脚本仅用于本任务隔离数据库和本地无供应商夹具。先按当前仓精确依赖安装、生成独立 .env、迁移种子并确认 target；不得把客户库替代测试库。`pnpm test:desktop`、相关 runtime/gateway/Auth/film 测试、`pnpm suite:geo`、类型及三端构建的命令来自实际运行收据和仓库 package.json。更完整的命令、前置状态和失败输出见独立 case-matrix；端口未起的连接拒绝不算权限通过。[A/B]

仓库自带旧排雷执行器只检查台账字段，原schema门禁绿色是B级元数据。此次额外使用本机受控新版执行器，原16问题、新增重置P0、诊断P1和6修复卡均不导入历史绿色，由root实际执行repair断言，再由growth_m6独立执行acceptance断言。[execution-ledger.json](execution-ledger.json) 与 [evidence-index.json](evidence-index.json) 包含实际argv、角色、源码SHA、输出文件和摘要；Node测试由真实TestsStream记录非零测试计数。实际回读门禁见 [execution-gate.json](execution-gate.json)，交接见 [execution-handoff/handoff.json](execution-handoff/handoff.json)。23张源码卡独立verified；MC-106只有源码repair检查，仍fixed且保留正式平台条件。重复执行不增加真实业务样本分母。[B]

CNB源码三闸回执绑定 source_head `1e471c34ed5c05c5ac6d791ac5b7aa731d3e8de8`，statuses.sha 是不同的 synthetic merge；各次提交回执在 evidence 中保留。本会话PR318已普通受保护合并到 main，合并提交为 `f50a0f5be2be4ba053d918e07a94e45cdae4e4c2`；匿名Git回读证明接受源码为祖先且整个Git树逐字节一致。本会话18批修复提交全部进入该main，Issue316已留五行回执并关闭。见 [evidence/cnb-pr318-unblock-merge.json](evidence/cnb-pr318-unblock-merge.json)、[evidence/cnb-pr318-anonymous-main-proof.json](evidence/cnb-pr318-anonymous-main-proof.json)、[evidence/cnb-all-owned-source-batches-merged.json](evidence/cnb-all-owned-source-batches-merged.json) 和 [evidence/cnb-pr318-source-task-closed.json](evidence/cnb-pr318-source-task-closed.json)。不把后续文档SHA改写成实际测试执行SHA。[B]

正式客户端流水线 [cnb-s2t-1k421u483](https://cnb.cool/workloom-ai/WorkLoom-growth/-/build/logs/cnb-s2t-1k421u483) 实际失败：Mac/Windows的Prepare没有匹配 `workloom-growth-desktop-macos` / `workloom-growth-desktop-windows` 标签的group runner；主发布者main/tag/SHA检查通过后，在等待Mac候选时失败，公开Release步骤未执行。原状态见 [evidence/cnb-main-signed-native-status-first.json](evidence/cnb-main-signed-native-status-first.json)；直接错误分别见 [evidence/cnb-signed-macos-prepare-detail.json](evidence/cnb-signed-macos-prepare-detail.json)、[evidence/cnb-signed-windows-prepare-detail.json](evidence/cnb-signed-windows-prepare-detail.json)。[CNB构建节点官方文档](https://docs.cnb.cool/zh/build/build-node.html)说明group节点需接入、启用并匹配标签；这里仅报告此次分配失败，不猜测凭据条件。剩余Windows、正式签名/trust、完整RDAS和证据归档独立登记在 [Issue322](https://cnb.cool/workloom-ai/WorkLoom-growth/-/issues/322)，按用户最新指令保留待优化事项，源码任务发布锁已释放。[B：实际回执；D：未执行补验]

清理只移除本任务已停止的可重建 runtime/cache 或重复 QA应用。最终welcome轮清理要求先把私有QA配置另存为0600并核对摘要，再保留数据库、状态、版本和日志；执行结果以对应retention收据为准。旧“引导修复 默认客户”和“生命周期 默认客户”两处runtime清理曾删除生成的.env，原先的配置保留声明不准确，已在 [evidence/native-config-preservation-correction.json](evidence/native-config-preservation-correction.json) 明确更正；不导出密码/token，不扫描或关闭其他会话服务。历史包拆出的 app.asar 和公共payload bytes保留；旧整.app壳清理有单独记录。没有让测试fixture进入真实经营 ADR 分母。[B]

## 收尾报告

- 已完成：16个原问题及后续发现的重置P0、诊断P1源码修复、23项联动补修、完整源码清单与分级；隔离真库/生产HTTP/真实子进程回归；独立M6源码专项；精确载荷/应用比对与原生用例和启动失败页诊断导出回执；回滚和复跑合同；CNB三闸通过、18批源码修复普通合入main及匿名整树回读、原任务卡回执关闭、正式双平台流水线实际尝试和后续问题卡。
- 未完成/未覆盖：完整Windows原生和正式双平台发行、真实供应商成片/真实经营生产域、所有页面/连接器/长跑/无障碍；当前正式流水线在匹配原生runner分配前失败，后续门禁未执行，记录于Issue322。当前接受Mac本地QA已独立通过，正式平台条件保留。Growthtest/Matrix属于根任务后续独立交付，不由本报告充数。
- 自主追加事项及理由：独立验收抓到父通道绑定和renderer截止缺口；真包抓到引导空帧与迟到加载；复核发现演示重置P0，纳入新卡和CI而非只写建议；为了防止假修复，追加负例、保留红运行、全量字节比对和私有状态升级核对。没有新增无关产品功能或真实账户动作。
- 采用的假设：源码修复针对已复现合同；本地隔离进程/PG可证明列出的时序和权限，不外推真实供应商；Mac本地QA只证明该机器/包/fixture；接收仓保持身份与实验差异并必须目标仓验证。
- 置信度：已测源码与合同高，依据完整受影响实现和独立控制；跨平台正式发行/真实经营低，因所需原生/签名/外部回执缺失。没有用单一覆盖率概括可交付性。
- 建议复核：MC-005/006/007的独立HTTP/计数结果；final cold default/safe截图与升级私有状态摘要；独立报告的未测276项及正式发行债。

## 自检表

- [是] 覆盖了任务全部范围，而非挑了容易的部分？本报告覆盖Growth全部已发现问题和联动补修，跨仓/平台/生产未测项逐项说明并继续根任务。
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？已自主修复、验证、打包、留证、发布准备；外部必需环境门槛保持明示。
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？完整源清单、执行收据、代码函数、独立角色与失败记录可复查；A/B/C/D分别声明。
- [是] 经得起资深工程师逐行审查？没有骨架或吞失败获取绿，原广域红和原生失败均保留，独立角色不同，未把源码测试冒充生产结果。
