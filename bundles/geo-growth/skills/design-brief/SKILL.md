---
name: design-brief
version: 1.0.0
description: 设计需求分析工艺：把模糊的"做张图"变成可执行 brief（受众/渠道/目标/成功标准/必须信息/禁用/规格），未确认不开工。
---

# 设计需求分析（Design Brief）

## 触发
任何视觉任务开工前。禁止拿到一句话就直接排版。

## 方法
1. 六问澄清（能自行推断的先推断并标注假设，方向性冲突才回问客户）：
   - 给谁看（受众画像与场景）？
   - 发在哪（平台/尺寸/投放方式）？
   - 要什么行动（到店/私信/下单/收藏）？
   - 成功标准（点击/到店/询盘，口径可量化）？
   - 必须出现与必须不出现（品牌锚点/价格/合规红线）？
   - 交付规格（画布/格式/数量/截止）。
2. 产出 `brief.json`（字段固定，写入一客一档）：
   `{audience, channel, objective, success_metric, must_include[], must_avoid[], assets_available[], specs{width,height,format}, deadline, assumptions[]}`
3. 把"素材从哪来"写进 brief：客户实拍 > 正版图库 > AI 生图（优先级与授权说明）。

## 输出契约
- brief.json + 一句设计目标陈述（"让 X 人群看到 Y 后做 Z"）；
- 人（客户/运营负责人）确认后才进入 art-direction。

## 边界
- 不替客户编造价格/资质/参数；缺失信息列入 assumptions 并显式标注"待确认"；
- 方向性冲突（如既要求"高端克制"又要求"大促叫卖"）必须澄清，不得同时塞进一张图。
