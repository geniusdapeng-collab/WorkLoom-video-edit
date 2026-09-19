---
name: product-poster
version: 1.0.0
description: 商品海报工艺：主图卖点 + 参数锚点 + 价格/CTA 的 3:4 与 1:1 版式，走 Compositor 视觉工位渲染并带回执。绑定 G-VIS0..G-VIS4。
---

# 商品海报（Product Poster）

## 适用场景
- 新品上架、单品爆款、品类主推的电商详情首图与社媒主视觉（小红书 3:4 / 方形 1:1 / 竖版 9:16）
- 需要「主体突出 + 卖点 3 条以内 + 价格/CTA + 品牌锚点」的标准商业版式

## 输入
1. 品牌实体卡（confirmed 字段）：产品名、型号、材质/参数、价格逻辑、核心卖点与禁用表达；
2. 商品图（客户素材或视频抽帧；去背与否由 `image-retouch` 决定）；
3. 平台规格（`templates/platform-specs.json`，未核对条目只能内部预览）。

## 方法
1. 选模板：`templates/xiaohongshu-cover-3x4.json`（或同结构 1:1 模板），填 `brand/copy/assets/ai_label` 变量；
2. 主体层：`remove_background: true` 去背 → 投影/底色用纯色层垫出层次；产品图不拉伸变形；
3. 文案层：标题 ≤ 12 字（两行内）、卖点 ≤ 3 条、价格用粗体、赠品/权益单独一行；
4. 精修（可选）：`blur` 虚化背景、调整层做统一色调（曝光/色阶/渐变映射），不做「磨皮式」过度处理；
5. 渲染：`visualwrite.compose`（template+vars 或完整 recipe）→ `visualread.verify` 核对尺寸与哈希。

## 输出契约
- 成品 PNG（或多规格变体）+ `.comp` 工程 + 配方 + sha256 回执；
- 卖点与实体卡逐字一致；价格与活动口径以客户确认为准；
- 命名：`商品_钩子_版本`，入库一客一档。

## 边界
- 不含极限词（G-VIS2）；未确认参数不得进图；含人像/第三方素材过 G-VIS1 人审；
- 不直接发布（外发走 G9/G-GEO1）；无回执不交付。
