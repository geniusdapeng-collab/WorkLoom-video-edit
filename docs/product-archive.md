# 真实商品档案（product-archive）

> 任务卡：`T-2026-0929-0004`（档案机制）/ `T-2026-0929-0005`（多商品方案 PPT 导入）｜ 建立日期：2026-09-29 ｜ 适用包：`bundles/ai-video`
> 事实源：`packages/video-studio/src/product-archive.ts`（档案格式/优先级/校验/提示词口径）
> 执行器：`scripts/tools/product-archive.mts`（search / from-research / build / import-pptx / import-pdf / verify / list）
> 消费方：`scripts/tools/full-chain-film.mts`（镜头 `product` 绑定 + `g-product-ref` 门）

## 1. 需求（产品所有者原话 → 设计目标）

| 原话 | 设计目标 |
|---|---|
| "这是一个销售产品视频，里面的产品一定是要真实的产品" | 涉及具体公司/品牌的片子，产品镜**必须**绑定真实产品图；没有档案就**先检索建档**，不允许 AI 编产品 |
| "如果系统中有具体的商品档案就用商品档案里面的，或用户上传的商品图" | 档案库 `bundles/ai-video/library/products/`；客户上传档案 `priority=10` |
| "没有就自己加一道流程，通过搜索获得真实的商品图和商品档案信息…打上一个标记…优先级低于用户上传的" | `product-archive.mts search` 自动检索 + 抓图 + 建档，标记 `source.kind=system-generated`、`priority=1`、`reviewStatus=pending-owner-review` |
| "附件 PPT 是这家公司对外官方合作方案…是一个完整的多商品的系统性方案" | 档案子系统升级为**三层**：`company`（公司与品牌）/ `solution`（方案与套装）/ `product`（单个商品，可按型号点单）；官方 PPT 用 `import-pptx` 一次性拆成三层档案，并把每张图、每条参数的**幻灯片来源**登记进证据 |

## 2. 档案格式（`workloom.product-archive/v1`）

```jsonc
{
  "schemaVersion": "workloom.product-archive/v1",
  "id": "archive-id（=目录名，稳定身份）",
  "displayName": "商品名",
  "type": "product | solution | company",   // 三层档案；缺省 product
  "model": "DEMO-02",                       // 商品档案：型号，可用型号点单
  "variants": [{ "name": "立式机", "model": "DEMO-02" }],
  "relations": {
    "companyId": "示例公司",
    "products": ["demo-kiosk", "demo-vertical"],  // company 档案用
    "includes": [{ "id": "demo-kiosk", "role": "自助入住终端" }]  // solution 档案用
  },
  "company": "示例公司",
  "brand": "示例品牌",
  "aliases": ["别名、英文名、常用叫法"],
  "source": {
    "kind": "user-upload | system-generated",
    "priority": 10,
    "generatedAt": "2026-09-29T…Z",
    "generator": "scripts/tools/product-archive.mts@build",
    "reviewStatus": "owner-confirmed | pending-owner-review",
    "providedBy": "客户提供的对外合作方案 PPT（原件不入仓）",
    "extraction": { "method": "pptx-slide-keyword-mapping", "verified": false, "note": "机器判定，请客户抽查" },
    "searchedQueries": ["系统档案必填：实际用过的检索词"],
    "evidence": [
      { "query": "…", "url": "来源页面", "title": "…", "site": "host" },
      { "query": "客户方案 PPT 第 3 页", "url": "pptx://方案.pptx#slide=3", "slide": 3, "slideTitle": "示例品牌 - 自助机产品介绍", "deckSha256": "…", "quote": "原文摘录" }
    ],
    "disclaimer": "系统档案必填：来自公开网页、授权与参数未核实"
  },
  "photos": [
    { "id": "hero", "file": "photos/01-front.jpg", "role": "hero", "sha256": "…", "bytes": 812345, "width": 1600, "height": 2400 }
  ],
  "specs": {
    "appearance": "只写能核实的可见外观",
    "features": ["可见结构"],
    "parameters": [{ "name": "型号", "value": "DEMO-02", "source": "slide 3" }],
    "notes": ["未核实参数不登记"]
  }
}
```

