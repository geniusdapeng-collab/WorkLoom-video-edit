# 用 Codex、DeepSeek Harness 或其他 Agent 操作 WorkLoom Video Edit

本文从干净克隆开始，配置本机服务和 Agent。正式前期、渲染、恢复及交付步骤见 [AI 工作台视频调用指南](ai-video-workbench-guide.md)。本仓沿用 `growth.*` 能力 ID，运行身份以本地 manifest 返回的 `workloom-ai/WorkLoom-video-edit` 和 `workloom-ai-video-edit` 为准。

---

## 1. 克隆、安装与连接本机服务

使用具备此仓读取权限的 Git 身份，从 GitHub `main` 开始。记录本次运行的 SHA。需要更新时先完成或隔离正在运行的作业，再在干净工作树 `git pull --ff-only`。

```bash
git clone --branch main https://github.com/geniusdapeng-collab/WorkLoom-video-edit.git
cd WorkLoom-video-edit
git status --short
git rev-parse HEAD
node --version
node -p 'JSON.stringify({engines: require("./package.json").engines, packageManager: require("./package.json").packageManager})'
pnpm --version
```

准备仓库声明的 Node.js 与 pnpm 版本。媒体工位需要可用的 FFmpeg 和 FFprobe，按交付合同另检查字体、音频及可授权曲库。完整依赖安装使用和 GitHub CI 相同的 [UI 制品引导](../scripts/ci/install-private-ui.mjs)。当前 GitHub 锁定制品从公开 Release 匿名读取并校验，不需要访问令牌。把原始归档、安装回执和缓存放在仓外私有目录。

```bash
ui_bootstrap="$(mktemp -d "${TMPDIR:-/tmp}/workloom-edit-ui.XXXXXX")"
node scripts/ci/install-private-ui.mjs --repo . \
  --store-dir "$ui_bootstrap/store" --staging-root "$ui_bootstrap" \
  --archive "$ui_bootstrap/original.tgz" --report "$ui_bootstrap/install.json"
pnpm -C packages/industry-contract build
```

`--archive` 是本次下载的**输出路径**。安装成功检查 `frozenInstallPassed` 和 `originalLockUnchanged`。制品权限、摘要或锁文件验证失败时，修复实际凭据或工具链后再执行，保留仓库锁文件。

读取指南、枚举工具和检查已有文件可以独立于服务运行。正式新生成需要隔离 PostgreSQL（含 `vector` 扩展）、本次专用归档和媒体目录，以及已授权的模型及供应商配置。为这次作业单独建库与集群，避免迁移中对 `workloom_app` 和 `workloom_gateway` 角色密码的调整影响其他实例。由受控环境注入 `DATABASE_URL`、`DATABASE_APP_URL`、`DATABASE_GATEWAY_URL`、对应 `APP_DB_PASSWORD` 和 `GATEWAY_DB_PASSWORD` 以及服务签名密钥。把同一组数据库连接用于迁移、种子和服务。新建测试工作区时可以加载本仓种子，已有正式工作区使用其既有成员和数据。

```bash
: "${DATABASE_URL:?注入本次数据库的迁移连接}"
: "${DATABASE_APP_URL:?注入本次数据库的应用连接}"
: "${DATABASE_GATEWAY_URL:?注入本次数据库的事件网关连接}"
: "${APP_DB_PASSWORD:?注入本次应用角色密码}"
: "${GATEWAY_DB_PASSWORD:?注入本次事件网关角色密码}"
: "${JWT_SECRET:?注入本次隔离服务的签名密钥}"
node --import tsx scripts/migrate.ts
# 仅对本次新建、专用的测试数据库加载测试工作区。
node --import tsx scripts/seed.ts
node --import tsx scripts/seed-geo.ts

: "${EDIT_RUN_ROOT:?指定本次作业专用的仓外绝对目录}"
umask 077
export HR_WORK_DIR="$EDIT_RUN_ROOT/studio"
export WORKLOOM_MEDIA_DIR="$EDIT_RUN_ROOT/media"
mkdir -p "$HR_WORK_DIR" "$WORKLOOM_MEDIA_DIR"
ARCHIVE_ENABLED=1 ARCHIVE_AUTO_RESUME=0 SERVER_HOST=127.0.0.1 SERVER_PORT=48787 \
  node --import tsx apps/server/src/index.ts
```

