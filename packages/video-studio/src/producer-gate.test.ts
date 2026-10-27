import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { PRODUCER_RUBRICS, buildProducerReviewContract, resolveProducerLlm, reviewStage, type ProducerGateOptions } from "./producer-gate.js";
const env = { LLM_BASE_URL: "https://api.example.com", LLM_API_KEY: "k", LLM_MODEL: "judge-1" };
const dirs: string[] = [];
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=", "base64");
function file(name: string, bytes: string | Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "quality-test-")); dirs.push(dir);
  const path = join(dir, name); writeFileSync(path, bytes); return path;
}
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
const good = { approved: true, score: 85, issues: [], suggestions: [], reason: "ok" };
function judge(answer: unknown = good, bodies: string[] = []): typeof fetch {
  return (async (_url, init) => {
    bodies.push(String(init?.body));
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
  }) as typeof fetch;
}
function textOptions(extra: Partial<ProducerGateOptions> = {}): ProducerGateOptions {
  return { stage: "prompt", projectId: "VID-中文", artifacts: [{ path: file("prompt.txt", "剧本与镜头约束"), kind: "text" }], deterministic: [], env, fetchImpl: judge(), ...extra };
}
describe("AI producer evidence gate", () => {
  it("every supported stage has review criteria", () => {
    for (const rubric of Object.values(PRODUCER_RUBRICS)) expect(rubric.every((x) => x.length > 4)).toBe(true);
  });
  it("hard failures cannot be overturned by model", async () => {
    const bodies: string[] = [];
    const verdict = await reviewStage(textOptions({ deterministic: [{ id: "duration", pass: false, hard: true, detail: "bad" }], fetchImpl: judge(good, bodies) }));
    expect(verdict.status).toBe("failed"); expect(verdict.approved).toBe(false); expect(bodies).toHaveLength(0);
  });
  it("required unknown and missing checks cannot pass", async () => {
    expect((await reviewStage(textOptions({ requiredCheckIds: ["source"] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ deterministic: [{ id: "source", pass: true, hard: true, status: "unverified", detail: "no receipt" }] }))).approved).toBe(false);
  });
  it("soft failure is reported alongside actual model review", async () => {
    const verdict = await reviewStage(textOptions({ deterministic: [{ id: "style", pass: false, detail: "different" }] }));
    expect(verdict.status).toBe("passed"); expect(verdict.issues[0]).toContain("style");
  });
  it("missing model stays unverified even if fallback flag is true", async () => {
    for (const allowFallbackApprove of [false, true]) {
      const v = await reviewStage(textOptions({ env: {}, allowFallbackApprove }));
      expect(v.approved).toBe(false); expect(v.status).toBe("unverified"); expect(v.degraded).toBe(true);
    }
  });
  it("HTTP failure stays unverified", async () => {
    const v = await reviewStage(textOptions({ fetchImpl: (async () => new Response("failure", { status: 500 })) as typeof fetch }));
    expect(v.approved).toBe(false); expect(v.reason).toContain("HTTP 500");
  });
  it("empty, missing and corrupt evidence blocks before calling model", async () => {
    const paths = ["/does-not-exist/quality.png", file("empty.png", ""), file("fake.png", "this is text")];
    for (const path of paths) {
      const bodies: string[] = [];
      const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: [{ path, kind: "image" }], fetchImpl: judge(good, bodies) }));
      expect(v.status).toBe("unverified"); expect(bodies).toHaveLength(0);
    }
    expect((await reviewStage(textOptions({ artifacts: [] }))).approved).toBe(false);
  });
  it("missing reference cannot be silently skipped", async () => {
    const v = await reviewStage(textOptions({ referenceImages: ["/missing-reference.png"] }));
    expect(v.status).toBe("unverified");
  });
  it("image-only stages cannot approve on text evidence", async () => {
    expect((await reviewStage(textOptions({ stage: "shot" }))).approved).toBe(false);
  });
  it("full text including violations after the old prefix limit reaches judge", async () => {
    const path = file("long.txt", "正常描述".repeat(4000) + "末尾约束冲突");
    const bodies: string[] = [];
    const v = await reviewStage(textOptions({ artifacts: [{ path, kind: "text" }], fetchImpl: judge(good, bodies) }));
    expect(v.approved).toBe(true); expect(bodies[0]).toContain("末尾约束冲突");
    expect(v.evidence?.[0]?.sha256).toBe(createHash("sha256").update(readFileSync(path)).digest("hex"));
    expect(v.evidence?.[0]?.scope).toBe("complete-text");
  });
  it("oversize full text or context cannot be truncated into a pass", async () => {
    expect((await reviewStage(textOptions({ artifacts: [{ path: file("large.txt", "a".repeat(100001)), kind: "text" }] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ context: { large: "a".repeat(30001) } }))).status).toBe("unverified");
  });
  it("all seven images are reviewed in batches and a later reject wins", async () => {
    const images = Array.from({ length: 7 }, (_, i) => ({ path: file(`image-${i}.png`, png), kind: "image" as const }));
    const bodies: string[] = [];
    const fetchImpl = (async (_url, init) => { bodies.push(String(init?.body)); return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(bodies.length === 1 ? good : { ...good, approved: false, reason: "last image bad" }) } }] })); }) as typeof fetch;
    const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: images, fetchImpl }));
    expect(bodies).toHaveLength(2); expect(bodies.reduce((n, b) => n + (b.match(/image_url/g)?.length ?? 0), 0)).toBe(14);
    expect(v.approved).toBe(false); expect(v.reason).toContain("last image bad"); expect(v.evidence).toHaveLength(7);
  });
  it("oversize images must compress successfully without losing evidence", async () => {
    const big = file("big.png", Buffer.concat([png, Buffer.alloc(1_000_000)]));
    const small = file("small.png", png); const bodies: string[] = [];
    const v = await reviewStage(textOptions({ stage: "keyframe", artifacts: [{ path: big, kind: "image" }], shrinkImage: () => small, fetchImpl: judge(good, bodies) }));
    expect(v.approved).toBe(true); expect(bodies[0]!.length).toBeLessThan(50_000);
    expect((await reviewStage(textOptions({ artifacts: [{ path: big, kind: "image" }], shrinkImage: () => null }))).status).toBe("unverified");
  });
  it.each([{ ...good, score: 1 }, { ...good, approved: false }])("low score or reject cannot pass %j", async (answer) => {
    const v = await reviewStage(textOptions({ fetchImpl: judge(answer) })); expect(v.status).toBe("failed"); expect(v.approved).toBe(false);
  });
  /**
   * 2026-09-28 T1 真机：模型返回合法 JSON 但形状有偏差（score 字符串、issues 单条字符串、
   * 用 summary 代 reason、approved 写成 "true"）时，旧实现直接判"结构非法"要求整环节重跑——
   * 10 镜里 2 镜因此失败。无歧义偏差按语义归一，不改事实。
   */
  it.each([{ ...good, approved: "true" }, { ...good, issues: "bad" }, { ...good, score: "88" }, { approved: true, score: 85, summary: "ok" }])(
    "unambiguous shape deviations are normalized %j", async (answer) => {
      const v = await reviewStage(textOptions({ fetchImpl: judge(answer) }));
      expect(v.approved).toBe(true); expect(v.status).toBe("passed");
    }
  );
  it("wrong-shaped review is repaired into the schema instead of failing the stage", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      const content = calls === 1 ? JSON.stringify({ ...good, suggestions: [false] }) : JSON.stringify(good);
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
    }) as typeof fetch;
    const v = await reviewStage(textOptions({ fetchImpl }));
    expect(calls).toBe(2);
    expect(v.approved).toBe(true);
  });
  it.each([{ ...good, score: 101 }, { ...good, score: null }, { ...good, suggestions: [false] }, [], null])("invalid response is unverified %j", async (answer) => {
    const v = await reviewStage(textOptions({ fetchImpl: judge(answer) })); expect(v.status).toBe("unverified"); expect(v.approved).toBe(false);
  });
  it("unsupported audio and missing acoustic review cannot be called passed", async () => {
    expect((await reviewStage(textOptions({ artifacts: [{ path: file("audio.wav", "data"), kind: "audio" }] }))).status).toBe("unverified");
    expect((await reviewStage(textOptions({ stage: "bgm" }))).reason).toContain("audio-review");
  });
  const hasFfmpeg = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-version"]).status === 0;
  it.skipIf(!hasFfmpeg)("actual video is probed and sampled at five timestamps", async () => {
    const path = file("video.mp4", "");
    const build = spawnSync(process.env.WL_FFMPEG ?? "ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=160x120:rate=10", "-t", "1", "-c:v", "libx264", "-pix_fmt", "yuv420p", path]);
    expect(build.status).toBe(0);
    const bodies: string[] = [];
    const v = await reviewStage(textOptions({ stage: "shot", artifacts: [{ path, kind: "video" }], fetchImpl: judge(good, bodies) }));
    expect(v.approved, v.reason).toBe(true); expect(v.evidence?.[0]?.scope).toContain("temporal-sample");
    expect(bodies[0]).toContain("0.800s"); expect(bodies[0]?.match(/image_url/g)).toHaveLength(10);
  });
  it("credentials need all three fields", () => {
    expect(resolveProducerLlm({})).toBeNull(); expect(resolveProducerLlm({ LLM_BASE_URL: "x", LLM_API_KEY: "y" })).toBeNull();
    expect(resolveProducerLlm({ DEEPSEEK_BASE_URL: "https://api.example.com", DEEPSEEK_API_KEY: "k", DEEPSEEK_MODEL: "test" })?.model).toBe("test");
  });
});

