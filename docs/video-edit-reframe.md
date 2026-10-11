# 二次构图（取景轨道）：契约、渲染口径与机检（T-2026-1011-0008）

> 结论先行：二次构图 = **源原生裁切（crop-first）** + **填充策略（pad/cover/blur/brand）** + **可选动画（zoompan）** + **每镜回执与事实类机检**。
> 它解决三件事：① 中景切近景/局部放大（不靠"把成品放大"）；② 横转竖不留黑边；③ 同一脚本可按变体出不同构图观感（第六风格轴）。
> 适用范围：`workloom-ai/WorkLoom-video-edit` 的剪辑管线（`pnpm edit:post` / `pnpm edit:assemble` + `bundles/ai-video/connectors/post-bridge`）。
> 证据口径：本机 ffmpeg 6.0（2026-10-11 实测）；默认 **关闭**（`--reframe off`），显式开启才改变像素。

## 1. 问题（升级前）

| # | 现状 | 后果 |
|---|---|---|
| 1 | 归一化链是 `scale(decrease)→pad→(punch)scale→crop`（`packages/video-studio/src/edit/timeline.ts`） | **先降分辨率再放大**：4K 素材进 1080p 画布时，无损可裁的像素被提前毁掉 |
| 2 | 16:9 素材进 9:16 画布只走 `pad` | **黑边留黑**：推近只是把"带黑边的画面"一起放大 |
| 3 | `punchIn` 在 `edit:post` 预切阶段就烘焙进像素 | **不能当风格轴**：三个变体共用同一构图；返修改构图要全量重剪 |
| 4 | post-bridge 无 `crop/zoompan/overlay` 等滤镜面 | 没有局部放大、没有动画运镜、没有画中画/蒙版 |

## 2. 设计（五层）

```text
时间轴 segments[].reframe（契约）
  → planReframe（纯函数：景别阶梯 / 无损预算 / 降级与回执口径）
  → planAssembly（preserveSource 预切：只 trim+变速，不缩放到画布）
  → post-bridge normaliseShots（crop-first 取景链 + 逐镜机检 + 回执）
  → delivery-manifest.json#reframe + reframe/reframe-receipt.json（交付面汇总）
```

### 2.1 契约（`bundles/video-edit/schemas/edit-timeline.schema.json`）

```jsonc
"reframe": {
  "mode": "static | push | pull | follow | locked-cut",
  "intent": "shot-size | emphasis | aspect-fill | breathing",
  "shotSize": { "from": "MS", "to": "CU" },          // 景别阶梯（CINE-002 词汇）
  "scale":  { "from": 1.0, "to": 1.15 },             // 取景倍率（1–3）
  "center": { "from": { "x": 0.5, "y": 0.45 }, "to": { "x": 0.5, "y": 0.45 } },
  "anchor": "manual | center | subject | face | saliency | keyframe",
  "easing": "linear | smooth | ease-in-out",
  "fill":   "pad | cover | blur | brand",
  "maxZoomPolicy": "lossless | allow-upscale",
  "safeArea": "respect | ignore",
  "note": "选镜理由（人读）"
}
```

- `punchIn` 保留为 legacy 子集（静态推近），两者同时存在时以 `reframe` 为准；
- 未声明 = 完全沿用旧链（**零行为变化**）。

### 2.2 无损放大预算（关键质量闸）

设画布 `Wo×Ho`、源 `Ws×Hs`，先取"画布同比例、能放进源画面"的最大基窗 `Wb×Hb`：

```
fillUpscale    = Wo / Wb                 // 画幅转换本身的上采样（与推近无关）
sMaxLossless   = min(Wb/Wo, Hb/Ho)       // 无额外上采样的推近上限
额外推近上限    = max(1, sMaxLossless)     // sMax<1 时只禁止"额外推近"
effectiveUpscale = fillUpscale × s       // 相对源像素的等效上采样（回执如实记账）
```

| 场景 | 额外推近上限 | 说明 |
|---|---|---|
| 4K 16:9 → 1080p 16:9 | **2.00×** | 2× 裁切仍无损（4K 素材的隐藏价值） |
| 4K 16:9 → 1080×1920 | **1.125×** | 横转竖的填充本身要 0.889× 下采样，推近空间很小 |
| 1080p 9:16 → 1080×1920 | **1.00×** | 任何推近都是放大；≤1.12× 观感可接受，更大需 `allow-upscale` 或先做 AI 增强 |
| 1080p 16:9 → 1080×1920 | **1.00×**（fillUpscale 1.78×） | 填充本身即上采样——回执标 `fillUpscale`，建议换素材或改用 blur/brand 观感 |

