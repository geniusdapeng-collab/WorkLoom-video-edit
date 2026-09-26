# Growth 能力审计 · 缺口台账（活台账）

> **唯一事实源**：本文件记录「视频管线与数字员工能力审计」的缺口、处置与证据；随修复更新，不回改历史。
> **口径**：严重度 P0（阻断/红线）> P1（影响质量或成本）> P2（卫生/债务）；状态 `OPEN` / `IN_PROGRESS` / `FIXED` / `WONTFIX` / `PROPOSAL`。
> **边界**：只优化业务逻辑与行业 Know-How，不改输入输出与字段数据结构（对象字段、五元事件、管线拓扑、围栏级别、DB、API）。
> **基线**：`WorkLoom-growth@f2ac5dec`（2026-09-26）。机检清单见《Growth 审计范围基线 v1.0》。

| ID | 批次 | 单元 | 类型 | 严重度 | 现象 | 根因（文件:行/函数） | 处置 | 回归用例 | 状态 | 证据等级 |
|---|---|---|---|---|---|---|---|---|---|---|
| GAP-0001 | B2 | 营销片 `truth-check` | T1 纸门 | P0 | 事实红线闸在管线里声明「ProductTruthChecker 一票否决」，但全仓机检无任何 require/调用点 | `vendor/supermickey/hyperreality-system/engines/production-engine/agents/product-truth-checker.js:117`（`class ProductTruthChecker`，仅自引用） | 待接线：把档案事实基线映射为 `researchNotes` 并在创意主题后调用 `verify()`；命中冲突即打回创意 | 待建（接线批次） | OPEN | B（全量 rg）+ A（文件精读） |
| GAP-0002 | B3 | 投流素材工厂 | T1 纸门 | P1 | `hook-performance-store.js` 零引用，钩子表现回填无实现 | `vendor/.../agents/hook-performance-store.js` | 登记；评估接线或降级声明 | — | OPEN | B |
| GAP-0003 | B2 | 营销片时长约束 | T1 纸门 | P1 | `marketing-duration-bridge.js` 零引用，营销片时长约束是否落到共享段未经证明 | `vendor/.../agents/marketing-duration-bridge.js` | 与 GAP-0001 同批核验；无消费方则降级声明 | — | OPEN | B |
| GAP-0004 | B1 | 多风格交付 | T1 纸门 | P1 | `platform-variant-fanner.js` 零引用，平台变体是否由别的实现承担未证明 | `vendor/.../agents/platform-variant-fanner.js` | 核验 `deliver.ts` 是否覆盖其职责；否则登记 | — | OPEN | B |
| GAP-0005 | B1/B2 | 全部门（G1–G9/G-MAT1/G-DLV） | T7 孤儿产出 | P1 | 门事件按 step_key 落 `stages.jsonl`，但平台侧执行器未读该账本（CLI 侧已读） | `apps/server/src/video/studio-worker.ts`（走 `onApproval`）；`packages/video-studio/src/gate-ledger.ts#readGateEvents` 仅测试与 CLI 使用 | 设计只读消费点（审计视图/前置校验），不改契约 | — | OPEN | B + 现状文档 |
| GAP-0006 | B1–B5 | 91 个包内技能 | T9 资产深度 | P1 | 绝大多数技能只有「适用场景/方法/输出契约」，缺决策原则/阈值来源/失败模式 | `bundles/*/skills/*/SKILL.md` | 按 S-A/S-B/S-C 分型逐批补强；新增只读审计器量化 | `packages/base/bundles/agent-knowhow.test.ts` | IN_PROGRESS | B（结构机检） |
| GAP-0007 | B2 | 营销前置两站（`jenny-loom-research` / `marketing-brief-parser`） | T9 资产深度 | P1 | 两技能各 21 行，只有流程摘要：无决策原则、无阈值来源、无失败模式，真机遇偏倚样本/冲突价格/缺要素时只能靠模型自由发挥 | `bundles/ai-video/skills/jenny-loom-research/SKILL.md`、`.../marketing-brief-parser/SKILL.md` | **FIXED（T-2026-0926-0101）**：补齐决策原则（无源不入库/置信度三级/域名去重/冲突不仲裁/卖点 ≤3/用户共识优先）、四种场景打法、五步 SOP（触发/回执/失败）、指标护栏表（含来源）与失败模式表 | `agent-knowhow.test.ts`（24 项全绿）；`scripts/tools/agent-knowhow-audit.mts` | FIXED | A（精读+回归） |
| GAP-0008 | B1/B2 | 事实红线评审（`director-review`） | T9 资产深度 | P1 | 21 行摘要未写清硬阻断优先级、五维不过线判定、事实红线以 confirmed 字段为准、评审输入必须含正文（真机曾因只送路径被打回 58 分） | `bundles/ai-video/skills/director-review/SKILL.md` | **FIXED（T-2026-0926-0101）**：补齐 7 条决策原则、四种评审形态打法、五步 SOP、6 项指标与 6 条失败模式（含"无正文可核验""朝向误判""平均分掩盖短板"） | 同 GAP-0007 | FIXED | A |
| GAP-0009 | B2 | 视频域考题覆盖 | T2 无证据 | P1 | `bundles/ai-video` 无 `eval/`，27 名环节员工零考题覆盖（仅 geo-growth 有 30 题） | `bundles/ai-video/` 缺 `eval/questions.json` | 按 `eval-core` schema 建最小题集（不改表结构） | — | OPEN | B |
| GAP-0010 | B5 | hotel 技能资产 | T7 孤儿 | P2 | 10 个技能无任何 preset 绑定（`ai-live-assistant`/`content-marketing`/`fast-scan`/`inspection-suite`/`ota-operations`/`overbooking-parity-guard`/`pricing-matrix`/`review-asset-mining`/`safety-compliance`/`staff-scheduler`） | `bundles/hotel/presets/*.yml` 的 `skills` 字段 | 裁定：补绑定（走提案）或登记为可装配能力 | — | OPEN | B |
| GAP-0011 | B1–B3 | vendor 阶段兜底 | T5 静默降级 | P0/P1 | 既有审计器可扫出 `FIELD_GUARD` 默认模板覆盖、子 Agent 全失败退规则兜底等"看起来成功"的路径；尚未逐条裁定 | `scripts/tools/pipeline-agent-audit.mts` 输出；`vendor/.../field-guard.js` 等 | 逐条判定是否已显式记 `degraded`，未记的按 P0 处置 | — | OPEN | B（待 A 级确认） |

## 变更记录

| 日期 | 批次 | 变更 |
|---|---|---|
| 2026-09-26 | T-2026-0926-0101 | 建账（GAP-0001…0011）；完成 GAP-0007/0008 两项 Know-How 强化并锁回归；新增只读审计器 `scripts/tools/agent-knowhow-audit.mts` |
