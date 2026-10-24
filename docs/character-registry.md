# 内置角色库与默认模特（2026-10-24）

本仓默认1号是 **李英子（`young-rider-01`），常用称呼英子**。她是本任务从纯文字开始重新生成的原创虚构AI成年女性：约20岁、鹅蛋脸、黑色高马尾、朝气蓬勃，黑色机车夹克、白T、深色长裤与黑靴。

李英子常被叫作英子，设定为工业设计专业大二学生，喜欢攀岩、滑板、机车文化和运动摄影。她好奇、爽快，有一点要强，也会面对新挑战时紧张；习惯先准备、再练习，像和朋友聊天一样分享发现。这些个性与履历都是虚构设定，完整角色基线在profile的identity/persona/biography中。

唯一事实源：[`registry.json`](../bundles/ai-video/library/characters/registry.json)；目录说明：[`characters/README.md`](../bundles/ai-video/library/characters/README.md)。

| 编号 | 姓名 / ID | 当前用途 | 档案与版本 |
|---|---|---|---|
| 1 | 李英子 / `young-rider-01` | 默认原创虚构AI模特 | `model-01-young-rider/profile.json`；`portraits/v1` |
| 2 | 陈卓 / `chen-zhuo` | 原旗袍人物，显式点名时使用 | 历史路径 `model-01-chen-zhuo/profile.json`；`portraits/v3` |
| 3 | 林予安 / `lin-yu-an` | 原2号原创虚构AI，显式点名时使用 | 历史路径 `model-02-lin-yu-an/profile.json`；`portraits/v1` |

三个身份各有8张标准定妆照。目录名的旧编号不承担当前编号语义；当前编号以registry与profile为准。更换默认不改变已有项目按ID、路径、版本绑定的人物。

## 默认与显式人物

角色库消费方读取 `registry.json#defaultModel`；未显式指定出镜模特时选择李英子。原镜头明确指定人物时优先逐人绑定，姓名/别名无法唯一匹配则明确失败，不用默认人物补位；空镜、产品或环境镜头没有出镜人物证据时不带入人物。

```jsonc
// 显式使用新默认1号
{ "shotId": "S01", "character": "李英子", "costume": "黑色机车夹克、白T与深色长裤" }
// 陈卓现在是2号，身份与历史旗袍资产继续保留
{ "shotId": "S02", "character": "陈卓", "costume": "月白色苏式改良旗袍（w1）" }
// 林予安现在是3号
{ "shotId": "S03", "character": "林予安" }
```

## 来源与核验边界

李英子使用项目已有的 `kind: generated`，`subjectType: synthetic-digital-human`，`authorization.status: synthetic-no-real-person`。正面是纯文生主图，另7张只参考这张新生成的虚构AI正面图，没有真人照片或既有角色人脸输入。

[`model-01-young-rider/provenance.json`](../bundles/ai-video/library/characters/model-01-young-rider/provenance.json) 包含8个完整提示词、参考图SHA、输出SHA/字节数/尺寸；全部原PNG为1024×1536，保持原始字节。工具没有暴露实际模型ID、种子、供应商HTTP请求ID或task ID，档案没有填造这些字段。未验证隐式水印、自动背景闸或生物识别同一性。

李英子使用可移植的旧兼容定妆照结构，档案加载的核验scope为 `legacy-current-bytes-only`；这表示当前文件可读取且角度齐备。8图、profile、provenance与portrait-set同时进入行业包完整性索引，逐资产SHA变化会被经过验证的行业包装载器拒绝。陈卓与林予安的历史档案、原图和历史回执继续保留原来源，不重写成新人物的生成证据。

## 加角色与完整性索引

1. 新增独立角色目录，写profile、定妆照不可变版本与可核对的来源记录。
2. registry追加唯一ID、唯一编号、姓名/别名、相对档案路径；profile编号同步。
3. 换默认时显式改 `defaultModel`，默认角色编号设为1；其它角色顺延，保持既有ID和历史路径。
4. 把随包运行资产加入 `bundle.json#provides.library` 并更新相应SHA与清单摘要。稳定包另需可信Ed25519签名；运行期账本与README不入索引。

官方门禁：`node scripts/verify-builtin-character-assets.mjs`；资产测试：`pnpm vitest run packages/video-studio/src/builtin-character-library.test.ts`。角色读取/选角实现是 `packages/video-studio/src/character-archive.ts`；正式行业包装载入口是 `packages/base/bundles/assembly.ts#loadVerifiedBundleManifest`。

角色资产随仓存在不代表模型、供应商账户和后期环境已经就绪。真人肖像仍走供应商授权素材通道；虚构AI档案不主张真人授权，也不能替代真人肖像许可。