超预算默认**降级到上限并写 advisory**；要真放大必须显式 `maxZoomPolicy: "allow-upscale"`（引擎侧硬项会拒绝静默上采样）。

### 2.3 渲染链（ffmpeg 6.0 实测可跑）

```text
静态 cover   ：crop(w=基窗/s, x=(iw-ow)*cx) , scale=Wo:Ho:flags=lanczos
动态 cover   ：crop(基窗) , zoompan(z=s(t), x=(iw-iw/zoom)*cx(t), y=…, d=1:s=Wo x Ho)
blur 填充    ：split → 背景 scale(increase)+crop+gblur=sigma=20 → 前景 crop(基窗)+scale(fit) → overlay 居中
brand 填充   ：同 blur，背景 gblur=sigma=40 + eq(brightness=-0.15,saturation=0.4)
pad（兼容）  ：scale(decrease)+pad（可选 zoompan 推近）——保留旧观感
```

**为什么用 zoompan 而不是 `scale=eval=frame`**：后者在 `-vf` 链里逐帧改尺寸会触发
`Error reinitializing filters`（本任务真机实测复现），zoompan 是 ffmpeg 里能在恒定输出尺寸下逐帧缩放的成熟滤镜
（本仓 `scripts/tools/full-chain-film.mts` 的生成侧运镜也是同一手法）。

**注意**：动画链必须锁定时长（`-t <片段时长>`），否则 zoompan 会把输出外推（真机踩坑，见 §5 实测）。

**版本兼容**：缩放/位移的逐帧表达式一律用 `on`（输出帧号）而不是 `time`——
`time`/`frame` 是 FFmpeg 6.0 才加入的 zoompan 变量，而 CNB test-gate 的 Debian 12 装的是 ffmpeg 5.1；
用 `time` 会在 5.x 上直接失败（本任务 CI 实测根因，已在 T-2026-1011-0008 修复）。

### 2.4 机检与回执（无回执不算完成）

逐镜回执 `<归一化产物>.json#reframe`（`workloom.reframe-receipt/v1`）；交付面汇总
`reframe/reframe-receipt.json`（`workloom.reframe-summary/v1`）+ `delivery-manifest.json#reframe`。

| 检查 | 级别 | 判据 |
|---|---|---|
| `reframe_zoom_with_budget` | 硬 | `s ≤ max(1, sMaxLossless)`（或显式 allow-upscale）；回执记录 `fillUpscale`/`effectiveUpscale` |
| `reframe_duration_preserved` | 硬 | 输出时长 = 源片段时长 ±0.2s |
| `reframe_no_letterbox_defect` | 硬 | `cover/blur/brand` 时四边不得出现纯黑条带（左边缘 8px 采样亮度 > 6） |
| 缓存一致性 | 硬 | 复用归一化缓存前核对 `reframe.key`；上次失败的缓存直接拒用（不静默复用） |

### 2.5 第六风格轴（变体调制）

变体配方可写 `reframe: { fill, scaleMultiplier, easing, note }`：
**只能在时间轴已声明取景的基础上调制**（强度/填充/缓动），没有声明时一律不生效（保持默认零变化）。
调制后的镜头走独立归一化目录（按 reframe 内容哈希缓存），不污染母版。

## 3. 怎么用

```bash
# 默认：完全沿用现状（不改变任何像素路径）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/<film>

# 只渲染脚本声明（时间轴里写了 reframe / punchIn 的段落）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/<film> \
  --reframe declared --reframe-fill cover --reframe-max-zoom budget

# 整片一键推近（未声明段落用全局倍率；已声明段落以声明为准）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/<film> \
  --reframe declared --reframe-scale 1.0,1.15 --reframe-fill cover

# 横转竖不留黑边（模糊底 + 前景完整）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/<film> \
  --reframe declared --reframe-fill blur --reframe-max-zoom 1.5

# 呼吸感微推（未声明段落自动 1.00→1.03，确定性；主体跟随需 P1 分析站）
pnpm edit:post -- --timeline film.timeline.json --out-dir outputs/edit/<film> \
  --reframe auto --reframe-fill cover
```

