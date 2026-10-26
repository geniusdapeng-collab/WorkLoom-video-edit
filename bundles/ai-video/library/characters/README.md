# 内置角色档案库

本仓默认1号模特是 **李英子（`young-rider-01`）**：本任务新生成的原创虚构AI成年女性，约20岁、鹅蛋脸、黑色高马尾、朝气蓬勃，穿黑色机车夹克、白T、深色长裤与黑靴。没有显式指定出镜模特时，角色库消费方读取 [`registry.json`](registry.json) 的 `defaultModel`。

| 当前编号 | 人物与身份 | 档案路径 | 定妆照 |
|---|---|---|---|
| 1（默认） | 李英子 `young-rider-01`；原创虚构AI | [`model-01-young-rider/profile.json`](model-01-young-rider/profile.json) | `model-01-young-rider/portraits/v2/*.png`（v1保留），8角度 |
| 2 | 陈卓 `chen-zhuo`；原旗袍人物，授权真人历史档案 | [`model-01-chen-zhuo/profile.json`](model-01-chen-zhuo/profile.json) | `model-01-chen-zhuo/portraits/v3/*.png`，8角度 |
| 3 | 林予安 `lin-yu-an`；原2号原创虚构AI | [`model-02-lin-yu-an/profile.json`](model-02-lin-yu-an/profile.json) | `model-02-lin-yu-an/portraits/v1/*.jpg`，8角度 |

编号以 `registry.json#models[].ordinal` 和档案 `ordinal` 为准。陈卓与林予安的目录前缀是历史路径，保留它们可使已有项目继续按原ID与路径绑定。显式指定陈卓或林予安时仍使用各自身份，不因默认变更而换人。

## 新默认人物的生成证据

本轮实际共11次纯文字POST，最终选用8张，另3张背面候选因服装/姿态不合要求未选；未选原图与原始来源在任务私有staging原样保留，输出SHA与排除记录见v2来源，不能把选中8张说成总共只生成8次。

李英子当前逻辑v2选用真实Seedream八次独立纯文字请求的原始输出，无真人照片、旧角色图、正面主图或其它图片输入。八张2K PNG原字节保留，当前供应商model、created、实际返回的安全trace、请求及输出SHA见`model-01-young-rider/provenance/v2.json`；原始dispatch/来源收据位于其`provenance/v2/`。具体模型ID取实际响应，不把本地ID当provider task_id；未返回的task_id/seed不填造。

`profile.json`的身份、persona、成年虚构设定和w1造型不变；`portrait-sets/v2.json`为精确相对文件路径。v1八张1024×1536 PNG、`portrait-sets/v1.json`、原`provenance.json`及历史审批保留原字节与原来源：image_gen正面纯文字、其余7图只参考新生成AI主图。当前profile只把v1切为inactive，显式pin仍可读取；不改写旧来源。

八角度为front / threeQuarter / closeup / side / back / actionPose / emotionCloseup / handDetail。所有图片没有重编码、缩放、裁切、修脸或换背景。采用可移植旧兼容结构，runtime scope仍是`legacy-current-bytes-only`；SHA完整性由bundle索引保护。视觉连续性审阅不等于生物识别或人工门审批；watermark=true仅为真实请求事实，隐式水印未验证。

## 选角与使用

1. 显式写 `character` / `characters` / `cast` 或角色引用时，先解析指定身份。
2. 姓名和别名按registry解析；未显式指定出镜模特时，默认指向李英子。
3. 明确无人、产品或环境空镜不应从库中补入人物；指定但未建档的身份不得用默认模特顶替。

```json
{ "shotId": "S01", "character": "李英子", "costume": "黑色机车夹克、白T与深色长裤" }
```

陈卓写 `"character": "陈卓"`；林予安写 `"character": "林予安"`。历史项目的角色ID、版本与路径引用保持原身份。

## 完整性与维护

`registry.json`、三名在册角色的档案/定妆照，以及AI角色的生成证据均登记在 `bundles/ai-video/bundle.json#provides.library`。李英子的v1/v2版本与v2逐请求来源也在册。修改在册文件须在同一提交重算相应资产SHA和清单摘要；稳定包另需合法签名。运行期 `gates.jsonl` / `reviews/*.json` 和README不进入完整性索引，历史账本只增不改。

新增角色时新增独立目录、档案与不可变版本，在registry追加唯一编号；换默认时显式改 `defaultModel`，并将默认角色编号设为1，同步其它当前编号与文档。不得覆盖旧身份或旧图片。

验证：`node scripts/verify-builtin-character-assets.mjs`；`pnpm vitest run packages/video-studio/src/builtin-character-library.test.ts`。正式装载还会经过 `loadVerifiedBundleManifest` 的逐资产SHA校验。

真人肖像仍按平台授权通道使用。陈卓历史档案不代表李英子是真人数字化身，虚构AI授权状态也不能替代真人授权。

入口：[`docs/character-registry.md`](../../../../docs/character-registry.md) · [`character-archive.ts`](../../../../packages/video-studio/src/character-archive.ts) · [`portrait-binding.ts`](../../../../packages/video-studio/src/portrait-binding.ts)。