上面是隔离源码服务的启动方式。做真实模型作业时，在**启动前**另外为服务进程配置 `LLM_PROVIDER=deepseek`、`LLM_MODEL=deepseek-flash` 和经授权的 OpenAI 兼容 `LLM_BASE_URL`；密钥用 `DEEPSEEK_API_KEY` 或 `LLM_API_KEY`。媒体走批准的 `SEEDANCE_ENDPOINT`、`SEEDREAM_ENDPOINT` 与 `VOLCENGINE_ARK_API_KEY`；独立 CLI 还读取其 `--keys-file` 中的 `ARK_BASE_URL`、模型和密钥。传给服务的配置与传给独立 CLI 的配置都需逐项核对。按本轮合同和仓内规则启用 `PROMPT_CONTRACT_V2=enforce`。启动前期前核对前期预算；付费提交视频前再核对本轮 G7 当前性和付费授权。模型密钥只进服务或 Film 进程，无需传给 MCP。用 `NODE_ENV=production` 时按 `.env.example` 配置生产签名及脱敏变量，使用实际会员认证；公开演示登录在该档位关闭。

上述命令在单独终端前台运行服务。端口使用未占用值，后面的 URL 与之保持一致。需要图形界面时，在另一终端从仓库根运行 `SERVER_PORT=48787 pnpm -C apps/web dev --host 127.0.0.1`，打开启动日志给出的本机地址并按实际账号登录。真实供应商仅在已经批准的作业执行中调用。本机健康响应、测试工作区和 `LLM_PROVIDER=mock` 都不能证明真实生成可用。正式试跑使用授权的实际模型配置、实际余额与工作区预算，保持服务仅监听回环地址。

在 Agent 的终端打开同一工作树。由授权方式向当前进程注入本工作区 B 端成员令牌 `WORKLOOM_ACCESS_TOKEN`，再检查只读健康接口和模型目录。无服务时可以单独运行不带 `--api` 的预检。

```bash
export EDIT_API=http://127.0.0.1:48787
: "${WORKLOOM_ACCESS_TOKEN:?注入当前工作区 B 端成员令牌}"
export WORKLOOM_BASE_URL="$EDIT_API" WORKLOOM_DEV_AUTO_LOGIN=0
node scripts/tools/codex-video-preflight.mjs --api "$EDIT_API"
printf '%s' '{"kind":"video","includeUnavailable":true}' | \
  node scripts/workloom-agent.mjs invoke growth.video.gen.catalog --input-file -
```

