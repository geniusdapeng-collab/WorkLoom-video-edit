# Growth 修复的最小复跑包

这些脚本用于复验本次权限、并发、参数修改、终态、工作区隔离和影片工位修复。它们实际调用当前仓库的实现，工具副作用使用本地计数器，影片只运行无需供应商的本地阶段。该包不替代完整 RDAS、Windows 原生验收、正式签名发行或真实业务产出验收。

## 环境准备

从仓库根目录运行。依赖与工具链采用仓库的 `package.json` 和锁文件，先按仓库已有 `pnpm setup` 流程安装；本组回归要求 Node 支持仓库脚本、`tsx` 已可用。数据库必须是单独创建的测试库，名字为 `growth_audit`，只监听本机。三条数据库变量均须指向该库：`DATABASE_URL` 是迁移账号，`DATABASE_APP_URL` 是应用角色，`DATABASE_GATEWAY_URL` 是网关角色。脚本会拒绝不同库名或非 loopback 地址。

测试 `.env` 从 `.env.example` 生成。保持全部供应商 key 为空，设置 `LLM_PROVIDER=mock`、`SCHEDULER_ENABLED=0`、`HR_PORTRAIT_ENABLED=0`、`HR_PORTRAIT_AUTO_ENABLED=0`，按当前仓库实际迁移和种子脚本执行：

```bash
pnpm db:migrate
pnpm db:seed
pnpm db:seed:video
```

需要已装 pgvector 的隔离 PostgreSQL；本包不安装数据库、不使用客户库、不导出账号或生成的登录 token。`QUEUE-10` 通过实际全库调度器执行，该测试库中的早先假任务也可能被调度，所以应使用专门的可重建测试库。真实经营 ADR/HIR 不能包含这些夹具。

## 逐组复跑

以下路径按交付目录 `outputs/mine-clear/T-2026-1002-0901/replay` 展示。脚本输出 JSON 写在脚本所在目录，运行产物由该目录的 `.gitignore` 排除；每次正式留证应把结果复制到新的证据目录并记录源码 SHA，保留此前的失败文件。

```bash
pnpm exec tsx --env-file=.env outputs/mine-clear/T-2026-1002-0901/replay/runtime-repro.mts --repo . --assert
pnpm exec tsx --env-file=.env outputs/mine-clear/T-2026-1002-0901/replay/auth-fixture.mts --repo .
node --env-file=.env --import tsx outputs/mine-clear/T-2026-1002-0901/replay/auth-production-probe.mjs --repo .
pnpm exec tsx --env-file=.env outputs/mine-clear/T-2026-1002-0901/replay/film-public-probe.mts --repo .
pnpm exec tsx --env-file=.env outputs/mine-clear/T-2026-1002-0901/replay/film-public-probe.mts --repo . --case missing-output
pnpm exec tsx --env-file=.env outputs/mine-clear/T-2026-1002-0901/replay/film-public-probe.mts --repo . --case deadline
```

运行时组有九条断言，正常时输出 `healthy:true` 并退出 0。`--case BLOCK-FLAG` 等参数可只复跑一个明确用例；未知用例报错。认证夹具先创建一个非示例、real 数据模式的假工作区，随后从 production HTTP 入口验证匿名 403/保护读取 401、缺失和错误本机凭据 401、固定预配身份的合法登录，以及五类非法 JWT。凭据随机生成并只保留在进程中，JSON 不含它们。

影片正向组通过公开 `film.start/status`、真实工作子进程和父通道验证五项合同；缺产物和 1ms 截止组的正确结果是任务 `failed`，探针因为正确拒绝而退出 0。它们没有生成供应商图片、视频或对外发布内容。原阶段阈值保持，本地 probe 设置的任务总截止只用于这些可复建夹具。

## 其余源码检查

```bash
pnpm test:desktop
pnpm --filter @workloom/web exec vitest run src/pages/p0/Floor.test.tsx src/pages/p0/floor-layout.test.ts src/components/floor3d-layout.test.ts
pnpm --filter @workloom/web typecheck
pnpm --filter @workloom/web build
pnpm suite:geo
pnpm release:gate
```

`release:gate` 需要按仓库约定起正确的隔离服务；不要把服务未启动造成的连接拒绝标为认证通过。场景单测使用受控 React/测量环境，原生浏览器文字边界、实际鼠标、最终客户端冷启动、重启、升级和 DMG 指纹另见交付报告及独立 M6；单测不等同原生客户端已交付。

## 本次实测收据

该最小包已在修复源码上实际执行，27 条控制均通过：运行时 9、production HTTP 11、影片正向 5、两个预期失败关闭控制各 1。每组的实际 JSON、源码绑定和执行时间在交付 `evidence` 中。复制和修改范围只有 repo 参数校验、相对输入/输出路径以及关闭所有定妆照自动入口；运行时和影片探针直接沿用独立验收的实现。它们属于 B 级复跑证据，不作为新增独立业务样本。
