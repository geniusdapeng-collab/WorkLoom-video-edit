import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildVideoSubmissionRequest, type VideoSubmissionImage, type VideoSubmissionRequestOptions } from "./video-submission-request.js";

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const defaults: VideoSubmissionRequestOptions = {
  model: "doubao-seedance-2-5-260628", prompt: "  Original final prompt\n保留正式台词与画幅。  ",
  refs: [], seconds: 13, generateAudio: true, aspect: "9:16", resolution: "1080p",
};
function inline(angle: string, bytes = Buffer.from(`original-${angle}-bytes`)): VideoSubmissionImage {
  return { url: `data:image/png;base64,${bytes.toString("base64")}`, purpose: `original-${angle}`,
    artifact: { path: `portraits/v2/actor-${angle}.png`, sha256: digest(bytes), bytes: bytes.length, mime: "image/png" },
    characterId: "young-rider-01", characterVersion: 2, angle };
}
const build = (patch: Partial<VideoSubmissionRequestOptions> = {}) => buildVideoSubmissionRequest({ ...defaults, ...patch });

describe("video submission request: exclusive actual input modes", () => {
  it("preserves text and legal 2.5 duration; hashes the exact wire body, with no unsupported seed", () => {
    const result = build({ seed: 0, generateAudio: false });
    expect(result.mode).toBe("text");
    expect(result.body).toEqual({ model: defaults.model, content: [{ type: "text", text: defaults.prompt }],
      duration: 13, ratio: "9:16", resolution: "1080p", generate_audio: false, watermark: false, return_last_frame: true });
    expect(result.inputs).toEqual([]);
    expect(result.wireRequestSha256).toBe(digest(JSON.stringify(result.body)));
    expect(result.promptSha256).toBe(digest(defaults.prompt));
    expect(result.inputPlanSha256).toBe(digest(JSON.stringify({ mode: "text", inputs: [] })));
    for (const hash of [result.wireRequestSha256, result.promptSha256, result.inputPlanSha256]) expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("uses one first_frame and omits ratio instead of also submitting reference images", () => {
    const frame = inline("front");
    const result = build({ firstFrame: frame });
    expect(result.mode).toBe("first-frame");
    expect(result.body.content).toEqual([{ type: "text", text: defaults.prompt }, { type: "image_url", image_url: { url: frame.url }, role: "first_frame" }]);
    expect(result.body).not.toHaveProperty("ratio");
    expect(result.body).not.toHaveProperty("omni_reference_task_type");
    expect(result.inputs[0]).toMatchObject({ role: "first_frame", verification: "inline-bytes", characterVersion: 2 });
  });

  it("sends front, closeup and product in the original order, preserving every original byte", () => {
    const bytes = [Buffer.from([0, 255, 1, 2, 7, 128]), Buffer.from([0, 255, 8, 3, 5, 129]), Buffer.from([4, 1, 9, 3])];
    const refs = [inline("front", bytes[0]), inline("closeup", bytes[1]), { ...inline("product", bytes[2]), purpose: "prepared-product" }];
    const result = build({ refs, seed: 28 });
    expect(result.mode).toBe("reference-image");
    expect(result.body).toMatchObject({ ratio: "9:16", omni_reference_task_type: "reference", duration: 13 });
    expect(result.body).not.toHaveProperty("seed");
    const images = (result.body.content as Array<{ role?: string; image_url?: { url: string } }>).slice(1);
    expect(images.map((image) => image.role)).toEqual(["reference_image", "reference_image", "reference_image"]);
    images.forEach((image, index) => {
      const actual = Buffer.from(image.image_url!.url.split(",")[1]!, "base64");
      expect(actual.equals(bytes[index]!)).toBe(true);
      expect(digest(actual)).toBe(result.inputs[index]!.imageSha256);
      expect(actual.length).toBe(result.inputs[index]!.artifact!.bytes);
    });
    expect(result.inputs.map((input) => input.purpose)).toEqual(["original-front", "original-closeup", "prepared-product"]);
    expect(JSON.stringify(result.body)).not.toContain('"first_frame"');
    expect(JSON.stringify(result.body)).not.toContain('"last_frame"');
  });

  it("rejects mixed modes, unsupported lastFrame and duplicate references rather than truncating", () => {
    const front = inline("front");
    expect(() => build({ firstFrame: front, refs: [inline("closeup")] })).toThrow("VIDEO_SUBMISSION_MIXED_MODES");
    expect(() => build({ refs: [front, front] })).toThrow("VIDEO_SUBMISSION_REFERENCE_DUPLICATE");
    const sameBytes = inline("closeup", Buffer.from("original-front-bytes"));
    expect(() => build({ refs: [front, sameBytes] })).toThrow("VIDEO_SUBMISSION_REFERENCE_DUPLICATE");
    expect(() => buildVideoSubmissionRequest({ ...defaults, refs: [front], lastFrame: inline("side") } as VideoSubmissionRequestOptions)).toThrow("VIDEO_SUBMISSION_LAST_FRAME_UNSUPPORTED");
  });

  it.each([{ model: "doubao-seedance-2-5-260628", limit: 30 }, { model: "doubao-seedance-2-0-260128", limit: 9 }])("keeps the complete $model reference budget and rejects overflow", ({ model, limit }) => {
    const refs = Array.from({ length: limit }, (_, index) => ({ url: `asset://reference-${index}`, purpose: `reference-${index}` }));
    const result = build({ model, refs });
    expect(result.inputs).toHaveLength(limit);
    expect((result.body.content as unknown[])).toHaveLength(limit + 1);
    expect(result.inputs.map((input) => input.purpose)).toEqual(refs.map((ref) => ref.purpose));
    expect(() => build({ model, refs: [...refs, { url: "asset://reference-overflow", purpose: "reference-overflow" }] })).toThrow("VIDEO_SUBMISSION_REFERENCE_LIMIT");
  });
});

describe("video submission request: model capabilities are explicit", () => {
  it.each([
    { model: "doubao-seedance-2-5-260628", seconds: [4, 12, 13, 30] },
    { model: "doubao-seedance-2-0-260128", seconds: [4, 15] },
    { model: "doubao-seedance-2-0-fast-260128", seconds: [4, 15] },
    { model: "doubao-seedance-1-0-pro-250528", seconds: [2, 12] },
    { model: "doubao-seedance-1-0-pro-fast-251015", seconds: [2, 12] },
  ])("preserves each legal duration for $model", ({ model, seconds }) => {
    for (const value of seconds) expect(build({ model, seconds: value }).body.duration).toBe(value);
  });

  it.each([
    { model: "doubao-seedance-2-5-260628", invalid: [3, 31, 4.5, NaN, Infinity, -Infinity] },
    { model: "doubao-seedance-2-0-260128", invalid: [3, 16, 4.5, NaN, Infinity] },
    { model: "doubao-seedance-1-0-pro-250528", invalid: [1, 13, 2.5, NaN, Infinity] },
  ])("rejects invalid $model duration without rounding or clamping", ({ model, invalid }) => {
    for (const seconds of invalid) expect(() => build({ model, seconds })).toThrow("VIDEO_SUBMISSION_DURATION_INVALID");
  });

  it.each(["ep-custom-123", "unknown", "doubao-seedance-1-5-pro-251215", "doubao-seedance-2-5-fake", "doubao-seedance-1-0-lite-250528", " doubao-seedance-2-5-260628"])("rejects unknown capability %s", (model) => {
    expect(() => build({ model, seconds: 5 })).toThrow("VIDEO_SUBMISSION_MODEL_UNSUPPORTED");
  });

  it.each([-1, 0, 7, 2147483647])("retains supported legacy seed %s including zero", (seed) => {
    const result = build({ model: "doubao-seedance-1-0-pro-250528", seconds: 5, seed });
    expect(result.body.seed).toBe(seed);
    expect(result.body).not.toHaveProperty("omni_reference_task_type");
  });
  it.each([-2, 1.5, 2147483648, NaN, Infinity])("rejects unsupported legacy seed %s", (seed) => {
    expect(() => build({ model: "doubao-seedance-1-0-pro-fast-251015", seconds: 5, seed })).toThrow("VIDEO_SUBMISSION_SEED_INVALID");
  });
  it.each(["doubao-seedance-2-0-260128", "doubao-seedance-2-5-260628"])("omits even supplied seed on %s", (model) => {
    for (const seed of [-1, 0, 918, NaN]) expect(build({ model, seconds: 5, seed }).body).not.toHaveProperty("seed");
  });
  it("rejects reference mode on legacy but preserves its first-frame mode", () => {
    const model = "doubao-seedance-1-0-pro-250528";
    expect(() => build({ model, seconds: 5, refs: [inline("front")] })).toThrow("VIDEO_SUBMISSION_REFERENCES_UNSUPPORTED");
    expect(build({ model, seconds: 5, firstFrame: inline("front"), seed: 0 }).mode).toBe("first-frame");
  });

  it.each(["--seed 5", "--seed=0", "--frames 120", "--camera_fixed true", "--CF=false"])("rejects unsupported weak prompt parameter %s on 2.x", (parameter) => {
    expect(() => build({ prompt: `Final scene. ${parameter}` })).toThrow("VIDEO_SUBMISSION_PROMPT_PARAMETER_UNSUPPORTED");
  });
  it("does not reject unrelated prompt flags or ordinary words; legacy seed prompt remains compatible", () => {
    const prompt = "Keep the original --ar 9:16 --fps 24; a --seedling label is ordinary text.";
    expect(build({ prompt }).body.content).toEqual([{ type: "text", text: prompt }]);
    expect(build({ model: "doubao-seedance-1-0-pro-250528", seconds: 5, prompt: "A scene --seed 0", seed: 0 }).body.seed).toBe(0);
  });
});

describe("video submission request: current raw bytes and safe evidence", () => {
  it("detects a same-size byte replacement and byte count or MIME mismatch", () => {
    const source = inline("front");
    for (const artifact of [{ ...source.artifact!, sha256: "a".repeat(64) },
      { ...source.artifact!, bytes: source.artifact!.bytes + 1 }, { ...source.artifact!, mime: "image/jpeg" }]) {
      expect(() => build({ refs: [{ ...source, artifact }] })).toThrow("VIDEO_SUBMISSION_ARTIFACT_MISMATCH");
    }
    const replaced = { ...source, url: `data:image/png;base64,${Buffer.alloc(source.artifact!.bytes, 9).toString("base64")}` };
    expect(() => build({ refs: [replaced] })).toThrow("VIDEO_SUBMISSION_ARTIFACT_MISMATCH");
  });

  it("does not apply an unrelated reviewer 4MiB budget to the submitted raw references", () => {
    // Synthetic buffers match the two current original byte counts; no real image or provider is read.
    const frontBytes = Buffer.alloc(5_003_858, 17), closeupBytes = Buffer.alloc(4_868_216, 23);
    const result = build({ refs: [inline("front", frontBytes), inline("closeup", closeupBytes)] });
    const images = (result.body.content as Array<{ image_url?: { url: string } }>).slice(1);
    expect(images.map((image) => Buffer.from(image.image_url!.url.split(",")[1]!, "base64").length)).toEqual([5_003_858, 4_868_216]);
    expect(result.inputs.map((input) => input.imageSha256)).toEqual([digest(frontBytes), digest(closeupBytes)]);
    expect(result.inputs.map((input) => input.imageBytes)).toEqual([5_003_858, 4_868_216]);
  });

  it("redacts inline and signed URLs while only the actual wire hash changes with remote signing", () => {
    const local = inline("front");
    const remote = { url: "https://example.test/original.png?signature=SECRET_SIGNATURE", purpose: "prepared-product",
      artifact: { path: "materials/product.png", sha256: "b".repeat(64), bytes: 921, mime: "image/png" } };
    const first = build({ refs: [local, remote] });
    const second = build({ refs: [local, { ...remote, url: "https://example.test/original.png?signature=NEW_SIGNATURE" }] });
    const evidence = JSON.stringify({ inputs: first.inputs, inputPlanSha256: first.inputPlanSha256 });
    for (const secret of [local.url, remote.url, "data:image", "https://", "SECRET_SIGNATURE", "NEW_SIGNATURE"]) expect(evidence).not.toContain(secret);
    expect(first.inputs[1]).toMatchObject({ verification: "metadata-only", imageSha256: "b".repeat(64) });
    expect(first.inputPlanSha256).toBe(second.inputPlanSha256);
    expect(first.wireRequestSha256).not.toBe(second.wireRequestSha256);
    expect(first.promptSha256).toBe(second.promptSha256);
  });

  it("binds order, identity, angle, purpose and bytes to the input plan without mutating caller metadata", () => {
    const front = inline("front"), closeup = inline("closeup");
    const frozen = JSON.stringify([front, closeup]);
    const first = build({ refs: [front, closeup] });
    expect(JSON.stringify([front, closeup])).toBe(frozen);
    expect(first.inputs[0]!.artifact).not.toBe(front.artifact);
    const variants = [[closeup, front], [{ ...front, characterVersion: 3 }, closeup],
      [{ ...front, purpose: "review-copy" }, closeup], [{ ...front, angle: "side" }, closeup], [inline("front", Buffer.from("changed source")), closeup]];
    for (const refs of variants) expect(build({ refs }).inputPlanSha256).not.toBe(first.inputPlanSha256);
    expect(build({ refs: [front, closeup] })).toEqual(first);
  });

  it("does not serialize unrecognized metadata or pretend an asset ID proves local bytes", () => {
    const image = { url: "asset://real-provider-asset", purpose: "authorized-reference", ignoredUrl: "https://example.test/private" };
    const result = build({ refs: [image] });
    expect(result.inputs).toEqual([{ role: "reference_image", purpose: "authorized-reference", sourceType: "asset-reference", verification: "external-reference" }]);
    expect(() => build({ refs: [{ ...image, artifact: inline("front").artifact }] })).toThrow("VIDEO_SUBMISSION_ARTIFACT_INVALID");
  });

  it.each(["data:image/png;base64,", "data:image/png;base64,YQ=", "data:image/png;base64,Y===", "data:text/plain;base64,YQ==", "data:image/png;base64,Y R=="])("rejects malformed inline data without echoing it: %s", (url) => {
    expect(() => build({ refs: [{ url, purpose: "front" }] })).toThrow("VIDEO_SUBMISSION_IMAGE_DATA_INVALID");
  });
  it.each(["file:///tmp/front.png", "javascript:run()", "asset://invalid/path", "https://user:password@example.test/front.png", " https://example.test/front.png"])("rejects an invalid transport without copying it into an error: %s", (url) => {
    try { build({ refs: [{ url, purpose: "front" }] }); expect.unreachable("invalid source accepted"); }
    catch (error) { expect(String(error)).toContain("VIDEO_SUBMISSION_"); expect(String(error)).not.toContain(url); }
  });

  it("rejects missing or malformed runtime values rather than silently dropping them", () => {
    const cases: unknown[] = [null, { ...defaults, prompt: "  " }, { ...defaults, refs: null }, { ...defaults, refs: new Array(1) }, { ...defaults, firstFrame: null },
      { ...defaults, generateAudio: "true" }, { ...defaults, aspect: "broken" }, { ...defaults, resolution: "2160p" },
      { ...defaults, refs: [{ ...inline("front"), purpose: "https://example.test/leak" }] },
      { ...defaults, refs: [{ ...inline("front"), characterVersion: 0 }] },
      { ...defaults, refs: [{ ...inline("front"), characterId: undefined }] },
      { ...defaults, refs: [{ ...inline("front"), angle: "../front" }] },
      { ...defaults, refs: [{ ...inline("front"), artifact: { ...inline("front").artifact!, path: "data:image/png;base64,secret" } }] },
      { ...defaults, refs: [{ ...inline("front"), artifact: { ...inline("front").artifact!, bytes: NaN } }] },
      { ...defaults, refs: [{ ...inline("front"), artifact: { ...inline("front").artifact!, sha256: { toString: () => "a".repeat(64) } } }] }];
    for (const options of cases) expect(() => buildVideoSubmissionRequest(options as VideoSubmissionRequestOptions)).toThrow("VIDEO_SUBMISSION_");
  });
});
