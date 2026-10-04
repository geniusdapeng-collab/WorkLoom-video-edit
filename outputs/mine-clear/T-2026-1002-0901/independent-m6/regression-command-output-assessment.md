## 覆盖率声明
- 范围内文件总数：20；精读：19；机检/脚本解析：1；抽样：0；未读：0。
- 文件逐项完整路径、行数及 SHA256 见同名 JSON 的 files；本范围为 16 问题卡命令、执行器与输出/种子调用链，不声称全仓精读。

本次为只读风险评估。没有运行新版或旧版 executor，没有启动测试、写业务库、修改产品/台账；当前源仍 dirty，当前源码和 native 验收没有因此转绿。

原 16 问题卡的 18 条断言会复用多个固定结果路径。新版 MCD 唯一记录 stdout 和真实 Node 测试摘要，不能隔离测试内部写文件。应在最终源码/native完成后，在新的唯一 execution-ledger 与每卡/断言/角色沙箱中实际执行。[A 源码；D 尚未执行的方案]

| 卡片 | 命令实际输出 | 主要风险 | 控制建议 |
| --- | --- | --- | --- |
| MC-001 | stdout/stderr of six Node test files; stated .log is only an outer capture destination | No fixed evidence file written by the command itself; redirecting to the stated historic .log would overwrite it | Use actual pinned Node --test with the six unchanged package.json test paths, unique MCD capture; record exact argv and real TestsStream counts |
| MC-002 | stdout/stderr; verifyRuntimeDepsLock reads manifest/locks/input files | verify does not call refresh/stage or write those files; an outer redirect to historic .log would overwrite it | Pinned Node scripts/runtime-deps-lock.mjs verify; unique capture; retain exact input digests |
| MC-003 | stdout/stderr of six Node test files; stated .log is only an outer capture destination | No fixed evidence file written by the command itself; redirecting to the stated historic .log would overwrite it | Use actual pinned Node --test with the six unchanged package.json test paths, unique MCD capture; record exact argv and real TestsStream counts |
| MC-004 | stdout/stderr of six Node test files; stated .log is only an outer capture destination | No fixed evidence file written by the command itself; redirecting to the stated historic .log would overwrite it | Use actual pinned Node --test with the six unchanged package.json test paths, unique MCD capture; record exact argv and real TestsStream counts |
| MC-005 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/auth-production-http.json | Fixed JSON replaced on successful completion; fixed loopback port 28878 must be exclusively owned | Copy reviewed harness into a new per-attempt directory; explicitly bind fixture absolute path, unique result path and available port; add --repo with absolute source |
| MC-006 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-007 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-008 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-009 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-010 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-011 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-012 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/runtime-repro-results.json | Every --case and full run writes the same file; later single case replaces current nine-case aggregate | Copy runtime-repro.mts plus local-counter.mjs byte-for-byte into a fresh per-card/per-assertion/per-role directory; its self-relative JSON then stays unique; keep --assert and actual --case |
| MC-013 | /Users/mac/Documents/Codex/2026-10-02/growth-growth-https-cnb-cool-workloom/outputs/growth-production-fix-2026-10-02/evidence/film-worker-public-success.json | Success JSON is fixed; HR_WORK_DIR defaults to repo/work/repair-film-route even though each job has a UUID | Copy reviewed harness to a new attempt directory; bind unique result and HR_WORK_DIR outside product; retain source/rewritten-path hashes and success/missing-output/deadline cases separately |
| MC-014 | stdout/stderr; suite internally invokes db:seed:geo and db:verify-chain | No fixed result JSON/log writer in suite; seed mutates fixture DB, so a unique output path alone cannot isolate effects | Use exact owned fake database and exclusive PG window; unique capture; preserve five original system-error rows/hashes, snapshot mode/identity before and after |
| MC-015 | stdout/stderr from scripts/video-capabilities.test.mjs; owned mkdtemp fixtures cleaned in finally | No fixed historical evidence writer; outer redirect to existing video-capabilities-core.log would replace it | Pinned actual Node --test scripts/video-capabilities.test.mjs; unique TestsStream capture |
| MC-016 | pnpm stdout/stderr from current online registry advisory request | Command has no stated fixed JSON writer; outer redirect to historical dependency-audit.json would replace it | Pinned Node plus pinned pnpm CLI argv audit --prod; unique capture, registry/time/lock digest and actual result recorded |

## 风险与证据

- **REG-01 [A]** Unique MCD stdout capture does not sandbox internal fixed result writers。出处：assets/evidence.mjs:230-262; runtime-repro.mts:156; auth-production-acceptance.mjs:79; film-worker-acceptance.mts:54。处理：Keep original files/hash snapshots intact; isolate reviewed harness closure and output for every attempt。

- **REG-02 [A]** Existing repository executor has no run-assertions entry; skill shell wrapper chooses it whenever present。出处：scripts/delivery/mine-clear.mjs:729-739; skill scripts/run-mine-clear.sh:31-34。处理：If later authorized, call the fixed offline assets/mine-clear.mjs directly and preserve hashes for evidence.mjs/reporter; do not mutate governance source。

