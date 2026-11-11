import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const { RuleChecker, IssueType } = require(
  "../vendor/supermickey/hyperreality-system/engines/field-quality/field-check-agent.js",
);

test("accepts canonical bound portrait references without rewriting them", () => {
  const portraits = [
    "image://characters/young-rider-01/portraits/v2/young-rider-01-front.png",
    "image://characters/young-rider-01/portraits/v2/young-rider-01-closeup.png",
  ].join("；");
  const issues = new RuleChecker().check({
    director_instruction: "商业广告写实摄影，冷峻紧张的情绪基调。",
    constraint: "9:16画幅，1080x1920分辨率，30fps，MP4格式。",
    baseline: "电影级写实质感。",
    scene: "封闭赛道弯道，冷灰沥青。",
    lighting: "冷白顶光硬光。",
    camera_movement: "固定机位，速度稳定。",
    character: "李英子，成年女性。",
    action: "她压低身体完成外线出弯。",
    portraits,
    dialogue: "无台词。",
    negative: "no text, no watermark",
    consistency: "同一人物、同一赛车服。",
    composition: "中景，构图对称。",
    color_palette: "冷灰色调。",
    depth_of_field: "中景清晰，背景虚化。",
    timeline: "T00:00-T00:04，动作连续。",
    mood: "紧张。",
    bright_constraint: "面部明亮，阴影有层次。",
    character_constraint: "只出现李英子一人，禁止分身或克隆。",
    costume: "全覆保护赛车服与全盔。",
    props: "赛车与全盔。",
    pacing: "开头压住，中间推进，结尾收束。",
    audio: "只保留现场机械声。",
    makeup: "自然皮肤纹理。",
    transition: "硬切。",
  });
  assert.equal(
    issues.some(issue => issue.fieldEn === "portraits" && issue.issueType === IssueType.FORMAT_ERROR),
    false,
  );
});

test("accepts canonical angle aliases before host byte resolution", () => {
  const portraits = [
    "image://characters/young-rider-01/portrait-v2-front.png",
    "image://characters/young-rider-01/portraits/v2/front",
    "image://characters/young-rider-01/young-rider-01-closeup.png",
  ].join(";");
  const base = {
    director_instruction: "商业广告写实摄影，冷峻紧张的情绪基调。",
    constraint: "9:16画幅，1080x1920分辨率，30fps，MP4格式。",
    baseline: "电影级写实质感。",
    scene: "封闭赛道弯道，冷灰沥青。",
    lighting: "冷白顶光硬光。",
    camera_movement: "固定机位，速度稳定。",
    character: "李英子，成年女性。",
    action: "她压低身体完成外线出弯。",
    portraits,
    dialogue: "无台词。",
    negative: "no text, no watermark",
    consistency: "同一人物、同一赛车服。",
    composition: "中景，构图对称。",
    color_palette: "冷灰色调。",
    depth_of_field: "中景清晰，背景虚化。",
    timeline: "T00:00-T00:04，动作连续。",
    mood: "紧张。",
    bright_constraint: "面部明亮，阴影有层次。",
    character_constraint: "只出现李英子一人，禁止分身或克隆。",
    costume: "全覆保护赛车服与全盔。",
    props: "赛车与全盔。",
    pacing: "开头压住，中间推进，结尾收束。",
    audio: "只保留现场机械声。",
    makeup: "自然皮肤纹理。",
    transition: "硬切。",
  };
  const issues = new RuleChecker().check(base);
  assert.equal(
    issues.some(issue => issue.fieldEn === "portraits" && issue.issueType === IssueType.FORMAT_ERROR),
    false,
  );
});
