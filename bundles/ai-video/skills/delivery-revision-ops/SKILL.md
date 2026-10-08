---
name: delivery-revision-ops
description: 返修闭环官方套件：反馈归因、层影响分析、基础工程版本/SHA 前置条件、独占版本认领、本地增量重合成与复用证据。保留完整反馈表、并发冲突和存储失败 SOP；成功镜头默认接受，组件或旧品质失败不重新生成，点名新生成保持 G8/G-DLV5，绑定 G-DLV4..G-DLV7。
---

# 后期返修闭环

## 反馈分诊与影响表

| 用户反馈 | 归因码 | 受影响层 | 默认动作 |
|---|---|---|---|
| 字幕错字/时间/字号 | `rev.text.track` | text | 本地文字返修 |
| 配乐太响/换曲 | `rev.audio.mix` | audio | 一次明确音频变更 |
| 偏黄/偏暗/冷调 | `rev.color.look` | color→audio→cover | 明确校正/配方变更 |
| 转场/顺序/节奏 | `rev.edit.pacing` | assemble→color→audio→text→cover | 本地重合成 |
| 封面字/首图 | `rev.cover.layout` | cover | 本地封面版本 |
| 标题/标签/CTA | `rev.copy.tone` | copy | 本地文案层 |
| 明确点名重生成画面 | `rev.shot.content` | shots 及其下游 | 独立 G8 新生成请求 |
| 无法归因 | `unclear` | 无 | 如实列可执行轴，不猜整片重做 |

分诊依据本仓确定性 `REVISION_RULES`，没有默认 LLM 品质评价。用户主动点名需要改变画面才产生新生成计划；组件更新、旧身份/服装/画质/台词品质失败不会产生新生成授权。

## SOP：影响 → 快照 → 新版本

```bash
post-cli impact --project delivery/film-project.json --patch patch.json
post-cli reedit --project delivery/film-project.json --patch patch.json --dry-run
post-cli reedit --project delivery/film-project.json --patch patch.json --expected-version 1 --expected-project-sha256 <sha256>
```

1. 触发为明确用户返修；运行 impact，回执记录 layers/localOnly/shotRegeneration/costHint。未知 patch 键或不存在镜号失败，禁止静默忽略。
2. 绑定用户选定工程的实际版本和 SHA256；dry-run 给 expectedVersion/expectedProjectSha256，写请求带同一对条件。回执保留基础快照；过期/变化失败，不偷偷刷新条件。
3. 取得包级独占锁并独占认领新 versions/vN 目录，按依赖拓扑只重算受影响层。原镜头/旧版本只读；失败目录留回执，不抢残留锁或复用已占版本号。
4. 复用前校验原来源 SHA256 与归一化当前 SHA256。未点名镜头和未影响层按证据复用；源变更或加工失败明确停止，不能只验证缓存而忽略原片变化。
5. 真实加工与请求导出完成后，最后发布 film-project.json 作为提交；回执逐层记录 rebuilt/reused、实际文件 SHA256、时间和费用。
6. 连续 v2→v3 使用各自工程目录重写路径；UHD 沿用目标画布，本地归一化/导出不默认启动 AI 增强。默认原节目音频不要求新分轨签章；显式提供分轨则必须真实有效。

## 版本/来源/并发参数边界

1. expected_version 与 expected_project_sha256 成对，版本为正整数、SHA256 为完整 64 位；过期请求 `revision_conflict` 不自动重试或换端点。
2. `revision_busy` 保留当前独占状态，残留锁需核对真实现状，不能凭 PID 自动抢占。
3. 原片、基础工程和旧版本禁止覆盖；新版本只增。真实存储失败为 `revision_io_failed`，不伪造提交完成。
4. 省略 `audio_stems_by_shot` 才使用原节目默认来源；显式 null/false/空或非法映射必须在认领版本前失败，不能静默降级。
5. 显式替换镜头需要真实可读新文件与来源授权；原片品质或名义时长不成为默认返修闸。
6. 付费重生成必须点名镜头与当前 G8/G-DLV5；只改字幕、配乐、封面、调色和文案不得重生成整片。

## 点名新画面路径

`reedit` 没拿到点名新画面时返回计划并拒绝执行（CLI exit 4）；经独立冻结请求与 G8 取得实际新镜头后，使用 `--shot SC-03=/path/new.mp4` 执行本地返修。未点名镜头复用来源证据。默认保留原节目声音，明确独立音源替换才提供合法四角色来源。

