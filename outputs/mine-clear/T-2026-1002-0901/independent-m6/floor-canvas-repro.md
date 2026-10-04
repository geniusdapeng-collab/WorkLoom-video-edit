## 覆盖率声明

- 本反例直接相关 tracked 文件 5 个均已完整读取：`Floor.tsx`、`Floor3D.tsx`、`naming.ts`、`packages/base/captain/floor.ts`、GEO `floor-scene.json`。P0 调用入口已在此前完整读取。
- 本记录只覆盖 Canvas 职场布局与选择回调；正式 M6 覆盖率以最终 `file-coverage.csv` 为准。
- 实际安装的 `@workloom/ui` package.json、dist/index.js、dist/language.js 已读取；外部依赖读取单列，不算仓库 tracked 全量精读。

原始源为 `955e2277ee1496cfc4b40bd30345d1ce1be1acf1`，root 台账 ID 为 **OBS16**，独立 M6 ID 为 **OBS14**。原始 Floor 字节 SHA256 为 `3ee3d6727e1c8bd770dbda414d9b55fc5891069de112ec90dfb84dc3a6efe7c7`。

**A + 实际运行：** P0 在 `!showWelcome && webglOk` 以外的分支直接选择 `apps/web/src/pages/p0/Floor.tsx` 的 `FloorView`（P0.tsx:431–447）。原实现 targetOf:76–90 用有限 hash 微偏移决定共享工位、休息区及指挥台站位；标签244–266随站位绘制，点击289–303按逆序圆形范围选中人物。SQL 派生为18人循环工位、queued 也是合法上游状态（packages/base/captain/floor.ts:218–222、272–275）。

复现最小步骤：

1. 原始 HEAD 上使用实际 GEO `bundles/geo-growth/floor-scene.json`，构造18个 id不同、岗位名称不同的 `FloorAgent`，每人 `state="idle"`、`stationId=null`、无 currentThread。
2. 将 payload 传给实际 `FloorView`，接收真实 `onOpenProfile` 与 `onOpenTask` 回调。固定1440×900视口，Canvas实际768×440；对照390×844视口，Canvas358×380。
3. 执行实际组件的300次 frame。观察休息区的岗位名牌与人形聚集。点击每个绘制位置，记录回调返回的员工id。
4. 正常循环工位、全部同一工位、asking/null、blocked/shared、working/shared、queued/shared、celebrating/null同样执行。单人idle与单人working作为正常对照，工作任务牌单独点击。

可重复执行的本地命令（在任务 workspace 根目录，使用本任务已有运行器；不会调用模型供应商）：

```sh
python3 outputs/growth-production-fix-2026-10-02/independent-m6/run_check.py floor-canvas-repro node ../../outputs/growth-production-fix-2026-10-02/independent-m6/floor-canvas-probe.mjs 955e2277ee1496cfc4b40bd30345d1ce1be1acf1 floor-canvas-repro-results.json floor-canvas-repro
```

该命令原生导入当前产品文件，原基线已随 root 修复而更新时，不应把新结果标成955e。精确原始 blob 与原观察器另存于 `history/955e-floor-original/` 和 `history/955e-floor-observer-original/`，字节收据为 `floor-canvas-source-history.json`。

原运行结果为 **24条断言，6通过、18失败**，exit1，218.387秒，source_before与source_after均为955e。11个场景各有“实际label/glyph无重叠、在Canvas内”和“真实profile回调员工一致”两个断言，加任务入口、页面错误/外网断言各1条。9个18人场景的两类断言均失败；单人对照与无错误/外网6条通过。

| 场景 | 标签背景重叠对 | 岗位字形重叠对 | 点击观察到的不同员工/尝试员工 |
| --- | ---: | ---: | ---: |
| idle/null/1440 | 153 | 129 | 2/18 |
| idle/null/390 | 153 | 153 | 1/18 |
| idle/shared/1440 | 153 | 67 | 4/18 |
| idle/normal/1440 | 8 | 4 | 17/18 |
| asking/null/1440 | 153 | 111 | 1/18 |
| blocked/shared/1440 | 151 | 90 | 3/18 |
| working/shared/1440 | 153 | 109 | 2/18 |
| queued/shared/1440 | 153 | 109 | 2/18 |
| celebrating/null/1440 | 108 | 41 | 4/18 |