预检打印仓库身份、HEAD、依赖和媒体工位结果。提供 `--api` 时额外检查回环健康与已认证的模型目录，并给出模型数量；服务的源码身份与部署版本仍由启动回执确认。显式目录查询返回各模型，核对本次所选条目的 `available`、缺少的配置、可用画幅、分辨率与时长。预检读取本地已获取的 `origin/main`，要核对远端当前状态先以获准 Git 身份执行 `git fetch origin main`。账户余额、预算与执行授权按 [正式流程](ai-video-workbench-guide.md#3-按系统官方流程推进) 独立核对。

### 验证 Agent 读取能力

```bash
# ① 看能力清单（每项含 ID / 操作类别 / 风险 / 数据模式）
node scripts/workloom-agent.mjs list

# ② 先读取本仓视频指南全文与 SHA-256（无网络、无模型、无渲染）
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide

# ③ 看单项契约（输入 JSON Schema、传输方式）
node scripts/workloom-agent.mjs describe growth.video.production.status

# ④ 读取本仓环境状态（没有实际项目时无需填样例项目 ID）
node scripts/workloom-agent.mjs invoke growth.repo.readiness

# ⑤ MCP 冒烟（stdio JSON-RPC，两个请求：initialize + tools/list）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node scripts/workloom-agent-mcp.mjs
```

成功标志：`list` 打印本仓清单且含 `growth.video.workbench.guide`；指南 invoke 返回全文、仓库身份、路径和 SHA-256；通用 envelope 为
`{"schemaVersion":"workloom.capability-result/v1","status":"succeeded",...}`。MCP `tools/list` 含 `workloom_growth_video_workbench_guide`，
再以 `{}` 调用该工具读取正文。工具数量以实际清单为准，禁用项不出现在列表里。

> 产物根：默认 = 仓库根。若你的工作目录在仓外（客户常见），用**运行者**环境变量指定：
> `WORKLOOM_VIDEO_ARTIFACT_ROOT=/abs/path/to/work`（调用方仍只能给相对路径，边界由环境变量而非请求决定）。

---

## 2. 能力边界：只读/预览 vs 执行（先看这张表再用）

| 类别 | 会不会动数据/花钱 | 出现在 MCP 菜单 | 例子 |
|---|---|---|---|
| 只读（`read`） | 否 | ✅ `readOnlyHint=true` | `core.threads.get`、`growth.video.production.status` |
| 回执（`receipt`） | 否 | ✅ | `core.threads.events`、`growth.video.delivery.inspect` |
| 预览（`preview`） | 否（本地校验/出计划） | ✅ | `growth.service.inquiry.preview`、`growth.video.production.plan` |
| 执行（`execute`） | **是**（服务端过程 + 幂等键 + 围栏/审批） | 仅在启用且过审后出现 | `growth.service.inquiry.execute`（本仓当前**禁用**） |

**视频 MCP 用于读取和预览。** Codex 在 Edit 源码仓按仓库技能先运行 `node --import tsx scripts/tools/codex-video-workflow.mjs --intent "$EDIT_RAW_INTENT"`。确认本轮授权后通过同一入口显式启动 Studio，以私有回执持续查询。正式渲染和后期使用 `full-chain-film.mts`。连接 MCP 既不启动前期，也不授予付费或对外发布权限。按 [正式流程](ai-video-workbench-guide.md#3-按系统官方流程推进) 核对项目状态、原始片单和门禁。

---

## 3. Codex 接入

Codex 支持本地 STDIO MCP。下面配置可放在用户 `~/.codex/config.toml`，或可信项目的 `.codex/config.toml`。将 Node 和 Edit 工作树换成机器实际绝对路径。同源仓各用独立名称和工作目录。 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)

```toml
[mcp_servers.workloom-video-edit]
command = "/abs/path/to/node"
args = ["/abs/path/to/WorkLoom-video-edit/scripts/workloom-agent-mcp.mjs"]
cwd = "/abs/path/to/WorkLoom-video-edit"
startup_timeout_sec = 60
# 仅访问 B 端只读服务时，从启动 Codex 的受控环境转发。
env_vars = ["WORKLOOM_ACCESS_TOKEN"]

[mcp_servers.workloom-video-edit.env]
WORKLOOM_PRODUCT_ROOT = "/abs/path/to/WorkLoom-video-edit"
# 只读本地指南或产物时可省略下面两项。
WORKLOOM_BASE_URL = "http://127.0.0.1:48787"
WORKLOOM_DEV_AUTO_LOGIN = "0"
```

重启或重载客户端，用 `codex mcp list` 或客户端工具列表核对服务器。先调用 `workloom_growth_video_workbench_guide`，参数 `{}`。收到正确产品身份和正文摘要后，再运行实际任务。令牌只通过受控进程环境传入，MCP 进程无需接收 Ark 或文本模型密钥。 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)

---

## 4. DeepSeek Harness（DSH）接入

### 4.0 先分清：本仓有**两个**"DeepSeek Harness"，别混

