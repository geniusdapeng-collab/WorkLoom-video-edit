import { describe, expect, it } from "vitest";
import { extractTopicCandidates, inferEditIntent, type IntentAnalysisDoc } from "./intent.js";

function doc(overrides: Partial<IntentAnalysisDoc> = {}): IntentAnalysisDoc {
  return {
    asset: { filename: "trip.mp4", durationSeconds: 120, width: 1080, height: 1920, aspectRatio: "1080:1920" },
    contentDomain: "旅行 Vlog",
    probe: {
      speech: { sentences: [{ text: "今天带你去一个地方", start: 0, end: 2 }] },
      shotBoundaries: [{ index: 0, inTimecode: "00:00:00.000", outTimecode: "00:00:05.000", durationSeconds: 5 }],
      onScreenText: [{ t: 1.5, texts: ["古城夜市"] }],
    },
    shots: [
      {
        shotId: "shot-001",
        inTimecode: "00:00:00.000",
        outTimecode: "00:00:05.000",
        sceneType: "on_location",
        content: { keyEntities: ["古城夜市", "烤串"], coreMessage: "古城夜市必吃 3 家" },
        emotion: { dominant: "兴奋", intensity: 0.8, valence: 0.6 },
      },
      {
        shotId: "shot-002",
        inTimecode: "00:00:05.000",
        outTimecode: "00:00:12.000",
        sceneType: "on_location",
        content: { keyEntities: ["古城夜市"], onScreenText: "20年老店" },
        emotion: { dominant: "温暖", intensity: 0.5, valence: 0.4 },
      },
    ],
    ...overrides,
  };
}

describe("edit/intent：创作意图推断", () => {
  it("竖屏素材：领域命中走同画幅平台（旅行→小红书）；未命中领域则默认抖音", () => {
    const intent = inferEditIntent({ analyses: [doc()] });
    expect(intent.platform).toBe("小红书");
    expect(intent.durationBand.minSeconds).toBe(30);
    expect(intent.durationBand.maxSeconds).toBe(60);
    expect(intent.pacingProfile).toBe("vlog");
    expect(intent.topicCandidates[0]!.title).toBe("古城夜市");
    expect(intent.topicCandidates[0]!.evidence.length).toBeGreaterThan(0);
    expect(intent.emotionGoals).toContain("兴奋");
    expect(intent.basis.platform).toContain("竖屏");
    const generic = inferEditIntent({ analyses: [doc({ contentDomain: null, asset: { filename: "clip.mp4", durationSeconds: 120, width: 1080, height: 1920, aspectRatio: "1080:1920" } })] });
    expect(generic.platform).toBe("抖音");
  });

  it("横屏长素材 → B站；素材不足时时长带向可用素材收敛，不硬凑长片", () => {
    const long = inferEditIntent({ analyses: [doc({ asset: { filename: "vlog.mp4", durationSeconds: 600, width: 1920, height: 1080, aspectRatio: "1920:1080" } })] });
    expect(long.platform).toBe("B站");
    expect(long.durationBand.maxSeconds).toBe(300);
    const short = inferEditIntent({ analyses: [doc({ asset: { filename: "vlog.mp4", durationSeconds: 60, width: 1920, height: 1080, aspectRatio: "1920:1080" } })] });
    /** 旅行领域在横屏同样只能选横屏平台（小红书不在横屏白名单）→ 回落 60s 横屏默认（视频号）。 */
    expect(short.platform).toBe("微信视频号");
    expect(short.durationBand.maxSeconds).toBeLessThanOrEqual(36);
    expect(short.basis.duration).toContain("可用素材");
  });

  it("显式覆盖优先：平台/时长指定时 basis=explicit；单条高语音素材判为口播节奏", () => {
    const explicit = inferEditIntent({ analyses: [doc()], platformHint: "B站", durationHintSeconds: 180 });
    expect(explicit.platform).toBe("B站");
    expect(explicit.durationBand.minSeconds).toBe(162);
    expect(explicit.durationBand.maxSeconds).toBe(198);
    expect(explicit.basis.platform).toContain("explicit");
    const talk = inferEditIntent({
      analyses: [doc({
        probe: { speech: { sentences: [{ text: "大家好", start: 0, end: 60 }] } },
        asset: { filename: "talk.mp4", durationSeconds: 100, width: 1080, height: 1920, aspectRatio: "1080:1920" },
      })],
    });
    expect(talk.pacingProfile).toBe("talk");
  });

  it("选题候选可复算：频次×权重 + 数字锚点加成，且不编造池外内容", () => {
    const topics = extractTopicCandidates([
      doc(),
      doc({
        shots: [{ shotId: "shot-003", content: { keyEntities: ["古城夜市", "3家老店"], onScreenText: "古城夜市/夜宵" } }],
      }),
    ]);
    expect(topics[0]!.title).toBe("古城夜市");
    expect(topics[0]!.score).toBeGreaterThan(topics[1]!.score);
    const empty = extractTopicCandidates([{ asset: { filename: "x.mp4" } }]);
    expect(empty).toEqual([]);
  });
});
