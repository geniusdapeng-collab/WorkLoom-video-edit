---
name: design-critique
version: 1.0.0
description: 视觉评审闭环：用视觉模型（DeepSeek Flash）按固定评分卡评审，多样本取中位数，每轮只改 top3 问题，达到门槛才交付，人工终审。
---

# 视觉评审闭环（Design Critique）

## 触发
每次出图后、交付前必跑；修改后再跑一轮（复评）。

## 评分卡（0-10）
`composition / typography / color / material_quality / brand_fit / overall`
门槛：**中位数 overall ≥ 8** 可交付；6-7 修改；<6 重做。红线项（事实错误/未授权素材/缺 AI 标识/极限词）一票否决，无论分数。

## 方法
1. **多样本**：`visualread.critique` 传 `samples: 2`（重要物料 3），取 `median_overall`；单次评分不可作为结论（实测同一张图波动 ±1 分）；
2. **只改 top3**：每轮从 `fixes` 里选影响最大的 3 条执行，避免一版全推翻导致风格断裂；
3. **复评**：修改后重跑；收敛判据 = 连续两轮中位数提升 < 0.5 且无红线项，即可定稿（不必强求 8 分——模型评审偏严，人工终审有最终裁定权）；
4. **留证**：每轮评审 JSON（分数/问题/修改）随成品入一客一档，便于复盘与训练偏好。

## 输出契约
- 评审记录：`{model, samples, median_overall, critiques[], round, fixes_applied[]}`；
- 交付必须附：成品 + recipe + 工程 + sha256 回执 + 评审记录 + 人工终审结论。

## 边界
- 评审模型是"第二双眼睛"，不替代人工品牌/事实终审；
- 不为了刷分堆装饰元素；分数提升必须来自构图/层级/素材质量的实际改善。
