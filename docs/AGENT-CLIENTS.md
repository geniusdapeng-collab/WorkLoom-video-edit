# 用 Codex、Qoder 或其他 AI 办公 Agent 操作 WorkLoom Video Edit

本文从干净克隆开始，配置本机服务和 Agent。Codex、Qoder 和其他支持本机终端或 stdio MCP 的客户端使用同一条 Edit 原生流程。正式前期、渲染、恢复及交付步骤见 [AI 工作台视频调用指南](ai-video-workbench-guide.md)。本仓沿用 `growth.*` 能力 ID，运行身份以本地 manifest 返回的 `workloom-ai/WorkLoom-video-edit` 和 `workloom-ai-video-edit` 为准。

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

上面是隔离源码服务的启动方式。做真实模型作业时，在**启动前**另外为服务进程配置 `LLM_PROVIDER=deepseek`、`LLM_MODEL=deepseek-flash` 和经授权的 OpenAI 兼容 `LLM_BASE_URL`；密钥用 `DEEPSEEK_API_KEY` 或 `LLM_API_KEY`。媒体走批准的 `SEEDANCE_ENDPOINT`、`SEEDREAM_ENDPOINT` 与 `VOLCENGINE_ARK_API_KEY`；独立 CLI 还读取其 `--keys-file` 中的 `ARK_BASE_URL`、模型和密钥。传给服务的配置与传给独立 CLI 的配置都需逐项核对。按本轮合同和仓内规则启用 `PROMPT_CONTRACT_V2=enforce`。启动前期前核对前期预算；付费提交视频前再核对本轮 G7 当前性和付费授权。模型密钥由既有服务或受控 Film 运行环境提供；接入配置不保存或转发上游模型密钥值。媒体接续的既有预算与网关配置见下文，配置生成成功不等于预算已具备。用 `NODE_ENV=production` 时按 `.env.example` 配置生产签名及脱敏变量，使用实际会员认证；公开演示登录在该档位关闭。

上述命令在单独终端前台运行服务。端口使用未占用值，后面的 URL 与之保持一致。需要图形界面时，在另一终端从仓库根运行 `SERVER_PORT=48787 pnpm -C apps/web dev --host 127.0.0.1`，打开启动日志给出的本机地址并按实际账号登录。真实供应商仅在已经批准的作业执行中调用。本机健康响应、测试工作区和 `LLM_PROVIDER=mock` 都不能证明真实生成可用。正式试跑使用授权的实际模型配置、实际余额与工作区预算，保持服务仅监听回环地址。

在 Agent 的终端打开同一工作树。由授权方式向实际客户端进程注入本工作区 B 端成员令牌 `WORKLOOM_ACCESS_TOKEN`；受控桌面实例也可以注入其 `WORKLOOM_DESKTOP_LOGIN_KEY`。后者只用于同一已核验产品连接上的正式 `auth.desktopLogin`，返回的成员会话留在进程内存。无有效成员会话时先按实际产品登录流程取得或更新会话，不能以演示身份替代。再检查只读健康接口和模型目录。无服务时可以单独运行不带 `--api` 的预检。

```bash
export EDIT_API=http://127.0.0.1:48787
: "${WORKLOOM_ACCESS_TOKEN:?注入当前工作区 B 端成员令牌}"
export WORKLOOM_BASE_URL="$EDIT_API" WORKLOOM_DEV_AUTO_LOGIN=0
node scripts/tools/codex-video-preflight.mjs --api "$EDIT_API"
printf '%s' '{"kind":"video","includeUnavailable":true}' | \
  node scripts/workloom-agent.mjs invoke growth.video.gen.catalog --input-file -
```