## 2.1 三层档案的分工（多商品方案）

| 层 | 档案 `type` | 装什么 | 图片策略 |
|---|---|---|---|
| 公司/品牌 | `company` | 品牌与别名、成员商品/方案索引、官方原件摘要（文件名 + sha256，原件不入仓） | 不强制图片 |
| 方案/套装 | `solution` | 方案定位、`relations.includes`（成员商品 + 角色）、整方案逐页证据 | 多商品页的素材（不硬塞给单个商品） |
| 商品 | `product` | 型号、参数（带 slide 来源）、可见外观、真实产品图 | **必须有图**（hero 主图必需），否则该商品档案不可用于出片 |

出片时镜头可以按 **id / 商品名 / 别名 / 公司 / 品牌 / 型号** 任一方式点单：
`{ "shotId": "SC-02", "product": "DEMO-02" }` 或 `{ "product": "示例品牌 AI 智慧前台（自助机 + 小程序）" }`。

## 2.2 产品规则文件（import-pptx / import-pdf 的 `--rules`）

批量导入客户方案 PPT / 产品 PDF 时，"页面 → 商品档案"的归属由**调用方提供的规则文件**判定——
代码里不内置任何客户商品。规则文件随项目保存在仓外或 work-dir，不入仓：

```jsonc
[
  { "id": "demo-kiosk", "name": "示例品牌 自助入住机", "model": "DEMO-01",
    "keywords": "自助入住|自助机|入住终端", "role": "自助入住终端" }
]
```

- `id`：稳定档案目录名（小写字母/数字/连字符）；`name`：商品名；
- `keywords`：正则源码（字符串）或字符串数组（任一命中即归属）；`model` / `role` 可选；
- 归属仍由机器按文案判定并标记 `extraction.verified=false`，投放前必须由客户抽查。

## 3. 硬纪律（与产品不变量的关系）

1. **客户上传 > 系统检索**：`PRODUCT_ARCHIVE_SOURCE_PRIORITY = { "user-upload": 10, "system-generated": 1 }`（唯一事实源）。
   同名命中两份时必须按优先级取高；同优先级多档命中判**歧义**并要求显式 id——不猜、不覆盖客户档案。
2. **系统档案必须留痕**：缺 `searchedQueries` / `evidence[].url` / `disclaimer` / `reviewStatus=pending-owner-review` 任一，档案 **hard 不可用**（出片环节 fail-closed）。
3. **图片是事实**：必须真实存在、sha256 与登记一致、≥50KB、可解析宽高（<600px 长边给软提醒）；缺 hero 主图不可用；路径必须收在档案目录内（拒绝逃逸）。
4. **不做"忠实映射"以外的加工**：读不到的字段留空；检索页的宣传语不得当"已核实参数"写进档案。
5. **授权是客户的事**：系统档案的免责声明写明"版权/商用授权/参数准确性未经确认"；投放前必须由客户核对（与"高风险动作人审"同源）。
6. **没有档案不硬拍**：公司/品牌/商品在库里查不到 → 管线报错并给出建档命令；**不允许生成"长得像"的替代产品**。

## 4. 出片链路怎么绑定

```
shotlist.json ──(company/brand/products/shot.product)──▶ 档案解析（优先级）
      │                                                      │
      │ 未命中 → fail-closed（附建档命令）                     │ 命中
      ▼                                                      ▼
报错停止                                            绑定 hero 主图 → 该镜成为素材镜
                                                     （photo + materialUsage=generation-reference + focus）
                                                            │
                                   g-product-ref 门（step_key）记录：档案 id / 来源 / 优先级 / 主图 sha256
                                                            │
                                    material-gen 阶段：真实产品图作生成输入（G-MAT1 把关）
```

镜头卡写法：

```jsonc
{ "shotId": "SC-02", "product": "某品牌 自助入住机" }        // 自动绑定主图（无需手写 photo）
{ "shotId": "SC-03", "product": "某品牌 自助入住机", "photo": "./自有素材/正面.jpg", "materialUsage": "generation-reference" }
// ↑ 自带素材时不覆盖（bound=false），但仍受 g-product-ref 记账与 G-MAT1 判据约束
```