| | **内置 DSH 组件**（本仓自带，产品自己在用） | **DSH 桌面端**（DeepSeek 官方客户端，人用） |
|---|---|---|
| 是什么 | 运行时 Agent 底座：`vendor/dsh`（审计基线）+ `packages/runtime` 的 **dsh seam**（意图路由 / Ask·Agent·Quest 循环 / 装配 / 工具 / 剧本）+ 围栏插件 + 事件桥 | DeepSeek Harness 官方客户端；安装版本以官方发布说明为准 |
| 谁在用 | **产品自己**：服务端派活、通用任务循环、夜班 | **人**：资深用户 / 内部同事的工作台 |
| 版本 | 查本仓 `packages/runtime/dsh-gate/package.json` 与 `vendor/dsh` 的当前锁定资料 | 以 [官方 Releases](https://github.com/deepseek-ai/deepseek-harness/releases) 与实际安装版本为准；仓内 pin 不代表桌面版本 |
| 怎么验收 | `bash scripts/dsh-gate.sh`：headless → 工具调用过围栏瀑布 → 事件落哈希链 → `kill -9` 重放零重复 | 客户端侧：`tools/list` 能看到本仓工具（见 §4.2） |
| 怎么"接本仓能力" | **不需要 MCP**：它就在进程内，走服务端过程 + 围栏 + 事件账本（与 `scripts/AGENT-CAPABILITIES.md` 同一批过程） | 需要接入：§4.1 用 `bash` 跑 CLI；§4.2 用 MCP 插件挂 `workloom-agent-mcp.mjs` |

> 一句话：**内置组件 = 我们的执行底座；桌面端 = 给人用的工作台。**
> 本节 4.1 / 4.2 讲桌面端怎么接进来；内置组件不需要"接入"，只需按 `dsh-gate` 验版本与门禁。

### 4.1 桌面端接入 · 路线 A（用它的终端工具直接跑本仓 CLI，最省事）

DSH 客户端与本仓内置运行时分别配置。可用终端调用或 MCP 工具注册两条路线：

1. 在 DSH 里把本仓目录设为工作区；
2. 先 invoke `growth.video.workbench.guide` 读取本仓完整指南，再读 `bundles/ai-video/README.md`；
3. 用终端执行与 Codex 相同的 [正式流程](ai-video-workbench-guide.md#3-按系统官方流程推进)。

### 4.2 桌面端接入 · 路线 B（把本仓 MCP 挂成 DSH 插件，能力进菜单）

每个服务器配置一项。使用当前 profile 所支持的 `@deepseek-ai/dsh-mcp-client` 插件。 [DSH 官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)

```yaml
- id: workloom-video-edit-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workloom_video_edit
    transport: stdio
    command: node
    args: ['/abs/path/to/WorkLoom-video-edit/scripts/workloom-agent-mcp.mjs']
    cwd: /abs/path/to/WorkLoom-video-edit
    env:
      WORKLOOM_PRODUCT_ROOT: /abs/path/to/WorkLoom-video-edit
```

DSH 会清理继承环境中的秘密变量；需要访问服务时，按该客户端当前配置机制显式注入成员令牌和服务地址，不能把令牌字面量保存到仓库。接通检查：

1. 核对上面条目的 Node 可执行路径和本仓绝对入口，等价服务命令为：

   ```bash
   node /abs/path/to/WorkLoom-video-edit/scripts/workloom-agent-mcp.mjs
   ```

   并把 `WORKLOOM_PRODUCT_ROOT=/abs/path/to/WorkLoom-video-edit` 等环境变量注入插件进程。
2. 重新加载插件后，以实际 `tools/list` 核对原始工具。按本例注册时 DSH 显示名会加 `mcp__workloom_video_edit__` 前缀。调用原始工具 `workloom_growth_video_workbench_guide`，参数 `{}`，回读产品身份和文档摘要。

> 说明：DSH 侧"自定义 STDIO MCP"的具体配置键以**你所用 DSH 版本的官方文档/插件页为准**；
> 我们这侧只保证"标准 stdio JSON-RPC + 工具清单"这一契约（协议版本含 2024-11-05 / 2025-03-26 /
> 2025-06-18 / 2025-11-25，见 `scripts/workloom-agent-mcp.mjs`）。

其他 Agent 也可用 §1 的终端调用。若客户端支持本机 STDIO MCP，复用同一个绝对 Node 路径、入口、工作目录和非秘密环境配置，再通过该客户端的受控变量转发所需成员令牌。仅云端执行的 Agent 需要单独配置可访问的执行环境。

---

## 5. 能力速查（DSH/Codex 通用，以本仓清单为准）

### 5.0 视频链路

| 能力 | 何时用 | 备注 |
|---|---|---|
| `growth.video.workbench.guide` | 任何视频制作、返修或交付前第一步 | 固定指南全文、仓库身份、版本、路径、SHA-256；无模型调用 |
| `growth.video.route.record` | 出片前：确认本项目的分流结论 | 读 `work/route.json`；没有就让 Agent 先跑分流 |
| `growth.video.production.plan` | 出片前：拿"建议命令 + 检查清单" | **预览**：不执行、不花钱 |
| `growth.video.gen.catalog` | 选模型/看限额 | 服务端只读 |
| `growth.video.production.shots` | 看项目镜头与生产资格 | 服务端只读 |
| `growth.video.production.status` | 跑片过程中/跑完后：看卡在哪一步 | 读 `logs/<project>/stages.jsonl`，含渲染台账 |
| `growth.video.delivery.inspect` | 交付前：核验清单所列文件 | 缺件/越界会如实列出 |

典型对话（DSH 里）：

> "先 `workbench.guide` 读本仓指南，冻结指定人、商品、平台、时长、账号调性和声音；走系统正式前期，再 `production.plan` 核对预览参数；按官方流程执行后，用 `production.status` 读账本、`delivery.inspect` 核验交付。指南说能力不支持就保留阻塞，不替声或改剧情凑结果。"

---

### 5.1 仓库通用只读（4 条，与行业仓同一份模板）

| 能力 | 何时用 | 备注 |
|---|---|---|
| `growth.repo.status` | 接手本仓第一件事：看清产品标识/默认行业包/文档与脚本规模 | 读 `product.manifest.json` + 目录计数 |
| `growth.repo.docs` | 找 runbook／规范：列出 `docs/*.md` 与一级标题 | 可传 `limit`（1–60），默认 60 |
| `growth.bundle.summary` | 看行业包家底：skills / fences / pipelines / presets / library 计数 + 围栏规则样例 | 围栏样例最多 12 条 |
| `growth.repo.readiness` | 上手前自检：Node / 依赖 / 运行时资产 / 密钥是否存在 / MCP 入口 / 内置 DSH pin | **预览**：只读本地文件，不联网 |

---

## 6. 安全与排错

- **令牌三类**：`WORKLOOM_ACCESS_TOKEN`（B 端成员，远程地址必需）、`WORKLOOM_C_TOKEN`（C 端，单独）、
  本地开发可用 `auth.loginAs` 演示身份；**令牌只经环境变量**，不得写进仓库、命令行参数、日志或提示词；
- **地址**：将 `WORKLOOM_BASE_URL` 设为实际 `SERVER_HOST` 和 `SERVER_PORT`。默认能力地址按 manifest 的桌面端口偏移推导，源码服务不会自动采用这一偏移。非回环必须 HTTPS；
- **禁用能力**：`enabled=false` 的能力会从 MCP `tools/list` 消失，调用返回 `DISABLED` + 原因；
- **错误码**：清单/契约类错误返回 `{"error":{"code":...}}`；指南契约错误保留 `INVALID_INPUT` / `GUIDE_UNAVAILABLE`；其它本地能力自身抛错可能显示为 `INTERNAL_ERROR` + 可读原因
  （例如"路径监狱""超过读取上限"）；
- **路径监狱**：视频只读能力默认只允许**本仓相对路径**；仓外产物根需运行者显式设
  `WORKLOOM_VIDEO_ARTIFACT_ROOT`；绝对路径与 `../` 逃逸一律拒绝；
- **不上行**：这些能力只读本地文件或调服务端只读过程，不把客户数据发给模型供应商。

---

## 7. 本仓本次落地的内容（便于对账）

- 入口：`scripts/AGENT-CAPABILITIES.md`（基座受控资产，随 base-sync 下发）+ `scripts/workloom-agent.mjs`
  + `scripts/workloom-agent-mcp.mjs` + `scripts/agent-capabilities.{mjs,core.json,test.mjs}`；
- 仓库通用只读模块：`bundles/geo-growth/capabilities/repo.mjs`（4 条：`repo.status` / `repo.docs` / `bundle.summary` / `repo.readiness`，只读/预览；路径监狱 + 8MB/2 万行上限，不回显密钥值）；
- 视频能力模块：`bundles/geo-growth/capabilities/video.mjs`（只读/预览；另有固定指南模块 `workbench-guide.mjs`，见 §5）；
- 自检：`node --test scripts/agent-capabilities.test.mjs`（清单驱动的断言，基座与行业仓共用同一份）。
- 内置 DSH 组件版本与历史同步/验收记录另查本仓锁定文件；本次只修改指南和发现/载荷接线，没有升级该组件或重跑其真机验收。