预检打印仓库身份、HEAD、依赖和媒体工位结果。提供 `--api` 时额外检查回环健康与已认证的模型目录，并给出模型数量；服务的源码身份与部署版本仍由启动回执确认。显式目录查询返回各模型，核对本次所选条目的 `available`、缺少的配置、可用画幅、分辨率与时长。预检读取本地已获取的 `origin/main`，要核对远端当前状态先以获准 Git 身份执行 `git fetch origin main`。账户余额、预算与执行授权按 [正式流程](ai-video-workbench-guide.md#3-按系统官方流程推进) 独立核对。

### 生成客户端配置：默认预览，显式安装

新入口是普通 Node 启动的 `scripts/edit-agent.mjs` 和 `scripts/edit-agent-mcp.mjs`。客户端启动 MCP 不需要加 `--import tsx`；执行原生工作流时，桥接器按实际需要启动仓内已安装的 tsx。旧 `workloom-agent*` 入口继续提供其原有读取能力，新视频作业优先使用 Edit 入口。

先创建仓外、当前用户拥有且权限为 `0700` 的作业根。目录要使用真实绝对路径，不能与源码或 Studio 归档互相包含。`WORKLOOM_EDIT_STUDIO_ROOT` 为完整流程必填，必须指向该服务实际的 `HR_WORK_DIR`，不能指向另一个实例的归档。多个 job 共用同一服务时都绑定这个实际 Studio 根；缺项不生成看似可接续的配置。作业根与 Studio 根均须恰好为 `0700`，只读的 `0500` 目录也会拒绝。

```bash
: "${EDIT_RUN_ROOT:?指定本次仓外私有目录}"
umask 077
mkdir -p "$EDIT_RUN_ROOT/agent-jobs" "$EDIT_RUN_ROOT/studio"
chmod 700 "$EDIT_RUN_ROOT/agent-jobs" "$EDIT_RUN_ROOT/studio"
# 将以下值换为本机实际绝对路径；API 必须与本次服务一致。
node scripts/tools/edit-agent-setup.mjs --client codex \
  --repo /abs/path/to/WorkLoom-video-edit --node /abs/path/to/node \
  --api http://127.0.0.1:48787 --jobs-root "$EDIT_RUN_ROOT/agent-jobs" \
  --studio-root "$EDIT_RUN_ROOT/studio"
```

该命令只向标准输出生成配置，不连接服务，不调用模型，也不修改客户端文件。支持 `--client codex`、`qoder` 和通用 `stdio` 配方。Node 必须满足本仓声明的运行时版本，路径中的中文、空格和引号按配置格式编码。三个非秘密服务/目录参数均须具备；省略命令行参数时只读取对应进程环境：`WORKLOOM_BASE_URL`、`WORKLOOM_EDIT_JOBS_ROOT`、`WORKLOOM_EDIT_STUDIO_ROOT`。缺项直接报出错误码，不扫描 `.env` 或其他作业目录补值。

安装需额外给出 `--install --config /abs/path/to/config`；父目录必须已存在且归当前用户。安装只增加指定名称的 MCP 服务器，默认名称 `workloom-video-edit`，可用 `--server-name` 为不同实例分开命名。现有模型 provider、其他 MCP 服务器和全局权限设置保留。已安装的相同配置再次运行不改文件；同名服务器的设置不同就拒绝。修改现有文件前保存原字节的 `0600` 备份，结果返回 `backupPath`。符号链接、硬链接、不安全路径、并发安装锁或不支持的 TOML 布局均拒绝；遇到 `EDIT_SETUP_TOML_MANUAL_MERGE_REQUIRED` 时，人工审阅默认生成的片段后按客户端正规编辑器合并。不会改全局 approval、sandbox、trust 或 alwaysAllow。

```bash
# 看过上面的生成结果后，在同一命令后增加以下参数才写入：
# --install --config /abs/path/to/trusted-project/.codex/config.toml
# Qoder CLI 本机项目配置示例：
# --client qoder ... --install --config /abs/path/to/project/.qoder/settings.local.json
```

配置只包含非秘密地址和目录。Codex 使用 `env_vars` 按名称转发 `WORKLOOM_ACCESS_TOKEN` 或 `WORKLOOM_DESKTOP_LOGIN_KEY`，并保留媒体用量接续所需的名称 `WORKLOOM_BUDGET_GATEWAY_TOKEN`、`WORKLOOM_BUDGET_TASK_ID`、`LLM_BASE_URL` 和 `ARK_BASE_URL`。可选名称 `WORKLOOM_BUDGET_APPROVED_MICRO_CNY` 只在调用方另有显式消费合同时提供；系统默认不设金额上限。这些变量的实际值必须由受控启动环境提供。工具不接受 token/key 参数，也不把上游 key 填进配置。

Qoder 官方 JSON 文档列出 `env`，没有约定 Codex 的 `env_vars` 或 `${VAR}` 插值。生成器因此只写非秘密 `env`，不会生成未经文档支持的秘密占位符。把所需变量提供给实际启动 Qoder/MCP 的受控进程，再调用 `edit.agent.doctor` 检查实际认证。已运行的图形客户端可能需要从正确环境重新启动；配置文件里出现变量名称不能证明客户端已收到变量。连接成功、成员认证成功和生产授权分别核验。

### 验证 Agent 读取能力

```bash
# ① 看能力清单（每项含 ID / 操作类别 / 风险 / 数据模式）
node scripts/edit-agent.mjs list

# ② 先读取本仓视频指南全文与 SHA-256（无网络、无模型、无渲染）
node scripts/edit-agent.mjs invoke growth.video.workbench.guide

# ③ 看单项契约（输入 JSON Schema、传输方式）
node scripts/edit-agent.mjs describe edit.video.workflow.start

# ④ 读取本仓环境状态（没有实际项目时无需填样例项目 ID）
node scripts/edit-agent.mjs invoke edit.agent.doctor

# ⑤ MCP 冒烟（stdio JSON-RPC，两个请求：initialize + tools/list）
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}\n{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n' \
  | node scripts/edit-agent-mcp.mjs
```

成功标志：`list` 打印本仓清单且含 `growth.video.workbench.guide`、六个 `edit.video.workflow.*` 工具和 `edit.agent.doctor`；指南 invoke 返回全文、仓库身份、路径和 SHA-256；旧读取能力的 envelope 为
`{"schemaVersion":"workloom.capability-result/v1","status":"succeeded",...}`；原生工作流使用 `workloom.edit-agent-workflow/v1`，以其实际 `state` 和 `delivered` 判断进展。MCP `tools/list` 含 `workloom_growth_video_workbench_guide`，
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

**Edit MCP 同时提供原有只读能力和本仓原生视频执行工具。** 通用 `growth.*` 的历史 execute 项保持原有禁用状态；新入口只开放下面列出的固定视频操作，调用原有 Studio、修复和 Film 入口。

| 原生能力 | 输入要点 | 结果与授权 |
|---|---|---|
| `edit.agent.doctor` | `{}` | 分别检查本地运行时、目录、产品连接和成员认证；不授予生产资格 |
| `edit.video.workflow.plan` | `intent` 完整原话，可带完整 `brief` | 只读计划；不启动，不调用模型，不添加镜数或逐镜时长 |
| `edit.video.workflow.start` | 同一 `intent` / `brief`、稳定 `idempotencyKey`、`authorization.textGeneration:true` | 仅在已有本次文字前期授权时提交一次，保留返回的 `jobId` |
| `edit.video.workflow.status` | `jobId` | 回读同一原生回执、审批、归档和后期状态；未知状态不能换键重提 |
| `edit.video.workflow.continue` | 同一 `jobId`、`authorization.mediaGeneration:true` | 仅在当前 G7、正式来源和媒体预算授权齐备时进入原有 Film、后期与质检 |
| `edit.video.workflow.repair_plan` | `projectId` | 只读检查当前失败能否承接已审资料；不开始修复 |
| `edit.video.workflow.repair` | 原计划的 `projectId`、`expectedLatestAttempt`、`planDigest`、稳定 `idempotencyKey`、文字授权 | 按正式修复入口认领一次并回读同一 `jobId` |

CLI 用 `describe <id>` 读取实际 JSON Schema，以 `invoke <id> --input-file FILE` 或 `--input-file -` 提交 JSON。MCP 对应名称把能力 ID 中的点改为下划线并加 `workloom_`，例如 `workloom_edit_video_workflow_plan`。API、目录和秘密由操作者环境决定，不在工具请求里传路径或地址。完整对话顺序和示例见 [工作台正式流程 §3.0](ai-video-workbench-guide.md#30-ai-办公-agent-使用同一条原生流程)。

连接 MCP 不启动前期，也不授予付费或对外发布权限。`authorization` 的 true 值是对已经取得的任务授权的声明；客户端不能替用户凭空批准。`pending`、`start_unknown`、`preproduction_archived` 和前期 `finished` 都没有完成成片交付。只有回读当前媒体质检且 `delivered:true` 才能报告完成。原生媒体预算当前仍有统一逐镜时长与既有任务上限约束；不兼容时返回实际阻塞，工作台不得修改镜头计划来适配预算。

---

## 3. Codex 接入

Codex 支持本地 STDIO MCP。下面配置可放在用户 `~/.codex/config.toml`，或可信项目的 `.codex/config.toml`。将 Node 和 Edit 工作树换成机器实际绝对路径。同源仓各用独立名称和工作目录。 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)

```toml
[mcp_servers.workloom-video-edit]
command = "/abs/path/to/node"
args = ["/abs/path/to/WorkLoom-video-edit/scripts/edit-agent-mcp.mjs"]
cwd = "/abs/path/to/WorkLoom-video-edit"
startup_timeout_sec = 60
# 值只存在于启动 Codex 的受控环境，配置只列名称。
env_vars = ["WORKLOOM_ACCESS_TOKEN", "WORKLOOM_DESKTOP_LOGIN_KEY", "WORKLOOM_BUDGET_GATEWAY_TOKEN", "WORKLOOM_BUDGET_TASK_ID", "WORKLOOM_BUDGET_APPROVED_MICRO_CNY", "LLM_BASE_URL", "ARK_BASE_URL"]

[mcp_servers.workloom-video-edit.env]
WORKLOOM_PRODUCT_ROOT = "/abs/path/to/WorkLoom-video-edit"
# 服务与目录必须对应同一 Edit 实例。
WORKLOOM_BASE_URL = "http://127.0.0.1:48787"
WORKLOOM_DEV_AUTO_LOGIN = "0"
WORKLOOM_EDIT_JOBS_ROOT = "/abs/path/to/private/agent-jobs"
WORKLOOM_EDIT_STUDIO_ROOT = "/abs/path/to/private/studio"
```

重启或重载客户端，用 `codex mcp list` 或客户端工具列表核对服务器。先调用 `workloom_growth_video_workbench_guide`，参数 `{}`。收到正确产品身份和正文摘要后，调用 `workloom_edit_agent_doctor`，再按原话出计划。令牌只通过受控进程环境传入；接入配置不写 Ark 或文本模型密钥。 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)

