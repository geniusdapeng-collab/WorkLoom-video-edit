---
name: compositor-designer
version: 1.0.0
description: 视觉素材生产工艺（Mac 视觉工位官方套件）：设计配方→Compositor 工程(.comp)→多规格 PNG/JPEG→回执校验。绑定 G-VIS1..G-VIS4；卸载即撤销。
---

# 视觉素材生产工艺（Compositor 视觉工位）

## 适用场景

- 短视频封面/首图、图文平台多规格构图（同一文案不同版式与尺寸）
- 投流图文变体（换背景/换配色/换主体位置，不改事实）
- GEO 信源配图（参数对比图、实体锚点图、清单图）
- 品牌素材复用（品牌色板、LOGO 安全区、版式配方沉淀为一客一档资产）

## 分工（先分清谁做什么）

| 环节 | 谁做 | 说明 |
|---|---|---|
| 版式/文案/规格决策 | 本岗位（视觉设计师） | 读品牌实体卡与脚本成套包，产出设计配方 `design_recipe` |
| 文案与标题排版 | 上游文字预渲染（`visualwrite.text`） | Compositor 无文字层（上游 issue #1），文字先渲染为透明 PNG 再作为图层合成 |
| 图像精修/合成/蒙版/去背 | Compositor 视觉工位（`visualwrite.compose`） | 复用上游 `ProjectStore`/`ImageExporter`/`LayerRenderer` 渲染内核 |
| 成品校验 | `visualread.verify` | 尺寸、字节数、SHA-256 逐项核对 |
| 外发 | 发布岗位 | 走 G9 / G-GEO1 必审，本岗位不直接外发 |

## 步骤

1. **读输入**：脚本成套包（标题/卖点/实体锚点）+ 品牌实体卡（confirmed 字段）+ 平台规格；
2. **出配方**：`design_recipe` 固定字段——画布尺寸、图层清单（底图/主体/文字 PNG/装饰）、每层位置尺寸与混合模式、蒙版来源、导出规格；配方入 `render_job` 事件；
3. **配文字**：标题、价格、CTA、免责声明分别调用 `visualwrite.text` 生成透明 PNG；文案与实体卡逐字一致，禁止改写事实；
4. **合成渲染**：`visualwrite.compose` 输出 `.comp` 工程 + PNG/JPEG 成品；工程文件与成品一并归档（工程是可复现的事实源）；
5. **校验**：`visualread.verify` 核对尺寸/哈希；无回执标「未核实」，不得宣称完成；
6. **回写**：成品与配方写入一客一档 `content_assets.visual_assets[]`，附审批引用。

## 输出契约

每张成品必须附：

```json
{
  "asset_uri": "file:///…/cover-3x4.png",
  "sha256": "…",
  "width": 1242, "height": 1660,
  "platform": "xiaohongshu-cover",
  "recipe_id": "recipe-…",
  "project_uri": "file:///…/cover-3x4.comp",
  "source_assets": ["…"],
  "qc": { "dimensions": true, "alpha": true, "brand_color": true },
  "receipt": { "synced": true, "verified_at": "…", "snapshot_uri": "…" }
}
```

## 边界（什么不做）

- 不用 Compositor 做文字排版源（它没有文字层）；文字必须预渲染成 PNG；
- 不导出 PSD/SVG/CMYK 场景（上游不支持）；交付格式仅 PNG/JPEG、sRGB；
- 不跨越画布上限（单边 30000px、总量 1 亿像素）；
- 不改写事实性文案；极限词/未确认参数命中 G-VIS2 即阻断；
- 未过 G-VIS1 合规审的含人像/第三方素材不得进入生产渲染；
- 无回执不得进入发布队列（G-VIS5）。

## 依赖与权限声明

- 依赖：Compositor（MIT，pin 版本，见 `docs/visual-workstation.md`）+ Mac 视觉工位 bridge（`visualread.*` / `visualwrite.*` 工具面）；
- 工具白名单：`visualread.health`、`visualread.inspect`、`visualread.verify`、`visualwrite.compose`、`visualwrite.render`、`visualwrite.text`；
- 出站域：无（工位内网；客户素材不出租户域）；
- 建议围栏参数：`dailyRenderCap=50`、`portraitRequiresApproval=true`、`thirdPartyAssetRequiresApproval=true`、`forbiddenClaimAction=block`、`noReceiptNoPublish=true`。