## 失败模式（症状 → 原因 → 处置）

| 症状 | 原因/首查 | 处置 |
|---|---|---|
| 工程前置条件过期 | baseVersion/baseProjectSha256 | `revision_conflict`，保存原请求，核对当前工程后另发明确请求 |
| 包/版本正在使用 | 独占锁和认领记录 | `revision_busy`，不抢锁、不自动重试 |
| 替换源或缓存被改 | 原来源/归一化 SHA256 | 来源失败，停止，禁止伪造复用 |
| 显式分轨映射非法 | 形状、四角色、来源签章/授权 | 请求失败，不降成默认原声、不占版本 |
| 未提供需要的新镜头 | 点名 regenerate 与 shotPaths | 返回新生成计划/G8，后期不自动花钱 |
| 实际 FFmpeg/写盘失败 | 命令、stderr、存储 | 保留失败目录和错误，工程不提交成功 |
| 用户只改一句字却整片重算 | impact 依赖层 | 修本地文字请求，原镜和无影响层复用 |
| 用户仍不喜欢旧品质 | 明确反馈范围 | 仅执行新明确变更，不自动评审/重做 |

## 回执、经验与输出

回执保存 commit.runId/baseVersion/baseProjectSha256/newVersion/newProjectSha256、patch、impact、rebuilt/reused、每个复用 SHA256。向用户说明改了什么、采用哪些原来源、实际花了本地算力或明确新渲染费用。不得把旧静态耗时当本次性能数据。

明确风格偏好可进入授权的偏好记录，事实错误进入缺陷池，返工归因进入岗位/考试记录；这些不覆盖当前 frozen source 与历史失败。品质未测为 null/qualityReviewed=false，完成依据为真实本地加工与授权。

回执的最小可对账结构：

```json
{
  "schemaVersion": "workloom.delivery-revision/v1",
  "version": 2,
  "commit": { "runId": "本次认领ID", "baseVersion": 1, "baseProjectSha256": "基础工程SHA256", "version": 2, "projectSha256": "新工程SHA256" },
  "patch": { "subtitles": { "zhText": "明确新文字" } },
  "impact": { "layers": ["text"], "localOnly": true, "costHint": { "tokenCostDelta": 0 } },
  "rebuilt": [{ "layer": "text", "variant": "warm-story" }],
  "reused": [{ "layer": "shots", "shotId": "SC-02", "sha256": "当前归一化文件SHA256" }]
}
```

字段值必须来自本次工程和回执；示例中的中文占位不能当实际 SHA256 使用。`tokenCostDelta=0` 只表示本地返修没有新增镜头提交；用户明确请求配音、增强或其他外部动作的费用按真实调用另记。

## 工艺指标与经验用途

| 指标 | 可验证口径 | 来源 / 后续用途 |
|---|---|---|
| 本地返修比例 | `impact.localOnly=true` 的实际返修数 / 实际返修总数 | revision 记录；不用合成目标冒充达成 |
| 影响层准确性 | patch 对应依赖层均完成，未影响层有复用证据 | impact / rebuilt / reused；检查是否漏重算 |
| 复用证据完整性 | 每个 reused 项有当前 SHA256，镜头同时绑定原来源 | 工程与当前文件；发现缓存或原来源篡改 |
| 连续版本可读性 | v2、v3 自己的工程路径都能读取实际产物 | 各版本 film-project.json；检查相对路径重写 |
| 实际耗时与费用 | 本次开始/结束时间和真实外部调用 | 执行回执；不复用过去某次真机耗时 |
| 用户选择与重复返修 | 仅统计实际选择事件及同一归因再次出现 | delivery.variant.selected / triage；改进下一次明确配方 |

硬字幕不可关闭。用户同时需要干净画面和烧字画面时保留干净母版，再生成明确请求的硬字幕副本；已有硬字幕素材可以继续加工，但不能承诺自动抹掉旧字或静默生成另一段画面。

课程与考试按可复算任务出题：音乐太响应改哪个本地层；只改字幕哪些字节应保持；v2→v3 路径如何对账；原片被替换但归一化缓存没变为什么仍须失败；用户点名新画面如何与本地返修分开留痕。