describe("producer binds the expected artifact bytes before review", () => {
  const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
  const artifactFixtures = [
    { kind: "text" as const, name: "G3_INSIGHT.md", bytes: "当前需求正文：只使用已核实的事实，末尾约束不得省略。" },
    { kind: "json" as const, name: "G1_DOSSIER.json", bytes: JSON.stringify({ facts: { model: "820RR-RC", value: "当前事实，来源明确" } }) },
    { kind: "image" as const, name: "current-frame.png", bytes: png },
  ];

  it.each(artifactFixtures)("rejects a mismatched $kind artifact before any model call", async ({ kind, name, bytes }) => {
    const path = file(name, bytes); const bodies: string[] = [];
    const result = await reviewStage(textOptions({
      stage: kind === "image" ? "keyframe" : "prompt",
      artifacts: [{ path, kind, expectedSha256: "0".repeat(64) }], fetchImpl: judge(good, bodies),
    }));
    expect(result).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(bodies).toHaveLength(0);
  });

  it.each(["", "a".repeat(63), "a".repeat(65), "g".repeat(64), ` ${"a".repeat(64)}`, `${"a".repeat(64)}\n`])(
    "rejects an invalid expected SHA256 %j before any model call", async expectedSha256 => {
      const bodies: string[] = [];
      const result = await reviewStage(textOptions({
        artifacts: [{ path: file("bound.txt", "本次正文"), kind: "text", expectedSha256 }], fetchImpl: judge(good, bodies),
      }));
      expect(result).toMatchObject({ approved: false, status: "unverified", degraded: true });
      expect(bodies).toHaveLength(0);
    },
  );

  it.each(artifactFixtures)("accepts the exact UTF-8 or binary hash and records $kind evidence", async ({ kind, name, bytes }) => {
    const path = file(name, bytes); const bodies: string[] = []; const expectedSha256 = sha256(bytes);
    const result = await reviewStage(textOptions({
      stage: kind === "image" ? "keyframe" : "prompt",
      artifacts: [{ path, kind, expectedSha256 }], fetchImpl: judge(good, bodies),
    }));
    expect(result).toMatchObject({ approved: true, status: "passed", degraded: false });
    expect(bodies).toHaveLength(1);
    expect(result.evidence).toEqual([{ path, sha256: expectedSha256, scope: kind === "image" ? "image" : "complete-text" }]);
    const content = JSON.parse(bodies[0]!).messages[0].content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
    if (kind === "image") expect(content.find(item => item.type === "image_url")?.image_url?.url).toBe(`data:image/png;base64,${png.toString("base64")}`);
    else expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${path}\n${bytes}` });
  });

  it("never calls the model when a later artifact differs from its expected hash", async () => {
    const accepted = "已核实G1事实"; const current = "本次G3确认单"; const bodies: string[] = [];
    const result = await reviewStage(textOptions({ artifacts: [
      { path: file("G1_DOSSIER.md", accepted), kind: "text", expectedSha256: sha256(accepted) },
      { path: file("G3_INSIGHT.md", current), kind: "text", expectedSha256: sha256("另一个attempt的确认单") },
    ], fetchImpl: judge(good, bodies) }));
    expect(result.approved).toBe(false); expect(result.status).toBe("unverified"); expect(bodies).toHaveLength(0);
  });

  it.each(artifactFixtures)("rejects $kind tampering during a successful model review", async ({ kind, name, bytes }) => {
    const path = file(name, bytes); const expectedSha256 = sha256(bytes); const bodies: string[] = [];
    const fetchImpl = (async (_url, init) => {
      bodies.push(String(init?.body));
      writeFileSync(path, kind === "image" ? Buffer.concat([png, Buffer.from("changed")]) : "评审期间被替换的正文");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }));
    }) as typeof fetch;
    const result = await reviewStage(textOptions({
      stage: kind === "image" ? "keyframe" : "prompt", artifacts: [{ path, kind, expectedSha256 }], fetchImpl,
    }));
    expect(result).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(result.reason).toContain("评审期间产物发生变化"); expect(bodies).toHaveLength(1);
    expect(result.evidence).toContainEqual({ path, sha256: expectedSha256, scope: kind === "image" ? "image" : "complete-text" });
  });

  it.each([100_000, 100_001])("accounts for every text artifact in the %i-character full-text budget", async total => {
    const accepted = "G1全文起点" + "a".repeat(60_000 - "G1全文起点".length - "G1全文尾部".length) + "G1全文尾部";
    const current = "当前门全文起点" + "b".repeat(total - accepted.length - "当前门全文起点".length - "当前门全文尾部".length) + "当前门全文尾部";
    expect(accepted.length + current.length).toBe(total);
    const acceptedPath = file("G1_DOSSIER.md", accepted); const currentPath = file("G3_INSIGHT.md", current); const bodies: string[] = [];
    const artifacts = [
      { path: acceptedPath, kind: "text" as const, expectedSha256: sha256(accepted) },
      { path: currentPath, kind: "text" as const, expectedSha256: sha256(current) },
    ];
    const result = await reviewStage(textOptions({ artifacts, fetchImpl: judge(good, bodies) }));
    if (total === 100_000) {
      expect(result.approved, result.reason).toBe(true); expect(bodies).toHaveLength(1);
      const content = JSON.parse(bodies[0]!).messages[0].content;
      expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${acceptedPath}\n${accepted}` });
      expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${currentPath}\n${current}` });
      expect(result.evidence).toHaveLength(2);
    } else {
      expect(result).toMatchObject({ approved: false, status: "unverified", degraded: true });
      expect(result.reason).toContain("完整评审预算"); expect(bodies).toHaveLength(0);
    }
  });

  it.each([0, 1, 2])("sends complete G1 and current-gate text in every image batch; rejected batch %i controls the result", async rejectedBatch => {
    const accepted = JSON.stringify({ facts: { model: "820RR-RC", source: "source-accepted-only", full: "G1事实正文".repeat(3500), tail: "G1末尾事实约束" } });
    const current = "本次G3需求正文".repeat(2500) + "当前门末尾约束";
    const acceptedPath = file("G1_DOSSIER.json", accepted); const currentPath = file("G3_INSIGHT.md", current);
    const images = Array.from({ length: 7 }, (_, i) => ({ path: file(`batch-${i}.png`, png), kind: "image" as const, expectedSha256: sha256(png) }));
    const bodies: string[] = [];
    const fetchImpl = (async (_url, init) => {
      bodies.push(String(init?.body));
      const answer = bodies.length === rejectedBatch ? { ...good, approved: false, reason: `batch-${rejectedBatch}-rejected` } : good;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    }) as typeof fetch;
    const result = await reviewStage(textOptions({ stage: "keyframe", artifacts: [
      { path: acceptedPath, kind: "json", expectedSha256: sha256(accepted) },
      { path: currentPath, kind: "text", expectedSha256: sha256(current) }, ...images,
    ], fetchImpl }));
    expect(bodies).toHaveLength(2);
    for (const [index, body] of bodies.entries()) {
      const content = JSON.parse(body).messages[0].content as Array<{ type: string; text?: string }>;
      expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${acceptedPath}\n${accepted}` });
      expect(content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${currentPath}\n${current}` });
      expect(content.filter(item => item.type === "image_url")).toHaveLength(index === 0 ? 6 : 1);
    }
    expect(result.evidence).toEqual([
      { path: acceptedPath, sha256: sha256(accepted), scope: "complete-text" },
      { path: currentPath, sha256: sha256(current), scope: "complete-text" },
      ...images.map(image => ({ path: image.path, sha256: image.expectedSha256, scope: "image" })),
    ]);
    expect(result.approved).toBe(rejectedBatch === 0); expect(result.status).toBe(rejectedBatch === 0 ? "passed" : "failed");
    if (rejectedBatch) expect(result.reason).toContain(`batch-${rejectedBatch}-rejected`);
  });
});


describe("producer uses explicit source contracts", () => {
  const shots = [{ shotId: "PAIR", scene: "两人坐在窗边", characters: ["甲", "乙"], composition: "双人近景", lighting: "右侧烛光2200K", action: "保持坐姿，不笑", depth_of_field: "深景深" }];
  it("exact contract hash and complete facts enter judge, without old universal templates", async () => {
    const bodies: string[] = []; const contracts = { shots };
    const expected = buildProducerReviewContract(contracts);
    const result = await reviewStage(textOptions({ contracts, fetchImpl: judge(good, bodies) }));
    expect(result.approved).toBe(true); expect(result.contractHash).toBe(expected.contractHash);
    expect(bodies[0]).toContain("右侧烛光2200K"); expect(bodies[0]).toContain("深景深"); expect(bodies[0]).toContain(expected.contractHash);
    expect(expected.shots[0]?.intent.subject.count).toBe(2);
    expect(Object.values(PRODUCER_RUBRICS).flat().join("；")).not.toMatch(/五路微动作齐备|无第二张脸|屏幕始终朝向|全部是 2024|六镜是同一个人|都在成片里可见/);
  });
  it("structured device date and purpose are checked before calling a model", async () => {
    const bodies: string[] = [];
    const phone = { shotId: "PHONE", scene: "手机产品特写", devices: [{ category: "phone", model: "iPhone 16" }] };
    const missing = await reviewStage(textOptions({ contracts: { shots: [phone] }, fetchImpl: judge(good, bodies) }));
    expect(missing.status).toBe("unverified"); expect(bodies).toHaveLength(0);
    const future = await reviewStage(textOptions({ contracts: { shots: [phone], eraProfile: { storyDate: "2012-01-01" } }, fetchImpl: judge(good, bodies) }));
    expect(future.status).toBe("failed"); expect(bodies).toHaveLength(0);
    const valid = await reviewStage(textOptions({ contracts: { shots: [phone], eraProfile: { storyDate: "2024-09-20" } }, fetchImpl: judge(good, bodies) }));
    expect(valid.approved).toBe(true); expect(bodies[0]).toContain("设备声明：iPhone 16");
  });
  it.each([null, { shots: [] }, { shots: [null] }, { shots: [{ scene: "空镜" }] }, { shots: [shots[0], shots[0]] }, { shots: [{ shotId: "UNKNOWN" }] }, { shots, sceneBible: null }])("invalid structured contracts are unverified before external calls %j", async (contracts) => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ contracts: contracts as never, fetchImpl: judge(good, bodies) }));
    expect(result.status).toBe("unverified"); expect(bodies).toHaveLength(0);
  });
  it("mutating the source while reviewing cannot retain a passed verdict", async () => {
    const contracts = { shots: structuredClone(shots) };
    const fetchImpl = (async () => { contracts.shots[0]!.lighting = "左侧冷光"; return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] })); }) as typeof fetch;
    const result = await reviewStage(textOptions({ contracts, fetchImpl }));
    expect(result.approved).toBe(false); expect(result.reason).toContain("合同发生变化");
  });
  it("oversize contract stays unverified without truncating its final facts", async () => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ contracts: { shots: [{ ...shots[0], description: "a".repeat(30001) }] }, fetchImpl: judge(good, bodies) }));
    expect(result.status).toBe("unverified"); expect(result.reason).toContain("超预算"); expect(bodies).toHaveLength(0);
  });
  it("legacy no-contract caller explicitly declares the unverified fact boundary", async () => {
    const bodies: string[] = [];
    const result = await reviewStage(textOptions({ fetchImpl: judge(good, bodies) }));
    expect(result.contractHash).toBeUndefined(); expect(bodies[0]).toContain("未提供结构化镜头合同");
  });
});

describe("model-aware complete text evidence allocation", () => {
  const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
  function payload(model: string, total = 104_441) {
    // Synthetic originals reproduce attempt24's exact UTF-16 sizes, not its content.
    const source = { facts: { head: "G1全文起点", content: "", tail: "G1全文末尾的来源与用途限制" } };
    source.facts.content = "源".repeat(51_977 - JSON.stringify(source).length);
    const accepted = JSON.stringify(source);
    const head = "G4全文起点：人物、场景和交付合同\n", tail = "\nG4全文末尾：全部执行计划仍待实际审核";
    const current = head + "审".repeat(total - accepted.length - head.length - tail.length) + tail;
    const currentPath = file("G4_PRD.md", current), acceptedPath = file("G1_DOSSIER.json", accepted);
    return { accepted, current, currentPath, acceptedPath, options: {
      env: { ...env, LLM_MODEL: model },
      artifacts: [
        { path: currentPath, kind: "text" as const, expectedSha256: sha256(current) },
        { path: acceptedPath, kind: "json" as const, expectedSha256: sha256(accepted) },
      ],
    } };
  }
  function expectFullText(body: string, value: ReturnType<typeof payload>) {
    const request = JSON.parse(body);
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${value.currentPath}\n${value.current}` });
    expect(request.messages[0].content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${value.acceptedPath}\n${value.accepted}` });
  }

  it.each(["deepseek-flash", "deepseek-v4-pro"])("sends all104441 UTF-16 units once to exact %s with original request settings and both hashes", async model => {
    const value = payload(model), bodies: string[] = [];
    expect(value.accepted).toHaveLength(51_977); expect(value.current).toHaveLength(52_464);
    expect(Buffer.byteLength(value.accepted + value.current, "utf8")).toBeGreaterThan(200_000);
    const verdict = await reviewStage(textOptions({ ...value.options, fetchImpl: judge(good, bodies) }));
    expect(verdict).toMatchObject({ approved: true, status: "passed", score: 85, degraded: false, via: "llm", model });
    expect(bodies).toHaveLength(1); expectFullText(bodies[0]!, value);
    expect(JSON.parse(bodies[0]!)).toEqual({ model, messages: expect.any(Array), temperature: 0.2, response_format: { type: "json_object" } });
    expect(verdict.evidence).toEqual(value.options.artifacts.map(artifact => ({ path: artifact.path, sha256: artifact.expectedSha256, scope: "complete-text" })));
  });

  it.each([
    { model: "deepseek-flash", total: 200_000, allowed: true },
    { model: "deepseek-flash", total: 200_001, allowed: false },
    { model: "deepseek-v4-pro", total: 200_000, allowed: true },
    { model: "deepseek-v4-pro", total: 200_001, allowed: false },
  ])("enforces the exact aggregate boundary for $model at$total", async ({ model, total, allowed }) => {
    const value = payload(model, total), bodies: string[] = [];
    expect(value.accepted.length + value.current.length).toBe(total);
    const verdict = await reviewStage(textOptions({ ...value.options, fetchImpl: judge(good, bodies) }));
    expect(verdict.approved).toBe(allowed); expect(bodies).toHaveLength(allowed ? 1 : 0);
    if (allowed) expectFullText(bodies[0]!, value);
    else expect(verdict).toMatchObject({ status: "unverified", degraded: true, reason: expect.stringContaining("完整评审预算") });
  });

  it.each(["judge-unknown", "deepseek-chat", "deepseek-reasoner", "deepseek-flash-latest", "deepseek-v4-pro-preview", "provider/deepseek-flash", "DEEPSEEK-FLASH", " deepseek-flash", "deepseek-v4-pro "])(
    "retains100k for unknown, legacy or noncanonical %j without wildcard matching", async model => {
      for (const total of [100_000, 100_001]) {
        const value = payload(model, total), bodies: string[] = [];
        const verdict = await reviewStage(textOptions({ ...value.options, fetchImpl: judge(good, bodies) }));
        expect(verdict.approved).toBe(total === 100_000); expect(bodies).toHaveLength(total === 100_000 ? 1 : 0);
        if (total === 100_000) expectFullText(bodies[0]!, value);
        else expect(verdict.reason).toContain("完整评审预算");
      }
    },
  );

  it.each([
    { model: "deepseek-flash", units: 200_000, extra: "", allowed: true },
    { model: "deepseek-flash", units: 200_000, extra: "a", allowed: false },
    { model: "deepseek-chat", units: 100_000, extra: "", allowed: true },
    { model: "deepseek-chat", units: 100_000, extra: "a", allowed: false },
  ])("counts surrogate pairs as UTF-16 units for$model/$units/$extra", async ({ model, units, extra, allowed }) => {
    const text = "😀".repeat(units / 2) + extra, bodies: string[] = [], path = file("unicode.txt", text);
    expect(text.length).toBe(units + extra.length); expect([...text]).toHaveLength(units / 2 + extra.length);
    const verdict = await reviewStage(textOptions({ env: { ...env, LLM_MODEL: model }, artifacts: [{ path, kind: "text", expectedSha256: sha256(text) }], fetchImpl: judge(good, bodies) }));
    expect(verdict.approved).toBe(allowed); expect(bodies).toHaveLength(allowed ? 1 : 0);
    if (allowed) expect(JSON.parse(bodies[0]!).messages[0].content).toContainEqual({ type: "text", text: `以下是产物正文（完整）：${path}\n${text}` });
  });

  it.each([
    { answer: { ...good, score: 69 }, minScore: undefined, allowed: false },
    { answer: { ...good, score: 70 }, minScore: undefined, allowed: true },
    { answer: { ...good, score: 99, approved: false }, minScore: undefined, allowed: false },
    { answer: { ...good, score: 89 }, minScore: 90, allowed: false },
  ])("keeps original scoring and explicit refusal for expanded text %j", async ({ answer, minScore, allowed }) => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    const verdict = await reviewStage(textOptions({ ...value.options, minScore, fetchImpl: judge(answer, bodies) }));
    expect(verdict.approved).toBe(allowed); expect(verdict.score).toBe(answer.score);
    expect(verdict.status).toBe(allowed ? "passed" : "failed"); expect(verdict.degraded).toBe(false);
    expect(bodies).toHaveLength(1); expectFullText(bodies[0]!, value);
  });

  it.each(["hard-failure", "missing-required", "unverified-required"])("keeps%s before any expanded-text model call", async mode => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    const deterministic = mode === "hard-failure" ? [{ id: "source", pass: false, hard: true, detail: "real hard failure" }]
      : mode === "unverified-required" ? [{ id: "source", pass: true, hard: true, status: "unverified" as const, detail: "no receipt" }] : [];
    const verdict = await reviewStage(textOptions({ ...value.options, deterministic, requiredCheckIds: ["source"], fetchImpl: judge(good, bodies) }));
    expect(verdict.approved).toBe(false); expect(bodies).toHaveLength(0);
  });

  it.each(["before", "during"])("still rejects expanded-text artifact mutation%s review", async when => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    if (when === "before") writeFileSync(value.acceptedPath, JSON.stringify({ changed: "different accepted source" }));
    const fetchImpl = (async (_url, init) => {
      bodies.push(String(init?.body)); writeFileSync(value.currentPath, "changed during model review");
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }] }));
    }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ ...value.options, fetchImpl }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(bodies).toHaveLength(when === "before" ? 0 : 1);
    expect(verdict.reason).toContain(when === "before" ? "摘要" : "评审期间产物发生变化");
  });

  it.each([0, 1])("retains the original30000 context-plus-contract boundary with expanded text, delta%i", async delta => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    const contracts = { shots: [{ shotId: "WHOLE", scene: "无人产品全景", lighting: "自然日光", action: "商品静置" }] };
    const contractLength = JSON.stringify(buildProducerReviewContract(contracts)).length;
    const context = { note: "a".repeat(30_000 - contractLength - JSON.stringify({ note: "" }).length + delta) };
    expect(JSON.stringify(context).length + contractLength).toBe(30_000 + delta);
    const verdict = await reviewStage(textOptions({ ...value.options, contracts, context, fetchImpl: judge(good, bodies) }));
    expect(verdict.approved).toBe(delta === 0); expect(bodies).toHaveLength(delta === 0 ? 1 : 0);
    if (delta) expect(verdict.reason).toContain("评审上下文超预算");
  });

  it.each(["artifact-images", "reference-images"])("keeps the existing%s cap with expanded text", async mode => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    const images = Array.from({ length: mode === "artifact-images" ? 61 : 7 }, (_, i) => file(`cap-${i}.png`, png));
    const verdict = await reviewStage(textOptions({ ...value.options,
      ...(mode === "artifact-images" ? { artifacts: [...value.options.artifacts, ...images.map(path => ({ path, kind: "image" as const }))] } : { referenceImages: images }),
      fetchImpl: judge(good, bodies) }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true });
    expect(verdict.reason).toContain(mode === "artifact-images" ? "图像证据超过" : "基准图超过"); expect(bodies).toHaveLength(0);
  });

  it("keeps an expanded-text HTTP failure unverified with no additional request", async () => {
    const value = payload("deepseek-flash"), bodies: string[] = [];
    const fetchImpl = (async (_url, init) => { bodies.push(String(init?.body)); return new Response("provider failure", { status: 500 }); }) as typeof fetch;
    const verdict = await reviewStage(textOptions({ ...value.options, fetchImpl }));
    expect(verdict).toMatchObject({ approved: false, status: "unverified", degraded: true, reason: expect.stringContaining("HTTP 500") });
    expect(bodies).toHaveLength(1); expectFullText(bodies[0]!, value);
  });
});