- **REG-03 [B/A]** 22 cards, 24 assertions have zero exec fields and zero run fields; discovery references have no SHA256; verification_evidence is a bare path。出处：ledger.json full JSON parse; assets/mine-clear.mjs:184-219, 295-332, 608。处理：Build a separate versioned execution-ledger with real argv and actual runs; old schema gate remains only metadata proof; do not import old green as actual new execution。

- **REG-04 [A]** MC005/MC102 human regression lacks --repo required by the actual auth harness。出处：auth-production-acceptance.mjs:9,16。处理：Record the actual absolute repo argument and explicit old-command correction in the independent execution-ledger。

- **REG-05 [A]** GEO suite runs a seed subprocess; a read-only comment is not its actual behavior。出处：scripts/suite-geo.ts:412-423; scripts/seed-geo.ts:344-776。处理：Reserve fixture-only DB window after source/native work; preserve mode, event hashes and mutation scope。

- **REG-06 [A]** Runtime QUEUE-10 pauses all queued fixture DB threads, not only its newly created prefix。出处：runtime-repro.mts:66-73。处理：Do not run with active native/business/other fixture jobs; retain immutable effects and exclude fixtures from ADR。

- **REG-07 [A]** Node TestsStream protection applies to actual --test exec; indirect pnpm runners only capture process exit/output。出处：assets/evidence.mjs:25-39, 233-254。处理：For Node suites use the exact actual Node binary and unchanged test list; for standalone TS probes separately assert nonzero named cases and card-specific expected observations。

- **REG-08 [A]** MCD index binds one exact commit and existing run IDs are immutable; ledger is invalidated before actual process start。出处：assets/evidence.mjs:213-225; assets/mine-clear.mjs:610-622。处理：Fresh directory per clean full source SHA; same binary/actor/role/subject bind; never mix old index or conceal a failed/aborted attempt。

- **REG-09 [A/D]** Original assertion human expectations can include more conditions than their old harness healthy boolean enforces。出处：runtime-repro.mts:82,125,132; ledger MC007/008/011。处理：Before any future MCD closure, actual test wrapper must enforce the stated terminal/replay/call observations, retain raw old output, and avoid exit0-only success claims。

- **REG-10 [A/D]** MC004 desktop unit and MC106 audit argv alone cannot satisfy final exact native install/render/platform qualification。出处：package.json:29; ledger MC004/MC106; actual native acceptance remains separate。处理：Keep current source/native/default/safe/fresh/restart/genuine-old-upgrade/DMG/private identity gate independent; Windows and formal trust unverified。

历史结果写入点当前分别有 runtime 9 例、auth 11 例、影片成功 5 例，文件散列在 JSON 中保存；本次前后散列相同。[B 历史字节快照，未重跑]

旧 22 卡的 24 条 assertion 没有 exec/run，且 evidence 没有 SHA256、verification_evidence 是裸路径。新版不是读取旧绿色就通过；后续即使补 execution-ledger，也要保留原历史字段和命令补正的来源。原生流程、正式信任、Windows、真实模型/业务/UX的资格不由这份评估授予。[B 元数据；A 本地执行器合同；D 未验证资格]

MC106 最终生成器已使用整段赋值替换结论，不再在旧 summary 上累加同一段。当前旧正式报告保持历史身份，等真实最终源/native/CI证据齐全后才重新生成。[A 生成器]

## 收尾报告
- 已完成：16 卡/18 断言及 22 卡元数据、固定输出落点、旧/新执行器选择、唯一捕获、数据库种子和队列副作用、实际 auth argv 缺口、后续隔离路径逐项评估。
- 未完成/未覆盖：未实际运行任何 regression 或新版 execution-ledger；本步骤明确为只读评估，最终 source/native 验收继续等修复者冻结精确 SHA。
- 自主追加事项及理由：追到 GEO seed 和 verify-chain，实现层明确数据写入范围，避免把脚本的只读注释当事实；核对 auth 实际 argv，避免执行一个缺参命令后编造通过。
- 采用的假设：后续仅使用 owned loopback fake DB、公开 registry和无供应商调用的本地夹具；这不是生产经营结果。
- 置信度：输出路径/执行器控制为高，有完整源码依据；未来补执行记录效果为未验证。
- 建议复核：runtime 的单例固定写、auth 缺少 --repo、GEO seed 的 archive/fence/全局号源写入三处。

## 自检表
- [是] 覆盖了任务全部范围，而非挑了容易的部分？16 卡逐行矩阵、执行器和种子落点齐备，测试与生产资格未执行明确。
- [是] 没有把可自主完成的事项推给用户，没有以不必要的问句收尾？只读评估已落盘，继续等待冻结源进行已授权独立复验。
- [是] 每个结论/每段代码有依据、可验证、证据等级标注准确？A 源码、B 元数据/旧字节快照、D未来方案分开，没有执行绿色。
- [是] 经得起资深工程师逐行审查？完整源码路径/行数/散列、各卡实际输出和历史保留控制均可回读。
