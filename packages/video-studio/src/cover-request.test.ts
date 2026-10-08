import { describe, expect, it } from "vitest";
import { requestedCoverPlan } from "./cover-design.js";

const input = { title: "原题", durationSeconds: 1.17, archetype: "person-led" as const,
  character: { name: "主角", id: "lead" }, shots: [{ shotId: "old-provider-shot", hasCharacter: false, duration: 30 }] };
const request = { headline: "30 秒看懂：A, B 'C'", heroShotId: "old-provider-shot" };
describe("local requested cover plan", () => {
  it("preserves requested copy despite nominal duration and missing identity labels", () => {
    const frozen = JSON.stringify(input);
    const plan = requestedCoverPlan(input, request);
    expect(plan.headline).toBe(request.headline);
    expect(plan.background.shotId).toBe(request.heroShotId);
    expect(plan.person.enabled).toBe(false);
    expect(plan.source).toBe("requested");
    expect(JSON.stringify(input)).toBe(frozen);
  });
  it("preserves long copy and uses explicit account font and palette without model review", () => {
    const headline = "已经渲染的素材进入正式后期时不再因为画面或声音品质额外拒绝";
    const plan = requestedCoverPlan({ ...input, accountProfile: { account_id: "owner", strict: true,
      visual_hammer: { fontId: "smiley-sans", palette: ["#123456", "#FEDCBA"] } } }, { ...request, headline });
    expect(plan.headline).toBe(headline);
    expect(plan.typography.fontId).toBe("smiley-sans");
    expect(plan.typography.color).toBe("#123456");
    expect(plan.typography.accentColor).toBe("#FEDCBA");
  });
  it("accepts frozen two-line copy and explicit existing inset reference", () => {
    const plan = requestedCoverPlan(input, { ...request, headline: "第一行\n第二行", personShotId: "old-provider-shot", atSec: 0 });
    expect(plan.person).toMatchObject({ enabled: true, shotId: "old-provider-shot", atSec: 0 });
  });
  it.each([{ headline: "" }, { headline: "1\n2\n3" }, { heroShotId: "missing" },
    { personShotId: "missing" }, { atSec: Number.NaN }, { atSec: -1 }])("rejects invalid processing request %j", (patch) => {
    expect(() => requestedCoverPlan(input, { ...request, ...patch })).toThrow();
  });
  it.each([{ fontId: "unknown" }, { palette: ["script"] }])("rejects invalid explicit account render options %j", (visual_hammer) => {
    expect(() => requestedCoverPlan({ ...input, accountProfile: { account_id: "owner", visual_hammer } }, request)).toThrow();
  });
});
