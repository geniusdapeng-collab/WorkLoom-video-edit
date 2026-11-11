import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { CreativeThemeGenerator } = require("../vendor/supermickey/hyperreality-system/skills/creative-theme-generator/index.js");

test("explicit no-director contract removes invented film and director references", async () => {
  const output = {
    type: "商业广告",
    theme: "冠军时刻",
    description: "成年虚构人物在燃油赛道比赛中完成连续超越，冲线摘盔并登台。",
    duration_sec: 30,
    tone: "高燃紧张",
    visual_style: "以 Ron Howard 受控影像语法为骨，Joseph Kosinski 式低机位追车为皮，参考《极速车王》的硬光，冷沥青与高反差。",
    dialogue_requirement: "无台词。",
    special_notes: "全片持续显示赛道专用安全提示。",
    target_audience: "成年机车内容受众",
    creative_style: 0.6,
    difficulty: "中"
  };
  const generator = new CreativeThemeGenerator({
    llmEngine: {
      reason: async () => ({ success: true, content: JSON.stringify(output), data: output })
    }
  });
  const result = await generator.generate(
    "制作一条30秒商业广告。不得新增客户未提供的导演、影片或作品名。全程高燃，燃油驱动赛道摩托车在封闭赛道比赛，不是电动车。全片持续烧录“创意演绎 · 赛道专用不可上路”。参考图 license_risk=high，仅作内部生成锚定。本片使用 w2 全覆保护赛车服。超车统一采用外线出弯。领奖台用健康、自信、非裸露的中景展示胸腰臀轮廓。"
  );
  const style = result.tasks[0].visual_style;
  assert.doesNotMatch(style, /Ron Howard|Joseph Kosinski|《极速车王》/u);
  assert.match(style, /低机位追车|冷沥青|高反差/u);
  assert.match(result.tasks[0].special_notes, /赛道专用不可上路/u);
  assert.match(result.tasks[0].special_notes, /燃油驱动赛道摩托车/u);
  assert.match(result.tasks[0].special_notes, /license_risk=high/u);
  assert.match(result.tasks[0].special_notes, /w2 全覆保护赛车服/u);
  assert.match(result.tasks[0].special_notes, /外线出弯/u);
  assert.match(result.tasks[0].special_notes, /胸腰臀轮廓/u);
});