原始 `floor-canvas-before-results.json` 包含全部实际字形/背景坐标、expectedIds、observedIds和错误；便于阅读的摘要是 `floor-canvas-before-summary.json`，JSON/log运行收据为 `floor-canvas-before.json`、`floor-canvas-before.log`。11张原始截图均使用 `floor-canvas-before-*.png`，其中1440 idle/null、390 idle/null与单人working已实际查看，能直接看到聚集与对照。

测量边界：原观察器通过原生 TextMetrics 记录实际字形，按原版两行名牌结构求背景与点击参考点；原 profile 断言比较点击后的最近回调，不单独证明每次新增回调次数。新观察器 `floor-canvas-painted-probe.mjs` 保留相同24个期望，改用实际原生 filled path背景、绘制头部圆心及每次回调增量，适配多行/滚动，不复制产品定位或命中函数。原观察器、18失败收据和截图均不覆盖。TextMetrics依据为 [WHATWG Canvas规范](https://html.spec.whatwg.org/multipage/canvas.html#textmetrics)。

新paint观察器对精确冻结955e三个源blob另跑24期望，得到7通过/17失败，exit1/64.836秒，见 `floor-canvas-painted-before-results.json` 与同名前缀JSON/log/11图。idle/null两宽的背景/字形重叠与2/18、1/18误选不变；9个18人场景布局仍全部失败。每次点击实际恰好新增一个profile回调已由新观察器逐次记录。一个测量差异明确保留：正常循环工位点击实际绘制头部时18/18通过，原观察器的身体参考点为17/18；其8对背景、4对字形重叠仍存在。blocked/celebrating的运动相位与点击参考点影响描述性对数/可选人数，不影响重叠和共享场景误选反例。原6/18与新7/17两份结果不互相覆盖，也不计为两组新的独立用例。

使用新观察器重放原字节的命令为：

```sh
python3 outputs/growth-production-fix-2026-10-02/independent-m6/run_check.py floor-canvas-painted-original-repro node ../../outputs/growth-production-fix-2026-10-02/independent-m6/floor-canvas-painted-probe.mjs 955e2277ee1496cfc4b40bd30345d1ce1be1acf1 floor-canvas-painted-original-repro-results.json floor-canvas-painted-original-repro 955e-frozen
```

`955e-frozen` 只将导入指向保留的精确源blob及其naming依赖，不修改定位、绘制或命中函数；修复后复测使用实际当前源时必须省略该参数。该冻结模式结果中的source_root/baseline_mode/source_hashes明确披露，不冒充当前改动后的组件。

## 收尾报告

- 已完成：原始基线冻结、11场景24断言、实际点击反例、原始截图与JSON/log保留、root OBS16映射。
- 未完成/未覆盖：修复后精确新HEAD的复测在等待修复方；本局部夹具不能证明最终原生冷启动、真实移动设备、全量体验研究。
- 自主追加事项及理由：实际paint背景/头部及回调增量观察器，用于修复后换行/滚动布局的真实回归。
- 采用的假设：合成18人payload用于合法上游状态与工位边界；实际scene、naming与已安装语言依赖直接导入。
- 置信度：原布局与误选反例高；原profile每次恰好一次的增量尚不由旧观察器证明，已单列限制并补观察器。
- 建议复核：idle/null两宽截图、normal工位17/18回调、修复后真实点击回归。

## 自检表

- [是] 覆盖了本局部反例全部11场景，而非挑了容易的部分。
- [是] 没有把可自主完成事项推给用户；修复由既定独立修复方执行。
- [是] 结论与局限对应实际源和运行数据，未把画布夹具当原生/真实手机证据。
- [是] 原始失败可重放且保持字节基线，观察方法的补充单独记录。
