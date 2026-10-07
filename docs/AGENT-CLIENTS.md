# 桌面 Agent 接入指南：Codex / DeepSeek Harness（T-2026-1001-0008）

> 读者：要把本仓能力接进**桌面 Agent**的人（或 Agent 自己）。目标是**5 分钟能跑通**：
> 先 `list` 看到能力 → 再 `invoke` 读一条真实状态 → 最后把 stdio MCP 挂进客户端。
> **接到视频任务先读** [`AI 工作台视频调用指南`](ai-video-workbench-guide.md)，或 invoke `growth.video.workbench.guide`；冻结用户固定项后再执行。
> 视频链路的完整操作手册在 [`bundles/ai-video/README.md`](../bundles/ai-video/README.md)（§0–§6），本文只讲**接入**。

---

## 1. 5 分钟接入（所有客户端通用）

前置：Node.js ≥ 24（与 `package.json#engines` 一致）、已 `pnpm install`；**不需要**先起服务端也能用只读/预览能力。

```bash
# ① 看能力清单（每项含 ID / 操作类别 / 风险 / 数据模式）
node scripts/workloom-agent.mjs list

# ② 先读取本仓视频指南全文与 SHA-256（无网络、无模型、无渲染）
node scripts/workloom-agent.mjs invoke growth.video.workbench.guide

# ③ 看单项契约（输入 JSON Schema、传输方式）
node scripts/workloom-agent.mjs describe growth.video.production.status

# ④ 真跑一条只读能力（读本仓产物的阶段账本）
printf '%s' '{"projectId":"VID-FF02-FULL","workDir":"work"}' \
  | node scripts/workloom-agent.mjs invoke growth.video.production.status --input-file -

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

**视频的"执行"目前不在 MCP 里**：渲染/出片是本地长任务，走 CLI：
`scripts/tools/route-video.mts` → `scripts/tools/full-chain-film.mts`（见 `bundles/ai-video/README.md`）。
`growth.video.production.plan` 只给"建议命令 + 前置检查"，**不替你执行、不花钱**——这是产品所有者口径。

---

## 3. Codex 接入

Codex 支持本地 STDIO MCP。把下面这段加进 Codex 的 `config.toml`（`~/.codex/config.toml`），
**命令指向本仓**的 MCP 入口即可（多个仓可各配一条，用不同名字）：

```toml
[mcp_servers.workloom-growth]
command = "node"
args = ["/abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs"]
cwd = "/abs/path/to/WorkLoom-growth"
startup_timeout_sec = 60

[mcp_servers.workloom-growth.env]
WORKLOOM_PRODUCT_ROOT = "/abs/path/to/WorkLoom-growth"
# 只读能力可不配下面两项；要用服务端过程时按需配置（**不要写进仓库/日志**）
# WORKLOOM_BASE_URL = "http://127.0.0.1:9207"      # 打包产品默认8787+420；源码服务8787须显式填写
# WORKLOOM_ACCESS_TOKEN = "<B 端成员令牌>"          # 远程地址时必须
# WORKLOOM_C_TOKEN = "<C 端令牌>"                   # 仅 C 端能力需要，与 B 端令牌不可互换
```

> **官方核实（2026-10-07）**：STDIO 的 `command/args/env/cwd`、`startup_timeout_sec` 以及 `[mcp_servers.<name>]`
> 取自 [OpenAI 官方 MCP 文档](https://learn.chatgpt.com/docs/extend/mcp)。本任务实际验证本仓 CLI 与 stdio JSON-RPC 读取；
> 不把协议回读算作 Codex/DSH 桌面界面已经逐机验收。更换客户端版本时重新核对配置。

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
3. 用它的 `bash` 工具执行同一套命令（`pnpm video:doctor` → `route-video.mts` → `full-chain-film.mts`）。

### 4.2 桌面端接入 · 路线 B（把本仓 MCP 挂成 DSH 插件，能力进菜单）

本次对照 [DSH 官方 MCP 客户端说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/mcp/mcp-client/README.md)（2026-10-07）：每个服务器一项配置，使用 `@deepseek-ai/dsh-mcp-client`。在当前 profile 支持的插件配置位置加入以下条目；不把旧桌面界面按钮名当成跨版本保证：

```yaml
- id: workloom-growth-mcp
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workloom_growth
    transport: stdio
    command: node
    args: ['/abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs']
    cwd: /abs/path/to/WorkLoom-growth
    env:
      WORKLOOM_PRODUCT_ROOT: /abs/path/to/WorkLoom-growth
```

DSH 会清理继承环境中的秘密变量；需要访问服务时，按该客户端当前配置机制显式注入成员令牌和服务地址，不能把令牌字面量保存到仓库。接通检查：

1. 核对上面条目的 Node 可执行路径和本仓绝对入口，等价服务命令为：

   ```bash
   node /abs/path/to/WorkLoom-growth/scripts/workloom-agent-mcp.mjs
   ```

   并把 `WORKLOOM_PRODUCT_ROOT=/abs/path/to/WorkLoom-growth` 等环境变量注入插件进程；
2. 重新加载插件后，以实际 `tools/list` 核对原始工具；DSH 显示名会加 `mcp__workloom_growth__` 前缀。先读取原始工具 `workloom_growth_video_workbench_guide`，参数 `{}`，再以实际结果对账。

> 说明：DSH 侧"自定义 STDIO MCP"的具体配置键以**你所用 DSH 版本的官方文档/插件页为准**；
> 我们这侧只保证"标准 stdio JSON-RPC + 工具清单"这一契约（协议版本含 2024-11-05 / 2025-03-26 /
> 2025-06-18 / 2025-11-25，见 `scripts/workloom-agent-mcp.mjs`）。

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
- **地址**：默认 `127.0.0.1:8787+portOffset`（本仓 `product.manifest.json`）；**非回环必须 HTTPS**；
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
