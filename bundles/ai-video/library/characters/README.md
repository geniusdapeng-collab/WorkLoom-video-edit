# 内置角色档案库

本仓默认1号模特是 **李英子（`young-rider-01`）**：本任务新生成的原创虚构AI成年女性，约20岁、鹅蛋脸、黑色高马尾、朝气蓬勃，穿黑色机车夹克、白T、深色长裤与黑靴。没有显式指定出镜模特时，角色库消费方读取 [`registry.json`](registry.json) 的 `defaultModel`。

| 当前编号 | 人物与身份 | 档案路径 | 定妆照 |
|---|---|---|---|
| 1（默认） | 李英子 `young-rider-01`；原创虚构AI | [`model-01-young-rider/profile.json`](model-01-young-rider/profile.json) | `model-01-young-rider/portraits/v1/*.png`，8角度 |
| 2 | 陈卓 `chen-zhuo`；原旗袍人物，授权真人历史档案 | [`model-01-chen-zhuo/profile.json`](model-01-chen-zhuo/profile.json) | `model-01-chen-zhuo/portraits/v3/*.png`，8角度 |
| 3 | 林予安 `lin-yu-an`；原2号原创虚构AI | [`model-02-lin-yu-an/profile.json`](model-02-lin-yu-an/profile.json) | `model-02-lin-yu-an/portraits/v1/*.jpg`，8角度 |

编号以 `registry.json#models[].ordinal` 和档案 `ordinal` 为准。陈卓与林予安的目录前缀是历史路径，保留它们可使已有项目继续按原ID与路径绑定。显式指定陈卓或林予安时仍使用各自身份，不因默认变更而换人。

## 新默认人物的生成证据

李英子的正面主图由纯文字生成；余下7角度只参考这张本次新生成的虚构AI主图。没有输入真人照片、旧陈卓图、林予安图或任何既有人脸图片。

- `profile.json` 使用项目支持的 `kind: generated`，`subjectType: synthetic-digital-human`，授权状态为 `synthetic-no-real-person`。
- `provenance.json` 记录逐角度完整提示词、输入主图SHA-256、原始PNG的尺寸/字节数/SHA-256。实际模型ID、种子、供应商HTTP/task回执未由工具暴露，均未填造。
- `portrait-sets/v1.json` 记录版本、服装与精确相对文件路径。8张PNG为原始输出字节，无重编码、缩放、修脸或换背景。
- 8角度为 front / threeQuarter / closeup / side / back / actionPose / emotionCloseup / handDetail。所有图片均为1024×1536。
- 采用可移植的旧兼容结构，档案加载核验scope为 `legacy-current-bytes-only`；SHA完整性由行业包索引共同保护。未声称通过自动背景闸或生物识别身份认证。

## 选角与使用

1. 显式写 `character` / `characters` / `cast` 或角色引用时，先解析指定身份。
2. 姓名和别名按registry解析；未显式指定出镜模特时，默认指向李英子。
3. 明确无人、产品或环境空镜不应从库中补入人物；指定但未建档的身份不得用默认模特顶替。

```json
{ "shotId": "S01", "character": "李英子", "costume": "黑色机车夹克、白T与深色长裤" }
```

陈卓写 `"character": "陈卓"`；林予安写 `"character": "林予安"`。历史项目的角色ID、版本与路径引用保持原身份。

## 完整性与维护

`registry.json`、三名在册角色的档案/定妆照，以及AI角色的生成证据均登记在 `bundles/ai-video/bundle.json#provides.library`。李英子的 `portrait-sets/v1.json` 也在册。修改在册文件须在同一提交重算相应资产SHA和清单摘要；稳定包另需合法签名。运行期 `gates.jsonl` / `reviews/*.json` 和README不进入完整性索引，历史账本只增不改。

新增角色时新增独立目录、档案与不可变版本，在registry追加唯一编号；换默认时显式改 `defaultModel`，并将默认角色编号设为1，同步其它当前编号与文档。不得覆盖旧身份或旧图片。

验证：`node scripts/verify-builtin-character-assets.mjs`；`pnpm vitest run packages/video-studio/src/builtin-character-library.test.ts`。正式装载还会经过 `loadVerifiedBundleManifest` 的逐资产SHA校验。

真人肖像仍按平台授权通道使用。陈卓历史档案不代表李英子是真人数字化身，虚构AI授权状态也不能替代真人授权。

入口：[`docs/character-registry.md`](../../../../docs/character-registry.md) · [`character-archive.ts`](../../../../packages/video-studio/src/character-archive.ts) · [`portrait-binding.ts`](../../../../packages/video-studio/src/portrait-binding.ts)。
