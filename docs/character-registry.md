# 内置角色库与默认模特（2026-10-24）

本仓默认1号是 **李英子（`young-rider-01`），常用称呼英子**。她是本任务从纯文字开始重新生成的原创虚构AI成年女性：约20岁、鹅蛋脸、黑色高马尾、朝气蓬勃，黑色机车夹克、白T、深色长裤与黑靴。

李英子常被叫作英子，设定为工业设计专业大二学生，喜欢攀岩、滑板、机车文化和运动摄影。她好奇、爽快，有一点要强，也会面对新挑战时紧张；习惯先准备、再练习，像和朋友聊天一样分享发现。这些个性与履历都是虚构设定，完整角色基线在profile的identity/persona/biography中。

唯一事实源：[`registry.json`](../bundles/ai-video/library/characters/registry.json)；目录说明：[`characters/README.md`](../bundles/ai-video/library/characters/README.md)。

| 编号 | 姓名 / ID | 当前用途 | 档案与版本 |
|---|---|---|---|
| 1 | 李英子 / `young-rider-01` | 默认原创虚构AI模特 | `model-01-young-rider/profile.json`；当前`portraits/v2`，历史v1保留 |
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

本轮实际共11次纯文字POST，最终选用8张，另3张背面候选因服装/姿态不合要求未选；未选原图与原始来源在任务私有staging原样保留，输出SHA与排除记录见v2来源，不能把选中8张说成总共只生成8次。

李英子使用`kind: generated`、`subjectType: synthetic-digital-human`、`authorization.status: synthetic-no-real-person`。当前激活逻辑v2，真实Seedream八次独立纯文字请求没有任何图片输入。[`provenance/v2.json`](../bundles/ai-video/library/characters/model-01-young-rider/provenance/v2.json)记录真实model/created/安全trace、完整提示词和请求SHA、原始2K PNG的SHA/字节数/尺寸；逐张dispatch/来源JSON保留在同版本目录，原PNG不重编码、不缩放、不裁切、不修脸、不换背景。未返回的provider task_id为null，未编造seed；请求watermark=true如实记录，隐式水印未验证。

原v1八张1024×1536 PNG、v1版本文件、原provenance.json、历史reviews/gates保留原字节。v1来源仍是image_gen正面纯文字、其余7图只参考新AI正面；没有重贴Seedream标签。v1仅在当前profile中切inactive，显式版本引用仍有效；陈卓与林予安不变。

逻辑v2使用相对路径旧兼容结构，runtime scope为`legacy-current-bytes-only`。原图、profile、v1/v2版本、来源metadata均由bundle逐资产SHA保护。视觉连续性审阅不是生物识别身份认证或人工审批；独立供应商来源检查与真实审批门各自保存，不把byte verification当作全部验真。

## 加角色与完整性索引

1. 新增独立角色目录，写profile、定妆照不可变版本与可核对的来源记录。
2. registry追加唯一ID、唯一编号、姓名/别名、相对档案路径；profile编号同步。
3. 换默认时显式改 `defaultModel`，默认角色编号设为1；其它角色顺延，保持既有ID和历史路径。
4. 把随包运行资产加入 `bundle.json#provides.library` 并更新相应SHA与清单摘要。稳定包另需可信Ed25519签名；运行期账本与README不入索引。

官方门禁：`node scripts/verify-builtin-character-assets.mjs`；资产测试：`pnpm vitest run packages/video-studio/src/builtin-character-library.test.ts`。角色读取/选角实现是 `packages/video-studio/src/character-archive.ts`；正式行业包装载入口是 `packages/base/bundles/assembly.ts#loadVerifiedBundleManifest`。

角色资产随仓存在不代表模型、供应商账户和后期环境已经就绪。真人肖像仍走供应商授权素材通道；虚构AI档案不主张真人授权，也不能替代真人肖像许可。