### 3.1 Qoder CLI 与 Qoder IDE

Qoder CLI 使用 `mcpServers` JSON。默认本机项目文件为 `.qoder/settings.local.json`，用户级为 `~/.qoder/settings.json`，项目共享文件为 `.mcp.json`。同一服务可用 `qoder mcp list` 核对；已有会话运行 `/mcp reload` 或开启新会话重新发现。生成器的 `--client qoder` 输出可安全合并到上述显式文件，保留其他设置。项目配置仍遵循 Qoder 自身的信任与工具授权。 [Qoder 官方 MCP Servers](https://docs.qoder.com/cli/mcp-servers)、[MCP reference](https://docs.qoder.com/cli/mcp-reference)

```json
{
  "mcpServers": {
    "workloom-video-edit": {
      "type": "stdio",
      "command": "/abs/path/to/node",
      "args": ["/abs/path/to/WorkLoom-video-edit/scripts/edit-agent-mcp.mjs"],
      "cwd": "/abs/path/to/WorkLoom-video-edit",
      "env": {
        "WORKLOOM_PRODUCT_ROOT": "/abs/path/to/WorkLoom-video-edit",
        "WORKLOOM_BASE_URL": "http://127.0.0.1:48787",
        "WORKLOOM_DEV_AUTO_LOGIN": "0",
        "WORKLOOM_EDIT_JOBS_ROOT": "/abs/path/to/private/agent-jobs",
        "WORKLOOM_EDIT_STUDIO_ROOT": "/abs/path/to/private/studio"
      }
    }
  }
}
```

Qoder IDE 的官方入口是 **Qoder IDE Settings → MCP → My Servers → + Add**，在其打开的 JSON 编辑器添加上面的 `mcpServers` 项，保存后核对连接图标和工具列表。官方页面没有给出所有 IDE 版本通用的磁盘文件路径；不要把 CLI 文件路径当作已核实的 IDE 配置路径。若使用安装器，`--config` 必须是 IDE 实际打开的文件路径。 [Qoder IDE 官方 MCP 配置](https://docs.qoder.com/user-guide/chat/model-context-protocol)

Qoder IDE 官方支持自动识别项目根 `AGENTS.md`；本仓根规则继续引导读取 `AGENTS.repo.md`、标准视频 skill 和本指南，无需另建一份 `.qoder` 技能副本。已有 `.qoder/rules` 与 `AGENTS.md` 冲突时，官方规则页规定 rules 优先，应检查实际加载内容，不自动覆盖用户规则。Qoder CLI 默认项目指令文件也是 `AGENTS.md`，发现受目录信任和 `.git` 等边界限制；用 `/memory` 核对已加载的来源。 [Qoder IDE 官方 Rules](https://docs.qoder.com/user-guide/rules.md)、[Qoder CLI 指令加载排错](https://docs.qoder.com/cli/troubleshoot-loading.md)

在 Qoder Agent 模式中先调用指南和 doctor，然后按 §2 的工具链执行。MCP 工具确认属于客户端权限；任务中的文字、媒体和对外发布授权仍分别核验。通用本机 Agent 使用 `--client stdio` 的 command、args、cwd、非秘密 env 和 `forwardEnvironmentNames`，再按该客户端官方机制提供进程变量；通用配方不是另一客户端可直接导入的格式。

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
    args: ['/abs/path/to/WorkLoom-video-edit/scripts/edit-agent-mcp.mjs']
    cwd: /abs/path/to/WorkLoom-video-edit
    env:
      WORKLOOM_PRODUCT_ROOT: /abs/path/to/WorkLoom-video-edit
```

DSH 会清理继承环境中的秘密变量；需要访问服务时，按该客户端当前配置机制显式注入成员令牌和服务地址，不能把令牌字面量保存到仓库。接通检查：

1. 核对上面条目的 Node 可执行路径和本仓绝对入口，等价服务命令为：

   ```bash
   node /abs/path/to/WorkLoom-video-edit/scripts/edit-agent-mcp.mjs
   ```

   并把 `WORKLOOM_PRODUCT_ROOT=/abs/path/to/WorkLoom-video-edit` 等环境变量注入插件进程。
2. 重新加载插件后，以实际 `tools/list` 核对原始工具。按本例注册时 DSH 显示名会加 `mcp__workloom_video_edit__` 前缀。调用原始工具 `workloom_growth_video_workbench_guide`，参数 `{}`，回读产品身份和文档摘要。

> 说明：DSH 侧"自定义 STDIO MCP"的具体配置键以**你所用 DSH 版本的官方文档/插件页为准**；
> 我们这侧只保证"标准 stdio JSON-RPC + 工具清单"这一契约（协议版本含 2024-11-05 / 2025-03-26 /
> 2025-06-18 / 2025-11-25，见 `scripts/edit-agent-mcp.mjs`）。

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

> "先读 Edit 的 `workbench.guide` 和 `edit.agent.doctor`，完整保留我的原话和 Brief，用 `edit.video.workflow.plan` 出计划，不替我指定镜数或每镜秒数。按已授权范围启动文字前期；保留同一 `jobId` 查询。前期真实合格并具备本次媒体授权后接续，最后回读当前成片技术质检。未知结果不要重投，能力不支持就保留原始阻塞。"

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

- **认证**：新 Edit 入口使用 `WORKLOOM_ACCESS_TOKEN`（实际 B 端成员），或受控桌面实例的 `WORKLOOM_DESKTOP_LOGIN_KEY` 换取内存会话；不自动使用演示身份。旧 C 端读取另用 `WORKLOOM_C_TOKEN`，不混用。凭据只由受控进程环境提供，不写进仓库、命令行参数、日志或提示词；
- **地址**：Edit 原生入口仅接受明确端口的 `http://127.0.0.1:PORT`，先核验产品身份再在同一连接上传递成员凭据。将 `WORKLOOM_BASE_URL` 设为实际本机服务端口。旧通用读取入口的地址规则保持原样。默认能力地址按 manifest 的桌面端口偏移推导，源码服务不会自动采用这一偏移。非回环必须 HTTPS；
- **禁用能力**：`enabled=false` 的能力会从 MCP `tools/list` 消失，调用返回 `DISABLED` + 原因；
- **错误码**：清单/契约类错误返回 `{"error":{"code":...}}`；指南契约错误保留 `INVALID_INPUT` / `GUIDE_UNAVAILABLE`；其它本地能力自身抛错可能显示为 `INTERNAL_ERROR` + 可读原因
  （例如"路径监狱""超过读取上限"）；
- **路径监狱**：视频只读能力默认只允许**本仓相对路径**；仓外产物根需运行者显式设
  `WORKLOOM_VIDEO_ARTIFACT_ROOT`；绝对路径与 `../` 逃逸一律拒绝；
- **数据流**：旧读取工具只读本地文件或服务端查询；新 `start`、`repair`、`continue` 则进入原生执行，可能按本次批准的素材范围向实际模型或媒体供应商发送内容。读指南和本地 plan 的零付费性质不能延伸到执行工具。

---

## 7. 本仓本次落地的内容（便于对账）

- 新视频入口：`scripts/edit-agent.mjs`、`scripts/edit-agent-mcp.mjs`、`scripts/tools/edit-agent-setup.mjs`；新入口复用原生视频流程，配置工具只生成或显式安装客户端设置。
- 历史读取入口：`scripts/AGENT-CAPABILITIES.md`（基座受控资产，随 base-sync 下发）+ `scripts/workloom-agent.mjs`
  + `scripts/workloom-agent-mcp.mjs` + `scripts/agent-capabilities.{mjs,core.json,test.mjs}`；
- 仓库通用只读模块：`bundles/geo-growth/capabilities/repo.mjs`（4 条：`repo.status` / `repo.docs` / `bundle.summary` / `repo.readiness`，只读/预览；路径监狱 + 8MB/2 万行上限，不回显密钥值）；
- 视频能力模块：`bundles/geo-growth/capabilities/video.mjs`（只读/预览；另有固定指南模块 `workbench-guide.mjs`，见 §5）；
- 自检：`node --test scripts/agent-capabilities.test.mjs`（清单驱动的断言，基座与行业仓共用同一份）。
- 内置 DSH 组件版本与历史同步/验收记录另查本仓锁定文件；本次增加本仓原生视频接入与配置引导，没有升级该组件。
