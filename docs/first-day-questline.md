# 首日上岗（Day-1 Questline）· 狐狸先生带玩

> 迁移自 workroom-fox 的试点（2026-09-18），并按本仓多行业形态改造：
> 机制在基座、内容随活动 Bundle 切换。首版：2026-09-18 ｜ 定位：把「新客户开箱后不知道下一步」
> 变成一场约 8 分钟的游戏。

## 1. 为什么做

欢迎仪式（织伴开场 + 3D 团队列队 + 剪彩）解决的是「看见一支团队」，但它结束时客户拿到的是
「进入系统，先逛逛 →」，落回经营主页后没有下一步。首日上岗补的就是这一段：
**由引导 NPC「狐狸先生」带着董事长走完五关，每关都有可点的事、可见的结果、可拿的成就。**

## 2. 五关主线

| 关卡 | 客户做什么 | 完成判定（只认事实或客户操作） |
|---|---|---|
| 1 认人 | 点亮 3 张员工卡（内容随活动 Bundle 切换），可换一批或跳过 | 三张核心卡点亮或主动跳过 |
| 2 定目标 | 三选一目标模板，或自己说一句 | 客户确认 |
| 3 派活 | 把一张任务卡派给数字员工（真实 `threads.dispatch`） | 线程创建成功 |
| 4 拍板 | 对真实审批做一次批准/修改/驳回（真实 `approvals.decide`） | 手势写回成功 |
| 5 验收 | 看交付与成绩单，选下一步（开夜班 / 接真实数据 / 定制行业版） | 客户确认 + 事实成就 |

全程可「稍后再来」，进度落 `localStorage`（`wl-questline-v1`），下次从同一关继续。

## 3. 内容包随活动 Bundle 切换（本仓与 fox 试点的最大差异）

员工卡、目标模板、任务卡、驳回枚举都是**行业内容**，因此按活动 Bundle 解析：

| Bundle | 内容包 | 三位当家人（第 1 关） | 驳回原因来源 |
|---|---|---|---|
| `hotel` | `QUESTLINE` | 收益定价官 / 口碑公关官 / 财务司库官 | `bundles/hotel/feedback-enums.yml` |
| `geo-growth` | `QUESTLINE_GEO` | GEO 内容策划 / 投放优化师 / 复盘分析师 | `bundles/geo-growth/feedback-enums.yml` |
| `ai-video` | `QUESTLINE_VIDEO` | 总导演 / 渲染师 / 发布专员 | `bundles/ai-video/feedback-enums.yml` |
| 其他 / 未知 | —— | 不显示引导（宁可不引导，也不把别的行业的人设与岗位塞给客户） | —— |

解析入口：`apps/web/src/onboarding/questline.config.ts` 的 `questlineForBundle(bundleId)`；
注入方式：`QuestlineContent` 上下文（组件不得再直接 import `QUESTLINE`）。

## 4. 引导 NPC：狐狸先生

- **形象**：纯 SVG + CSS 绘制（零图片、零 Live2D 新资产），延续本仓「零音频资产」的纪律；
- **六态**：idle 待命 / listen 在听 / talk 汇报（口型开合）/ think 跟进中 / celebrate 庆祝 / alert 需要您拍板；
- **声音**：`VoiceEngine` role=`fox-guide`，音色 pitch 0.86 / rate 0.94（与织伴 1.04/0.94 区分）；
  中文新奇音色（Eddy/Reed/Flo…）不发 `onboundary`，已由 `selectVoice` 降级为兜底，保证口型可用；
- **台词**：每关三句（进场 / 停留 9 秒的提示 / 过关），单句 ≤42 字；
- **降级**：`prefers-reduced-motion` 下关闭跳动与摆尾；任何动画失败不影响业务按钮。

## 5. 实现位置

```
apps/web/src/onboarding/
  questline.ts            纯逻辑：状态机 / 事实推进 / XP / 成就 / 持久化解析
  questline.config.ts     三套行业内容包 + questlineForBundle + coreCardIds
  QuestlineContent.tsx    内容包注入点（上下文；组件统一从这里取）
  useQuestline.ts         React 容器：持久化 + 事实驱动 + 本地漏斗埋点
apps/web/src/components/fox-guide/
  FoxGuide.tsx            NPC 本体（SVG + CSS，六态）
  FoxGuideBubble.tsx      打字机气泡 + 语音（口型随真实 TTS）
  QuestlineOverlay.tsx    五关引导壳（真实派活/审批接线；useManagedSurface 负责 Esc/焦点）
  QuestlineHud.tsx        常驻入口（狐狸先生待命位；窄屏紧凑形态）
  QuestlineStages.tsx     分关视图与动作条
```

P0（`apps/web/src/pages/p0/P0.tsx`）只做四件事：按活动 Bundle 解析内容包、挂载 HUD、
挂载引导壳、把真实事实（目标/派活/拍板/交付/待审数）汇总成 `QuestFacts` 传给 `useQuestline`。

## 6. 诚实边界（不可越线）

1. 没有回执的事不说「已完成」；任务完成与否只认服务端线程状态；
2. 没有待审事项时，第 4 关如实显示「暂无待拍板」并允许跳过——**不编造审批**；
3. 派活与审批都走真实接口，失败时明确「任务没有被创建」/「什么都不会改变」；
4. 演示数据在员工卡里标注「〔演示样例〕」；
5. 游戏不给权限：XP、成就、收集都不影响围栏与审批。

XP 口径与团队页 `roster` 完全一致：裁决×3 + 派遣×2 + 沉淀×5；等级阶梯 xp ≥ 8·LV²。
HUD 默认显示服务端累计 XP（「累计 N XP（本次 +M）」），避免同一屏出现两个等级。

## 7. 回归门禁

`apps/web/src/onboarding/questline.test.ts` 逐包校验：

- 五关齐备、每关三句台词与主按钮；
- 员工卡 / 目标卡 / 任务卡引用的 `presetKey` 必须真实存在于该 Bundle 的 `presets/`（防幽灵岗位）；
- 驳回原因必须逐码命中该 Bundle 的 `feedback-enums.yml`（第⑧槽），且标签非空；
- 演示样例必须标注 `sampleIsDemo`；未知 Bundle 必须返回 null（不显示引导）；
- 「三位当家人」= 内容包前三张卡（机制里禁止硬编码岗位 id）。

## 8. 生产化待办（本版未做）

- 进度持久化从 `localStorage` 迁到服务端（`onboarding_progress` 同构表），支持跨端续播；
- 内容包迁到 `bundles/<industry>/onboarding/*.yml`，由 `industry-contract` 的 Bundle 投影提供；
- 引导漏斗埋点（`questline.*`）接入真实渠道（当前仅本地留存）。