## 5. 真机证据（2026-09-29）

| 场景 | 命令 | 结果 |
|---|---|---|
| 检索相关性硬闸（**反例**） | `product-archive.mts search --name "<无公开资料的小品牌>"` | 结果全部与品牌无关 → **不建档**、退出码 2，提示改用客户照片（不拿别家产品冒充） |
| 检索到公开产品图 | `product-archive.mts search --name "携住科技"` | 命中官网 + 案例页，收 4 张真实产品图，生成 `system-generated` 档案（含来源页面与检索词），`verify` 无 hard 问题 |
| 客户上传优先 | `product-archive.mts build …` | 生成 `user-upload`（priority=10）档案；同名解析取客户档案 |
| **客户方案 PPT 导入** | `product-archive.mts import-pptx --file <方案.pptx> --company <公司名> --brand <品牌> --rules <产品规则.json>` | 拆成 1 份公司档案 + 1 份方案档案 + N 份商品档案；单商品页图片带 `slide N` 来源落到对应商品，多商品页图片只进方案档案；归属标记 `extraction.verified=false` |
| **客户产品 PDF 导入** | `product-archive.mts import-pdf --file <产品资料.pdf> --work <解析目录> --company <公司名> --brand <品牌> --rules <产品规则.json>` | 逐页文本 + 内嵌图落到商品档案；参数与图片带 `page N` 来源；缺失页面不硬凑（如实失败） |
| 出片绑定（真机） | `full-chain-film.mts … --stages cine-kb,micromotion,spec,material-gen,videos`（镜头写 `product`） | `G-PROD1 g-product-ref` 门通过（客户上传 priority=10），镜头自动变素材镜、绑定 hero 主图，`G-MAT1` 提交门通过；**渲染可能因平台账号欠费（403 AccountOverdueError）停在提交前**，充值后可直接续跑（产物与门记录都在 work-dir） |

## 6. 受控专业研究入库（`from-research`）

已经通过宿主 `prepareMarketingFacts` 完成真实来源采集、逐主张引证、独立 LLM 原文支持审核和 Jenny 五站装订时，使用官方研究入库入口：

宿主保存的 A1 `identity.specs` 仍是已审核的字符串、数值或布尔值；交给 Jenny 装订时，宿主按精确 JSON Pointer 找到唯一的当前 A1 claim，再用该 claim 的真实来源 `finalUrl` 转成 Jenny 要求的 `{value, source_url}` 副本。原始回填及其 SHA256 不变，Jenny 出站规格也必须保持原值；缺来源、值变化或重复主张会失败，不能补造来源或直接删掉缺口。正式 Studio 使用同一转换，并对实际传入的转换 JSON 另算 SHA256，避免把已审核规格误报成「无来源」。真正没有用户评价或竞品证据时，A2/A3 的缺口和使用限制继续保留。

```bash
tsx scripts/tools/product-archive.mts from-research \
  --research work/research/prepared-research.json \
  --selection work/research/image-selection.json \
  --metadata work/research/archive-identity.json \
  --root work/library/products
```

宿主实现为 `apps/server/src/video/product-research-archive.ts`。命令只读取现有研究与图片、执行本地真实图片解码和建档，不联网、不调用模型、不重新收集、不收费。缺少研究、图片或媒体工具会明确失败。公开检索图不走 `build`，因为 `build` 的合同是客户上传。

三份输入文件的合同：

| 输入 | 必需内容与边界 |
|---|---|
| `prepared-research.json` | `prepareMarketingFacts` 返回的完整 `PreparedMarketingFacts`；放在其 `root` 根目录，保留当前 attempt 的 raw/text/review 文件及 Jenny dossier。来源事实不得由手写摘要或搜索摘要替代；研究有效期为 24 小时。 |
| `archive-identity.json` | 稳定 `id`、`displayName`、`type`（product/company/solution）；可选 `category/model/brand/company/aliases/relations`。名称可以采用用户指定的规范名，型号必须匹配已审核型号；不接受手写 specs/dimensions。 |
| `image-selection.json` | `schemaVersion=workloom.product-research-image-selection/v1`、显式绝对目录 `allowedImageRoots`、`images` 数组。逐图字段为 `id/file/pageUrl/imageUrl/sha256/bytes/angle`，可选 `role`。file 是这些目录内的真实原图，禁止 symlink 和目录逃逸；不能把任意本地文件冒充抓取图。 |