时间轴侧（剪辑脚本/Agent 声明）：

```jsonc
{ "seq": 3, "segmentId": "S4", "sourceId": "src-1", "sourceIn": 12.0, "sourceOut": 15.2, "durationSeconds": 3.2,
  "reframe": { "mode": "push", "intent": "shot-size", "shotSize": { "from": "MS", "to": "MCU" },
               "scale": { "from": 1.0, "to": 1.15 }, "center": { "from": { "x": 0.52, "y": 0.42 }, "to": { "x": 0.52, "y": 0.42 } },
               "fill": "cover", "maxZoomPolicy": "lossless", "note": "把中景推到中近景，强调表情" } }
```

## 4. 实测（2026-10-11，Apple Silicon，ffmpeg 6.0）

输入 4s / 1280×720 / 30fps → 输出 1080×1920（veryfast / crf18）：

| 链 | 耗时 | 说明 |
|---|---|---|
| 静态 cover | ≈1.7s | crop-first + lanczos |
| 动画 push（zoompan） | ≈2.5s | z 1.0→1.25 平滑曲线 |
| blur 填充 | ≈7.0s | gblur sigma=20 + overlay（最重的一档） |

事实类断言（集成测试 `bundles/ai-video/connectors/post-bridge/reframe-integration.test.mjs`，5/5 通过）：
输出画布尺寸精确、时长守恒（±0.2s）、cover/blur 边缘亮度 > 6（无黑边缺陷）、
回执硬项全过、超预算 lossless 必须 fail-closed、未声明 reframe 时旧链零变化。

单元测试（`packages/video-studio/src/edit/reframe.test.ts`，35 项全绿）覆盖：契约归一/校验、
预算三档、景别换算、降级 advisory、全局推近、preserveSource 预切、渲染链字符串断言。

## 5. 已知边界（本版不做什么）

1. **不做主体检测/跟踪**（`anchor: subject/face/saliency` 的自动路径属于 P1 分析站；本版按 center/manual 渲染，并在回执注明）；
2. **不做画中画/分屏/蒙版**（P2；`overlays` 契约与渲染链未落地，因此**不进 schema**，避免"只声明不执行"）；
3. **不做逐帧稳定/锐化补偿**（P2/P3；本版超预算只降级 + 记账，不自动 AI 增强）；
4. **不做返修期改构图**（`postwrite.reedit` 暂不接受 reframe patch；改构图 = 新交付版本，P1 再开）；
5. 动画链与 `speed` 叠加时，zoompan 的时间基准是变速后的时间轴（`setpts` 之后）——已在实现顺序上保证，但 P1 会补一条真机回归。

## 6. 回滚

```bash
git revert <本任务合并提交>
```

- 回滚后：`--reframe*` 参数失效（未知参数被忽略与否取决于 CLI 解析，本版参数解析在 CLI 内，回滚即恢复旧 CLI）；时间轴里的 `reframe` 字段在旧代码下被忽略（`additionalProperties: false` 的旧 schema 会拒绝——如需前向兼容可同时保留 `punchIn` 写法）；
- 运行时零残留：不新增依赖、不新增常驻进程；回执文件随交付目录，不写系统路径。

## 7. 文件地图

| 文件 | 角色 |
|---|---|
| `bundles/video-edit/schemas/edit-timeline.schema.json#segments[].reframe` | 契约（枚举/区间） |
| `packages/video-studio/src/edit/reframe.ts` | 计划层纯函数（景别阶梯/预算/降级/渲染链字符串） |
| `packages/video-studio/src/edit/reframe.test.ts` | 单元测试（35 项） |
| `packages/video-studio/src/edit/timeline.ts` | 校验接入 + `planAssembly`（preserveSource / crop-first） |
| `bundles/ai-video/connectors/post-bridge/core.mjs` | 引擎：`normalizeShotReframe`/`computeReframeBudget`/`buildReframeChain`/`verifyReframeOutcome` + 变体调制 |
| `bundles/ai-video/connectors/post-bridge/reframe-integration.test.mjs` | 真 ffmpeg 集成测试（5 项） |
| `scripts/tools/edit-post.mts` | CLI：`--reframe/--reframe-fill/--reframe-max-zoom/--reframe-easing/--reframe-scale` |
