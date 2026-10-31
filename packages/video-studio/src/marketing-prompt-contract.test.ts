import { describe, expect, it } from "vitest";
import {
  buildMarketingPreproductionReport,
  isAbstractMarketingIntent,
  marketingVisibleTextFromG1,
  normalizeMarketingPromptResult,
  normalizeMarketingPromptText,
} from "./marketing-prompt-contract.js";

const options = { targetDuration: 30, noPeople: true };

describe("marketing prompt host contract", () => {
  it("normalizes hardware, people, text conflicts and language policy", () => {
    const source = [
      "01.【语言约束】全部字段必须使用中文输出,禁止出现英文单词、英文短语、英文描述。",
      "06.【场景】一台竖屏显示器立在哑光橡胶垫上，旁边有一把黑色办公椅，机箱风扇持续底噪。",
      "06.【场景补充】开放式公共大厅里有接待台、沙发、茶几和灰色哑光瓷砖，85mm镜头持续推近。",
      "07.【明亮约束】主体面部明亮清晰，阴影保留层次不死黑。",
      "13.【角色】无角色出场。，站立姿态，缓慢走动，张开双臂或自然下垂",
      "25.【负面约束】no text, no watermark, no signage, 禁止画面出现中文汉字与无关字母, no hardware devices。",
      "26.【负面约束】。",
      "18.【台词】[00s-06s] 旁白 日志行滚出画面, softly 说:\"空屏一下。\"",
      "19.【微动作】。",
      "20.【音频】人声对话清晰可辨，低频音床 BPM 60，金属卡槽滑入并锁合。",
      "21.【场景】金属导轨与槽口锁合，模块方块以四枚针脚接触，色温3200K暖白。",
      "22.【景深】焦点锁定在模块方块针脚与卡槽咬合的接触面上，做到可触摸的哑光金属质感。",
      "23.【音频】人声对话清晰可辨，音乐风格为每分钟六十拍，金属咔哒作为落点。",
      "24.【动作】模块方块沿导轨推进约一个槽深，边缘与卡槽内壁贴合，完成两个物理阶段。",
      "28.【微动作】身体语言：身体重心微移",
      "31.【开场音频设计】开头是键盘击键，随后进入每分钟六十拍的音乐。",
      "**定妆照**: 有",
      "30.【副标题内容】官方仓库逐行核对 | 开发者点开许可行亲自验证",
      "33.【微动作】面部细节：眼神专注，嘴唇紧抿；微动作：肩膀紧绷；呼吸：呼吸放缓",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(source, options).value;
    expect(normalized).not.toMatch(/竖屏显示器|橡胶垫|办公椅|机箱风扇/);
    expect(normalized).not.toMatch(/公共大厅|接待台|沙发|茶几|85mm/);
    expect(normalized).not.toMatch(/no text|no watermark|no signage/i);
    expect(normalized).not.toMatch(/站立姿态|嘴唇|肩膀|眼神专注/);
    expect(normalized).toContain("除本次 G1 已审原文");
    expect(normalized).toContain("无人物微动作");
    expect(normalized).toContain("no hardware devices");
    expect(normalized).toContain("18.【台词】无对白");
    expect(normalized).toContain("19.【微动作】无人物微动作");
    expect(normalized).not.toContain("26.【负面约束】。");
    expect(normalized).toContain("20.【音频】无对白、无口播");
    expect(normalized).not.toContain("BPM");
    expect(normalized).not.toContain("卡槽");
    expect(normalized).not.toMatch(/导轨|槽口|槽深|槽底|卡槽|针脚|模块方块|锁合|咬合|贴合|接触面|接触瞬间|物理阶段|3200K|暖白|可触摸的哑光金属/);
    expect(normalized).not.toMatch(/身体语言|身体重心|音乐风格|每分钟六十拍|人声对话清晰可辨/);
    expect(normalized).toContain("31.【开场音频设计】无对白、无口播");
    expect(normalized).toContain("28.【微动作】无人物微动作");
    expect(normalized).toContain("**定妆照**: 无（无角色）");
  });

  it("normalizes every abstract visual field before the producer gate", () => {
    expect(isAbstractMarketingIntent("全片无人，仅使用抽象界面、代码块和示意图，不展示未核实硬件")).toBe(true);
    expect(isAbstractMarketingIntent("无人风景片")).toBe(false);
    const source = [
      "### opening(片头·30字段)",
      "05.【场景】室内明亮空间,白色顶灯均匀照明,浅色墙面挂有装饰画,地面浅灰色地板。",
      "06.【灯光设计】主辅光比约6:1，墙面与顶灯形成真实布光。",
      "15.【动作】逐字带出等宽字符并停住。",
      "；全片无人，不出现人物、人体局部或人物动作",
      "33.【标题动画设计】扫描线带出主标题，铭牌拉丝作为底衬。",
      "### scene-2(内容·25字段)",
      "05.【场景】暗色微距工作台空间，台面排列仪器外壳与哑光工具。",
      "11.【运镜】手持跟移，速度约每秒两厘米。",
      "15.【动作】方片下沉两毫米吸附停稳。",
      "16.【道具】仪器外壳、工具、台面方格定位板。",
      "### scene-3(内容·25字段)",
      "05.【场景】接待区展示角，空间纵深约三米，有轻微机房冷气感。",
      "11.【景深】拉丝不锈钢铭牌带两厘米刻线倒角。",
      "### scene-4(内容·25字段)",
      "06.【灯光设计】辅光约2800K，主辅光比约12:1，方片厚度约两厘米。",
      "20.【时间轴】T00:00–T00:01.5 起幅；T00:03–T00:05 暗场收束。",
      "### ending(内容·25字段)",
      "05.【场景】拉丝不锈钢铭牌，字符边缘留有细窄倒角。",
    ].join("\n");
    const result = normalizeMarketingPromptText(source, { ...options, abstractOnly: true });
    expect(result.changes).toContain("abstract-field-contract-normalized");
    expect(result.value).not.toMatch(/室内明亮空间|白色顶灯|浅色墙面|装饰画|暗色微距工作台空间|仪器外壳|哑光工具|台面实体模型|方片下沉两毫米|接待区展示角|空间纵深约三米|机房冷气感|拉丝不锈钢铭牌|两厘米刻线倒角|辅光约2800K|主辅光比约12:1|方片厚度约两厘米/iu);
    expect(result.value).not.toMatch(/^；全片无人/mu);
    expect(result.value).toContain("T00:03–T00:05");
    const fieldNumbers = [...result.value.matchAll(/^(\d{2})\.【/gmu)].map(match => Number(match[1]));
    expect(fieldNumbers).toEqual([1, 2, 3, 4, 1, 2, 3, 4, 1, 2, 1, 2, 1]);
  });

  it("applies the abstract visual contract to production result fields", () => {
    const result = normalizeMarketingPromptResult({
      stages: {
        productionEngine: {
          shots: [{
            scene: "暗室中的工作中台，台面有工具与仪器外壳。",
            action: "方片下沉两毫米后吸附。",
            props: "不锈钢铭牌与反光板。",
            lighting: "主辅光比约12:1，色温2800K。",
            timeline: "T00:00–T00:01 起幅；T00:03–T00:05 收束。",
            promptBase: "实拍台面和仪器外壳。",
            fusionText: "接待区空间纵深约三米。",
          }],
        },
      },
    }, { ...options, abstractOnly: true }).value as any;
    const shot = result.stages.productionEngine.shots[0];
    expect(JSON.stringify(shot)).not.toMatch(/工作中台|仪器外壳|不锈钢铭牌|反光板|主辅光比约12:1|色温2800K|空间纵深约三米/iu);
    expect(shot.timeline).toContain("T00:03–T00:05");
    expect(shot.scene).toContain("二维抽象画布");
  });

  it("removes real-camera, studio, material and incomplete abstract field claims", () => {
    const source = [
      "### scene-1(内容·25字段)",
      "04.【约束】9:16画幅，高质量分辨率，24fps，MP4格式。",
      "02.【导演意图】用真实材质、真实光源拍摄哑光板面，只允许真实物理变化。",
      "03.【技能增强】本镜技法参考抽象视觉规则：、，按该导演该情绪执行；",
      "08.【运镜】固定机位，焦距100mm微距等效，机身锁死在三脚架 09.",
      "09.【景深】大光圈浅景深，网格随距焦平面渐远，空间仍有纵深。",
      "18.【时间轴】近黑工作室与哑光面板显现，随后文本条滑入。",
      "### ending(内容·25字段)",
      "11.【运镜】只执行一次由虚到实的焦点 12.",
      "15.【动作】只有两个物理过程，并让灰尘颗粒从光边外侧飘过。",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(source, { ...options, abstractOnly: true, frameRate: 30 }).value;
    expect(normalized).not.toMatch(/真实材质|真实光源|哑光板面|真实物理变化|技法参考抽象视觉规则：、|该导演|100mm|三脚架|大光圈|浅景深|焦平面|空间仍有纵深|近黑工作室|灰尘颗粒/iu);
    expect(normalized).not.toMatch(/只执行一次由虚到实的焦点\s+12\./u);
    expect(normalized).toContain("30fps");
    expect(normalized).not.toContain("24fps");
    expect(normalized).toContain("【技能增强】本镜技法只使用本次已审抽象视觉规则");
    expect(normalized).toContain("【运镜】固定机位或受控二维图层位移");
    expect(normalized).toContain("【景深】二维图层保持清晰");
  });

  it("derives exact visible names and claims from the accepted G1 facts", () => {
    const g1 = JSON.stringify({
      facts: {
        sources: [{ finalUrl: "https://github.com/home-assistant/core" }],
        productQuery: {
          identity: {
            name: "Home Assistant",
            brand: "Home Assistant",
            official_selling_points: [
              { point: "Open source home automation that puts local control and privacy first." },
              { point: "Powered by a worldwide community of tinkerers and DIY enthusiasts." },
            ],
            specs: { License: "Apache-2.0" },
          },
        },
        rawByAgent: {
          A1: {
            identity: {
              official_selling_points: [
                { point: "Open source home automation that puts local control and privacy first." },
                { point: "Powered by a worldwide community of tinkerers and DIY enthusiasts." },
              ],
            },
          },
        },
      },
    });
    expect(marketingVisibleTextFromG1(g1)).toEqual([
      "Home Assistant",
      "Open source home automation that puts local control and privacy first.",
      "Powered by a worldwide community of tinkerers and DIY enthusiasts.",
      "Apache-2.0",
      "License: Apache-2.0",
      "https://github.com/home-assistant/core",
    ]);
  });

  it("builds a complete G7 report without truncation or portrait approval", () => {
    const report = buildMarketingPreproductionReport({
      productionResult: {
        shots: [
          { shotId: "opening", duration: 4, sceneType: "opening", scene: "{\"scene_id\":\"opening\",\"scene_n" },
          { shotId: "scene-1", duration: 5, sceneType: "establishing", scene: "截断场景..." },
        ],
        prompts: [{ shotId: "opening" }, { shotId: "scene-1" }],
      },
      scriptResult: { blueprint: { characters: [] } },
      timing: { effective: 120000 },
      confirmations: { dataMining: { approved: true }, portraitGeneration: { approved: true, skipped: true } },
      options: {
        ...options,
        abstractOnly: true,
        frameRate: 30,
        allowedVisibleText: ["Home Assistant", "Open-source local automation controls your home."],
      },
    });
    expect(report).toContain("**镜头总数**: 2");
    expect(report).toContain("**总时长**: 9 秒");
    expect(report).toContain("**角色数**: 0");
    expect(report).toContain("**提示词数**: 2");
    expect(report).toContain("- portraitGeneration: 不适用（cast.mode=none）");
    expect(report).toContain("台词速率/占比：不适用（本片无对白）");
    expect(report).toContain("Home Assistant");
    expect(report).toContain("### opening");
    expect(report).toContain("| opening | 4s | 30 |");
    expect(report).not.toContain("scene_id");
    expect(report).not.toContain("请回复");
    expect(report).not.toContain("截断场景");
  });

  it("rebalances shot durations to the exact target and caps stale timecodes", () => {
    const result = normalizeMarketingPromptResult({
      stages: {
        productionEngine: {
          shots: [
            { shotId: "opening", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "scene-1", duration: 6, timeline: "T00:00–T00:06" },
            { shotId: "scene-2", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "scene-3", duration: 5, timeline: "T00:00–T00:05" },
            { shotId: "scene-4", duration: 4, timeline: "T00:00–T00:04" },
            { shotId: "ending", duration: 3, timeline: "T00:00–T00:07", dialogue: "旁白说原文" },
          ],
        },
      },
    }, options).value as any;
    const shots = result.stages.productionEngine.shots;
    expect(shots.map((shot: any) => shot.duration)).toEqual([5, 7, 5, 6, 4, 3]);
    expect(shots.reduce((sum: number, shot: any) => sum + shot.duration, 0)).toBe(30);
    expect(shots[5].timeline).toContain("T00:03");
    expect(shots[5].timeline).not.toContain("T00:07");
    expect(shots[5].dialogue).toContain("无对白");
  });

  it("rewrites the review table to the same conserved durations", () => {
    const report = [
      "## 镜头总览",
      "| 镜头 | 时长 |",
      "| opening | 4s |",
      "| scene-1 | 6s |",
      "| scene-2 | 4s |",
      "| scene-3 | 5s |",
      "| scene-4 | 4s |",
      "| ending | 3s |",
      "## 完整提示词",
      "### opening(片头)",
      "T00:00–T00:04",
      "### scene-1(内容)",
      "T00:00–T00:06",
      "### scene-2(内容)",
      "T00:00–T00:04",
      "### scene-3(内容)",
      "T00:00–T00:05",
      "### scene-4(内容)",
      "T00:00–T00:04",
      "### ending(内容)",
      "T00:00–T00:07",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(report, options).value;
    expect(normalized).toContain("| opening | 5s |");
    expect(normalized).toContain("| scene-1 | 7s |");
    expect(normalized).toContain("### ending(内容)\nT00:00–T00:03");
    expect(normalized).toContain("5s + 7s + 5s + 6s + 4s + 3s = 30s");
  });

  it("conserves decimal durations across any shot count and marks portrait inapplicable", () => {
    const report = [
      "| 镜头 | 时长 | 字符数 | 字段数 | 技能命中 | 有定妆照 | 有时间轴 | 有约束 |",
      "|---|---|---|---|---|---|---|---|",
      "| opening | 4.5s | 1200 | 30 | — | ✓ | ✓ | ✓ |",
      "| scene-1 | 5.5s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| scene-2 | 15s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| scene-3 | 9s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
      "| ending | 6s | 1200 | 25 | — | ✓ | ✓ | ✓ |",
    ].join("\n");
    const normalized = normalizeMarketingPromptText(report, options).value;
    expect(normalized).toContain("| opening | 3s |");
    expect(normalized).toContain("| scene-2 | 11s |");
    expect(normalized).toContain("3s + 4s + 11s + 7s + 5s = 30s");
    expect(normalized).toContain("| — | ✓ | ✓ |");
  });
});