图片必须满足真实当前字节 SHA256、50KB–8MB、可探测且可完整解码的 PNG/JPEG/WebP/GIF、最长边至少 600px。`pageUrl/imageUrl` 必须精确命中本商品已独立审核的 A1.images；同一来源页中的邻近车型、推荐位或未审核图片不能仅靠网址存在入库。两项还必须在当前保存原文的真实图片属性或支持的结构化图片数据中可复核。结构化入口支持 `application/json`、`application/ld+json` 与识别出的 Nuxt hydration JSON 字符串字面量，不执行网页脚本；任意脚本、注释、template 中出现网址不视为图片来源。已有已审核角度不能被选择清单改写；未知角度可由显式选择清单登记，入库不冒称机器看图确认。重复图片字节和重复 ID 均拒收。

`angle` 只允许 `front/three-quarter/side/rear/detail/action/top`。商品档案必须有真实图片和且仅一张 hero；已审核类别为机动车的商品会规范为 `category=vehicle`，不能靠省略类别绕过检查。车辆还需至少两个合法角度，以及至少两个有来源、正数、有限数值的真实尺寸。尺寸仅从已审核 A1 的确定字段和明确单位换算，例如「座高 82.5 厘米」转换为 `seatHeightMm=825`，「轴距 1.42 米」转换为 `wheelbaseMm=1420`；数字字段本身携带 `Mm/Kg` 单位时也可确定映射。不识别的格式记录 gap，缺足够尺寸、同字段冲突或型号不符则拒收；湿重、净重等不擅自当作整备质量。

公司档案可以无图，并用 `relations.products` 关联产品。A1 的源绑定身份、规格、价格金额/币种/价格时点、来源主张均逐叶映射到 `specs.parameters`，来源主张同时写入 notes，从而保留型号用途限制，不把限制误当作卖点。创始人等短事实随 A1 `identity.specs` 的逐项来源映射，保留 claim ID 和源正文 SHA；未核实/冲突值不登记，长于 240 字的研究段落只记 gap，不能用新闻原文充当品牌介绍。产品提示词当前不会自动读取 parameters/notes；这些资料是否用于影片仍需正式营销事实与创作流程。

输出目录包含 `profile.json`、真实图片副本和 `research-import.json`。它们始终标记 `system-generated/priority=1/pending-owner-review`；回执保存研究 SHA、当前 dossier SHA、来源 URL/字节摘要、逐项 claim ID/引文 SHA、逐图来源映射、尺寸换算关联和研究缺口，不复制完整新闻正文、长引文或绝对本地研究路径。原文留在本地研究目录，原图保持只读。现有同名目录拒绝覆盖；需要替换时先按明确的资产变更流程处理已有档案。

每次入库都会重新读取当前 raw/text/review/dossier 文件：SHA、原文解码、引文偏移、完整审核内容、scope/attempt/型号和原始 A1 回填必须一致。仅有 `passed:true` 不构成审核证据。当前宿主审核回执是本机文件证据，不是抵抗任意本机写权限的密码学签章；入库不产生 G1 人工批准，不授予生产或发布资格，不确认图片商用授权。

## 7. 不做 / 留待后续

- **不做**：把检索图当"已授权素材"；用 AI 生成"同款产品"；在没有产品图时用占位图蒙混过关。
- **留待**：更多商详页与结构化图片数据的解析；1688/京东等平台的图文详情解析（需登录或反爬策略）；档案与媒资库 `media_product_profiles` 的双向同步（当前档案库是文件形态，服务端投影是发现面）。
- **边界**：中文 B2B 品牌大量没有公开官网（例如只在企查查/1688/展会页留痕），系统检索可能**抓不到可用产品图**——此时必须由客户提供照片；这条路径已在真机复现并如实失败。
