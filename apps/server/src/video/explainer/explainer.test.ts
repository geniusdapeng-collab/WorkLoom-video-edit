/**
 * explayer.test.ts —— 口播解说片引擎单元/契约测试 · T-2026-0926-0008
 *
 * 覆盖（全部不触库、不联网）：
 *  ① 卡注册表：frontmatter 解析 / const 槽抽取 / 展示文案抽取（剥注释）/ 内容补丁（唯一命中约束）；
 *  ② 对齐器：数字汉字化、DP 逐字对齐、timing 展开契约；
 *  ③ SHOTBOOK 校验：逐字覆盖/白名单/同卡连用/素材在场/sfx 落点；
 *  ④ 引擎闸：许可口径（noncommercial vs authorized + LICENSE-GRANT.md）与就绪度；
 *  ⑤ 渲染 CLI 组装：--all/--changed/--only 三态与幂等参数。
 *
 * 真实引擎（vendor/talkcraft）在场时，追加一条装配契约测试（模板复制 + 卡保真 + props 结构）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCardRegistry, extractConstSlots, extractDisplayStrings, parseFrontmatter, patchCardSource } from "./card-registry.js";
import { alignScriptToTimestamps, expandToTiming, intToChinese, normalizeSpoken } from "./aligner.js";
import { licenseStateOf, engineStatus, REQUIRED_ENGINE_FILES } from "./engine.js";
import { deriveAnchors, deriveBeats, validateShotbook } from "./shotbook.js";
import { renderShotsArgs, renderWorkerCount, remotionSubmitParams, RemotionProvider, readJobState } from "./remotion-provider.js";
import { explainerOutputSize, type ExplainerShotbook, type ExplainerScript, type SemanticsFile, type TimestampsFile } from "./types.js";
import { runMachineGates } from "./qa-gates.js";
import { deliverFilm } from "./deliver.js";
import { renderPreparedProject, runExplainerPipeline } from "./pipeline.js";
import * as voicePreparation from "./voice-prep.js";
import * as timestampPreparation from "./asr-aligner.js";
import * as semanticsPreparation from "./semantics.js";
import * as shotbookPreparation from "./shotbook.js";
import * as projectPreparation from "./project-builder.js";

describe("真实解说片默认后期接受与原声交付", () => {
  const ffmpeg = process.env.WL_FFMPEG || "ffmpeg";
  const ffprobe = process.env.WL_FFPROBE || "ffprobe";
  const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
  function fixture(silent = false): { jobDir: string; video: string; env: NodeJS.ProcessEnv } {
    const jobDir = mkdtempSync(join(tmpdir(), "growth explainer 中文 后期-"));
    mkdirSync(join(jobDir, "out"));
    const video = join(jobDir, "out", "v1.mp4");
    const result = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-n", "-f", "lavfi", "-i", "color=black:s=1080x1920:r=17:d=0.3",
      ...(silent ? ["-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", "0.3", "-c:a", "aac"] : ["-an"]),
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video], { encoding: "utf8", timeout: 30_000 });
    expect(result.status, result.stderr).toBe(0);
    return { jobDir, video, env: { ...process.env, WL_FFPROBE: ffprobe, WL_FFMPEG: ffmpeg } };
  }
  it("黑屏静止、无音轨与缺创作评审材料都直接接受，不启动运动/声音检查或额外解码", async () => {
    const f = fixture();
    try {
      const source = sha(f.video);
      const { report, qaFramesDir, sheetsDir } = await runMachineGates({ jobDir: f.jobDir, cards: ["old-card"], cueCount: 9,
        baseline: "/missing/identity.mp4", engineDir: "/missing/quality-engine", env: { ...f.env, WL_FFMPEG: "/must-not-execute-ffmpeg" } });
      expect(report.pass).toBe(true); expect(report.qualityReviewed).toBe(false); expect(report.qualityScore).toBeNull();
      expect(report.sourceArtifact?.sha256).toBe(source);
      expect(report.gates.filter((gate) => gate.status === "skip")).toHaveLength(6);
      expect(existsSync(qaFramesDir)).toBe(false); expect(existsSync(sheetsDir)).toBe(false); expect(sha(f.video)).toBe(source);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });
  it("实际缺片、不可读媒体与请求画布未导出会返回真实失败，不能伪造接受", async () => {
    const f = fixture();
    try {
      expect((await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, quality: "uhd", env: f.env })).report.pass).toBe(false);
      writeFileSync(f.video, "corrupt supplier bytes");
      expect((await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, env: f.env })).report.pass).toBe(false);
      rmSync(f.video);
      expect((await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, env: f.env })).report.pass).toBe(false);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });
  it.each([false, true])("默认交付保留所有原始视频与原声字节，静音=%s，响度未测而非假分", async (silent) => {
    const f = fixture(silent);
    try {
      const source = sha(f.video);
      const result = await deliverFilm({ jobDir: f.jobDir, sourceSha256: source, env: { ...f.env, WL_FFMPEG: "/must-not-execute-ffmpeg" } });
      expect(result.sha256).toBe(source); expect(result.measurement).toBeNull(); expect(sha(f.video)).toBe(source);
      const receipt = JSON.parse(readFileSync(join(f.jobDir, "out", "delivery-loudnorm.json"), "utf8"));
      expect(receipt.requested).toBe(false); expect(receipt.measured).toBeNull(); expect(receipt.qualityReviewed).toBe(false);
      await deliverFilm({ jobDir: f.jobDir, sourceSha256: source });
      expect(readdirSync(join(f.jobDir, "out")).filter((name) => name.startsWith("delivery.mp4.previous-"))).toHaveLength(1);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });
  it("接受后的当前字节变化拒绝，显式响度操作真实失败也不发布旧成片冒充新结果", async () => {
    const f = fixture(true);
    try {
      const source = sha(f.video);
      await expect(deliverFilm({ jobDir: f.jobDir, sourceSha256: "0".repeat(64) })).rejects.toThrow("POST_DELIVERY_SOURCE_CHANGED");
      const first = await deliverFilm({ jobDir: f.jobDir, sourceSha256: source });
      await expect(deliverFilm({ jobDir: f.jobDir, sourceSha256: source, normalize: true,
        env: { ...f.env, WL_FFMPEG: "/actual-missing-tool" } })).rejects.toThrow();
      expect(sha(first.deliveryPath)).toBe(source); expect(sha(f.video)).toBe(source);
      expect(readdirSync(join(f.jobDir, "out")).some((name) => name.includes("pending"))).toBe(false);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });
  it("明确请求响度只作一次真实滤镜，合法静音不因 -inf 品质量测被拒绝", async () => {
    const f = fixture(true);
    try {
      const source = sha(f.video), trace = join(f.jobDir, "media-commands.jsonl"), wrapper = join(f.jobDir, "ffmpeg.cjs");
      writeFileSync(wrapper, `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(a)+'\\n');const r=cp.spawnSync(${JSON.stringify(ffmpeg)},a,{stdio:'inherit'});process.exit(r.status??1);`);
      chmodSync(wrapper, 0o755);
      const result = await deliverFilm({ jobDir: f.jobDir, sourceSha256: source, normalize: true, env: { ...f.env, WL_FFMPEG: wrapper } });
      expect(existsSync(result.deliveryPath)).toBe(true); expect(result.measurement).toBeNull(); expect(sha(f.video)).toBe(source);
      const commands = readFileSync(trace, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(commands).toHaveLength(1); expect(commands[0].some((arg: string) => arg.startsWith("loudnorm=I=-15:TP=-1.5:LRA=11"))).toBe(true);
      const info = spawnSync(ffprobe, ["-v", "error", "-show_streams", "-of", "json", result.deliveryPath], { encoding: "utf8" });
      expect(info.status).toBe(0); expect(JSON.parse(info.stdout).streams.some((stream: any) => stream.codec_type === "audio")).toBe(true);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  const resumeInput = (f: ReturnType<typeof fixture>, provider: any, quality: "hd" | "uhd" = "hd") => ({
    provider, taskId: "same-job", jobDir: f.jobDir, scriptText: "已经渲染的正文", audioSeconds: 30, scope: "full",
    aspect: "9:16" as const, quality, resume: true, env: { ...f.env, FFPROBE_PATH: ffprobe }, timeoutMs: 1000, log: () => undefined,
  });
  const succeededReceipt = (f: ReturnType<typeof fixture>) => ({ status: "succeeded", taskId: "actual-issued-task",
    jobDir: f.jobDir, outputPath: f.video, outputSha256: sha(f.video), outputBytes: statSync(f.video).size,
    updatedAt: "2026-10-01T00:00:00Z" });

  it.each(["issued-binding", "samepath-replacement", "success-error", "invalid-status"])("真实 RemotionProvider 首次产物 %s 保持来源绑定与真实失败，不隐式重渲", async (kind) => {
    const f = fixture(), engine = join(f.jobDir, "controlled-engine"), jobs = join(f.jobDir, "issued-jobs");
    mkdirSync(join(engine, "scripts"), { recursive: true }); mkdirSync(join(f.jobDir, "remotion"));
    writeFileSync(join(engine, "LICENSE"), "PolyForm Noncommercial License 1.0.0 -- controlled offline fixture");
    writeFileSync(join(f.jobDir, "remotion", "props.json"), JSON.stringify({ width: 1080, height: 1920 }));
    rmSync(f.video); // The actual provider child creates the original result, not a hand-written success state.
    const trace = join(f.jobDir, "render-calls.jsonl");
    writeFileSync(join(engine, "scripts", "render_shots.mjs"), `import{spawnSync}from'node:child_process';import{appendFileSync}from'node:fs';appendFileSync(${JSON.stringify(trace)},'actual local render\\n');const r=spawnSync(${JSON.stringify(ffmpeg)},['-hide_banner','-v','error','-n','-f','lavfi','-i','color=black:s=1080x1920:r=17:d=0.3','-an','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','../out/v1.mp4'],{stdio:'inherit'});process.exitCode=r.status??1;`);
    const env = { ...f.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      TALKCRAFT_ENGINE_DIR: engine, TALKCRAFT_JOBS_DIR: jobs, TALKCRAFT_LICENSE_SCOPE: "noncommercial", FFPROBE_PATH: ffprobe };
    const real = new RemotionProvider({ env }), denied = { submit: vi.fn().mockRejectedValue(new Error("IMPLICIT_RESUBMIT")), poll: vi.fn() };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("UNEXPECTED_NETWORK"));
    try {
      const issued = await real.submit({ prompt: "controlled offline render", estimatedUnits: 1,
        params: { jobDir: f.jobDir, audioSeconds: 0.3, scope: "full", resolution: "1080x1920" } });
      const deadline = Date.now() + 30_000;
      let state = readJobState(f.jobDir);
      while (state?.status === "running" && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 50)); state = readJobState(f.jobDir);
      }
      expect(state?.status, JSON.stringify(state)).toBe("succeeded"); expect(state?.taskId).toBe(issued.taskId);
      const produced = sha(f.video), originalStatus = readFileSync(join(f.jobDir, "status.json"));
      if (kind === "issued-binding") {
        expect(state).toMatchObject({ outputPath: f.video, outputSha256: produced, outputBytes: statSync(f.video).size });
        expect((await real.poll(issued.taskId)).status).toBe("succeeded");
        expect((await renderPreparedProject({ ...resumeInput(f, denied), env })).resumed).toBe(true);
        expect((await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, env, requireProviderState: true })).report.pass).toBe(true);
      } else {
        if (kind === "samepath-replacement") {
          const replacement = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", "color=blue:s=1080x1920:r=17:d=0.3",
            "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", f.video], { encoding: "utf8", timeout: 30_000 });
          expect(replacement.status, replacement.stderr).toBe(0); expect(sha(f.video)).not.toBe(produced);
          expect(readFileSync(join(f.jobDir, "status.json"))).toEqual(originalStatus);
        } else writeFileSync(join(f.jobDir, "status.json"), JSON.stringify({ ...state,
          ...(kind === "success-error" ? { error: "actual renderer error evidence" } : { status: "unexpected" }) }));
        const current = sha(f.video), before = readFileSync(join(f.jobDir, "status.json"));
        await expect(renderPreparedProject({ ...resumeInput(f, denied), env })).rejects.toThrow(/POST_RESUME_/);
        expect((await real.poll(issued.taskId)).status).toBe("failed");
        const processing = await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, env, requireProviderState: true });
        expect(processing.report.pass).toBe(false); expect(processing.report.sourceArtifact).toBeNull();
        expect(sha(f.video)).toBe(current); expect(readFileSync(join(f.jobDir, "status.json"))).toEqual(before);
      }
      expect(readFileSync(trace, "utf8").trim().split("\n")).toHaveLength(1);
      expect(denied.submit).not.toHaveBeenCalled(); expect(denied.poll).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); rmSync(f.jobDir, { recursive: true, force: true }); }
  }, 45_000);

  it.each(["missing", "partial", "invalid", "mismatched", "legacy-summary"])("旧 Remotion 成片 %s 的来源证明明确核对，不给当前片补发认证", async (kind) => {
    const f = fixture(), { outputSha256, outputBytes, ...legacy } = succeededReceipt(f);
    const provider = { submit: vi.fn().mockRejectedValue(new Error("IMPLICIT_RESUBMIT")), poll: vi.fn() };
    try {
      const receipt = kind === "partial" ? { ...legacy, outputSha256 } : kind === "invalid" ? { ...legacy, outputSha256: "invalid", outputBytes }
        : kind === "mismatched" ? { ...legacy, outputSha256: "0".repeat(64), outputBytes } : legacy;
      writeFileSync(join(f.jobDir, "status.json"), JSON.stringify(receipt));
      const oldSummary = { jobId: f.jobDir, pass: false, gates: [{ gate: "motion_check", status: "fail" }],
        sourceArtifact: { path: f.video, sha256: outputSha256, bytes: outputBytes, duration: 0.3, width: 1080, height: 1920 } };
      if (kind === "legacy-summary" || kind === "partial" || kind === "invalid") {
        writeFileSync(join(f.jobDir, "out", "qa-report.json"), JSON.stringify(oldSummary));
      }
      const statusBefore = readFileSync(join(f.jobDir, "status.json")), source = sha(f.video);
      if (kind === "legacy-summary") {
        expect((await renderPreparedProject(resumeInput(f, provider))).resumed).toBe(true);
        expect(JSON.parse(readFileSync(join(f.jobDir, "out", "qa-report.json"), "utf8"))).toEqual(oldSummary);
      } else await expect(renderPreparedProject(resumeInput(f, provider))).rejects.toThrow(/POST_RESUME_SOURCE_BINDING_|POST_RESUME_SOURCE_CHANGED/);
      expect(readFileSync(join(f.jobDir, "status.json"))).toEqual(statusBefore); expect(sha(f.video)).toBe(source);
      expect(provider.submit).not.toHaveBeenCalled(); expect(provider.poll).not.toHaveBeenCalled();
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  function archivedPreparation(f: ReturnType<typeof fixture>, text = "已经渲染的正文。") {
    mkdirSync(join(f.jobDir, "audio")); mkdirSync(join(f.jobDir, "remotion"));
    const script: ExplainerScript = { sentences: [{ i: 1, text }] };
    const timestamps: TimestampsFile = { sr: 16000, total: 0.3, sentences: [{ i: 1, text, start: 0, end: 0.3,
      asr: "旧版不匹配识别", match: 0.1, ok: false, words: [] }] };
    const semantics: SemanticsFile = { sentences: [{ i: 1, text, sem: "论点", weight: "main", entities: [], need: "", shot: "s01" }] };
    const shotbook: ExplainerShotbook = { style: { domain: "历史解说片", tone: "原稿", palette: { base: "#000", accent: "#fff", ink: "#eee" }, font: "sans", energy: "低" },
      rhythmTable: [{ shotId: "s01", hostForm: "无人物", container: "无", card: "historical-card" }],
      shots: [{ id: "s01", start: 0, end: 0.3, text, card: "historical-card", content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "历史成功片不再按当前最短镜头规则重审" }] };
    const documents: Record<string, unknown> = { "script.json": script, "audio/timestamps.json": timestamps,
      "semantics.json": semantics, "shotbook.json": shotbook,
      "job.json": { schema: "workloom.explainer-job/v1", jobDir: f.jobDir, aspect: "9:16", quality: "hd", width: 1080, height: 1920, fps: 17, total: 0.3, cards: ["historical-card"], audio: "audio/full.wav", props: "remotion/props.json" },
      "remotion/props.json": { width: 1080, height: 1920, fps: 17, total: 0.3, shots: [{ id: "s01", hostSrc: null }], voice: null },
      "remotion/shots.json": [{ id: "s01", start: 0, end: 0.3 }], "remotion/beats.json": [], "remotion/anchors.json": [], "remotion/cues.json": [],
    };
    for (const [file, value] of Object.entries(documents)) writeFileSync(join(f.jobDir, file), JSON.stringify(value));
    writeFileSync(join(f.jobDir, "status.json"), JSON.stringify(succeededReceipt(f)));
    return { script, documents };
  }

  it.each([false, true])("外层 runExplainerPipeline 恢复档案与原片，静音=%s，TTS/ASR/模型/装配/预检/submit 均零调用", async (silent) => {
    const f = fixture(silent);
    const archived = archivedPreparation(f, silent ? "旧稿已有3个段落。" : undefined);
    const spies = [vi.spyOn(voicePreparation, "prepareVoice").mockRejectedValue(new Error("UNEXPECTED_TTS")),
      vi.spyOn(timestampPreparation, "alignTimestamps").mockRejectedValue(new Error("UNEXPECTED_ASR")),
      vi.spyOn(semanticsPreparation, "annotateSemantics").mockRejectedValue(new Error("UNEXPECTED_SEMANTIC_MODEL")),
      vi.spyOn(shotbookPreparation, "generateShotbook").mockRejectedValue(new Error("UNEXPECTED_SHOTBOOK_MODEL")),
      vi.spyOn(projectPreparation, "buildProject").mockImplementation(() => { throw new Error("UNEXPECTED_BUILD"); }),
      vi.spyOn(RemotionProvider.prototype, "submit").mockRejectedValue(new Error("UNEXPECTED_SUBMIT")),
      vi.spyOn(RemotionProvider.prototype, "poll").mockRejectedValue(new Error("UNEXPECTED_POLL")),
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("UNEXPECTED_NETWORK"))];
    try {
      const source = sha(f.video), before = Object.fromEntries(Object.keys(archived.documents).map((file) => [file, sha(join(f.jobDir, file))]));
      const trace = join(f.jobDir, "denied-tools.jsonl"), denied = join(f.jobDir, "deny-preparation.cjs");
      writeFileSync(denied, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv)+'\\n');process.exit(29);`); chmodSync(denied, 0o755);
      const llm = vi.fn().mockRejectedValue(new Error("UNEXPECTED_LLM")), events: any[] = [];
      const result = await runExplainerPipeline({ taskId: "same-job", jobDir: f.jobDir, script: archived.script,
        resumeFrom: "render", voice: { source: "tts", profile: "obsolete-profile" }, llm,
        engineDir: "/removed-historical-engine", templateDir: "/removed-historical-template",
        baselineHost: "/missing-identity-reference", env: { ...f.env, FFPROBE_PATH: ffprobe, FFMPEG_PATH: denied, WL_FFMPEG: denied, TALKCRAFT_PYTHON: denied },
        onStage: (event) => { events.push(event); } });
      expect(result.qa).toMatchObject({ pass: true, qualityReviewed: false, qualityScore: null });
      expect(result.delivery?.sha256).toBe(source); expect(result.renderVideoPath).toBe(f.video);
      expect(sha(f.video)).toBe(source); expect(result.timestamps.sentences[0]?.match).toBe(0.1);
      expect(result.shotbook.shots[0]?.end).toBe(0.3); // old successful short shot is not revalidated as new generation
      for (const spy of spies) expect(spy).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
      expect(existsSync(trace)).toBe(false);
      expect(events.find((event) => event.stageId === "preflight")).toMatchObject({ status: "skipped" });
      expect(Object.fromEntries(Object.keys(archived.documents).map((file) => [file, sha(join(f.jobDir, file))]))).toEqual(before);
    } finally { for (const spy of spies) spy.mockRestore(); rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  it.each(["missing-archive", "changed-input", "failed-provider", "missing-video", "unreadable-video", "canvas", "partial-render", "changed-during-post"])("外层恢复 %s 明确失败，原片不变且不开始准备或重提交", async (kind) => {
    const f = fixture();
    const archived = archivedPreparation(f);
    const spies = [vi.spyOn(voicePreparation, "prepareVoice").mockRejectedValue(new Error("UNEXPECTED_TTS")),
      vi.spyOn(timestampPreparation, "alignTimestamps").mockRejectedValue(new Error("UNEXPECTED_ASR")),
      vi.spyOn(semanticsPreparation, "annotateSemantics").mockRejectedValue(new Error("UNEXPECTED_SEMANTIC_MODEL")),
      vi.spyOn(shotbookPreparation, "generateShotbook").mockRejectedValue(new Error("UNEXPECTED_SHOTBOOK_MODEL")),
      vi.spyOn(projectPreparation, "buildProject").mockImplementation(() => { throw new Error("UNEXPECTED_BUILD"); }),
      vi.spyOn(RemotionProvider.prototype, "submit").mockRejectedValue(new Error("UNEXPECTED_SUBMIT")),
      vi.spyOn(RemotionProvider.prototype, "poll").mockRejectedValue(new Error("UNEXPECTED_POLL")),
      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("UNEXPECTED_NETWORK"))];
    try {
      if (kind === "missing-archive") rmSync(join(f.jobDir, "semantics.json"));
      if (kind === "failed-provider") writeFileSync(join(f.jobDir, "status.json"), JSON.stringify({ ...succeededReceipt(f), status: "failed" }));
      if (kind === "missing-video") rmSync(f.video);
      if (kind === "unreadable-video") writeFileSync(f.video, "corrupt original supplier bytes");
      const current = existsSync(f.video) ? sha(f.video) : null;
      const llm = vi.fn().mockRejectedValue(new Error("UNEXPECTED_LLM"));
      await expect(runExplainerPipeline({ taskId: "same-job", jobDir: f.jobDir,
        script: kind === "changed-input" ? { sentences: [{ i: 1, text: "新稿不能被旧成片冒充完成。" }] } : archived.script,
        quality: kind === "canvas" ? "uhd" : "hd", renderScope: kind === "partial-render" ? "changed:s01" : "full",
        resumeFrom: "render", voice: { source: "tts" }, llm,
        engineDir: "/removed-historical-engine", templateDir: "/removed-historical-template",
        env: { ...f.env, FFPROBE_PATH: ffprobe, WL_FFMPEG: "/must-not-execute-ffmpeg", TALKCRAFT_PYTHON: "/must-not-execute-python" },
        onStage: (event) => {
          if (kind === "changed-during-post" && event.stageId === "machineGates" && event.status === "done") {
            writeFileSync(join(f.jobDir, "script.json"), "archive bytes changed by concurrent writer");
          }
        },
      })).rejects.toThrow(/POST_RESUME_|POST_EXPORT_/);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled(); expect(llm).not.toHaveBeenCalled();
      expect(existsSync(join(f.jobDir, "out", "delivery.mp4"))).toBe(false);
      if (current) expect(sha(f.video)).toBe(current); else expect(existsSync(f.video)).toBe(false);
    } finally { for (const spy of spies) spy.mockRestore(); rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  it.each([false, true])("实际 explainer-run --resume 不依赖当前引擎/模板/语音/模型，静音=%s", (silent) => {
    const f = fixture(silent);
    const archived = archivedPreparation(f, "旧稿已有3个段落。");
    try {
      const repository = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
      const source = sha(f.video), trace = join(f.jobDir, "denied-cli-calls.jsonl");
      const denied = join(f.jobDir, "deny-cli-tool.cjs"), preload = join(f.jobDir, "deny-cli-models.mjs");
      writeFileSync(denied, `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv)+'\\n');process.exit(29);`); chmodSync(denied, 0o755);
      writeFileSync(preload, `import{appendFileSync}from'node:fs';import{RemotionProvider}from${JSON.stringify(pathToFileURL(join(repository, "apps/server/src/video/explainer/remotion-provider.ts")).href)};const deny=(name)=>(...args)=>{appendFileSync(${JSON.stringify(trace)},JSON.stringify({name,args})+'\\n');throw Error('UNEXPECTED_CLI_CALL:'+name);};globalThis.fetch=deny('network');RemotionProvider.prototype.submit=deny('submit');RemotionProvider.prototype.poll=deny('poll');`);
      const before = Object.fromEntries(Object.keys(archived.documents).map((file) => [file, sha(join(f.jobDir, file))]));
      const result = spawnSync(process.execPath, ["--import", "tsx", "--import", preload,
        "scripts/tools/explainer-run.mts", "--resume", "--task-id", basename(f.jobDir), "--llm", "deepseek"], {
        cwd: repository, encoding: "utf8", timeout: 30_000,
        env: { ...f.env, TALKCRAFT_JOBS_DIR: dirname(f.jobDir), TALKCRAFT_ENGINE_DIR: "/removed-historical-engine",
          TALKCRAFT_PYTHON: denied, FFMPEG_PATH: denied, WL_FFMPEG: denied, FFPROBE_PATH: ffprobe,
          LLM_BASE_URL: "https://must-not-contact.example", LLM_API_KEY: "offline-only-denied-fixture" },
      });
      expect(result.status, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`).toBe(0);
      expect(existsSync(trace)).toBe(false); expect(sha(f.video)).toBe(source);
      const report = JSON.parse(readFileSync(join(f.jobDir, "run-report.json"), "utf8"));
      expect(report).toMatchObject({ qaPass: true, deliverySha256: source, quality: "hd", loudnorm: null });
      expect(Object.fromEntries(Object.keys(archived.documents).map((file) => [file, sha(join(f.jobDir, file))]))).toEqual(before);
      expect(sha(join(f.jobDir, "out", "delivery.mp4"))).toBe(source);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  }, 40_000);

  it("实际 render 断点复用成功原片，即使旧品质检查失败也不 submit；旧失败记录与原 SHA 保留", async () => {
    const f = fixture();
    try {
      const source = sha(f.video), old = Buffer.from('{"pass":false,"gates":[{"gate":"motion_check","status":"fail"}],"qualityScore":1}\n');
      const reportFile = join(f.jobDir, "out", "qa-report.json");
      writeFileSync(join(f.jobDir, "status.json"), JSON.stringify(succeededReceipt(f)));
      writeFileSync(reportFile, old);
      const provider = { submit: vi.fn().mockRejectedValue(new Error("IMPLICIT_RESUBMIT")), poll: vi.fn() };
      const resumed = await renderPreparedProject(resumeInput(f, provider));
      expect(resumed.resumed).toBe(true); expect(resumed.uri).toBe(f.video);
      expect(provider.submit).not.toHaveBeenCalled(); expect(provider.poll).not.toHaveBeenCalled();
      const { report } = await runMachineGates({ jobDir: f.jobDir, cards: [], cueCount: 0, env: f.env });
      expect(report.pass).toBe(true); expect(report.sourceArtifact?.sha256).toBe(source);
      const previous = readdirSync(join(f.jobDir, "out")).filter((name) => name.startsWith("qa-report.previous-"));
      expect(previous).toHaveLength(1); expect(readFileSync(join(f.jobDir, "out", previous[0]!))).toEqual(old);
      expect(sha(f.video)).toBe(source);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  it.each(["missing", "unreadable", "canvas", "failed-provider", "missing-receipt", "other-output"])("断点 %s 是明确技术失败，绝不重新 submit 或改写成功源片", async (kind) => {
    const f = fixture();
    try {
      const receipt = succeededReceipt(f);
      if (kind === "failed-provider") receipt.status = "failed";
      if (kind === "other-output") receipt.outputPath = f.video + ".other";
      if (kind !== "missing-receipt") writeFileSync(join(f.jobDir, "status.json"), JSON.stringify(receipt));
      if (kind === "missing") rmSync(f.video);
      if (kind === "unreadable") writeFileSync(f.video, "unreadable supplier bytes");
      const current = existsSync(f.video) ? sha(f.video) : null;
      const provider = { submit: vi.fn().mockRejectedValue(new Error("IMPLICIT_RESUBMIT")), poll: vi.fn() };
      await expect(renderPreparedProject(resumeInput(f, provider, kind === "canvas" ? "uhd" : "hd"))).rejects.toThrow(/POST_RESUME_|POST_EXPORT_CANVAS_MISMATCH/);
      expect(provider.submit).not.toHaveBeenCalled(); expect(provider.poll).not.toHaveBeenCalled();
      if (current) expect(sha(f.video)).toBe(current);
      else expect(existsSync(f.video)).toBe(false);
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });

  it("只有明确首渲分支才提交，沿用同一个 provider 和请求参数", async () => {
    const f = fixture();
    try {
      const provider = { submit: vi.fn().mockResolvedValue({ taskId: "explicit-new-task" }),
        poll: vi.fn().mockResolvedValue({ status: "succeeded", uri: f.video }) };
      const result = await renderPreparedProject({ ...resumeInput(f, provider), resume: false });
      expect(result.resumed).toBe(false); expect(provider.submit).toHaveBeenCalledTimes(1); expect(provider.poll).toHaveBeenCalledTimes(1);
      expect(provider.submit.mock.calls[0]?.[0]).toMatchObject({ refId: "same-job", params: { jobDir: f.jobDir, audioSeconds: 30, scope: "full" } });
    } finally { rmSync(f.jobDir, { recursive: true, force: true }); }
  });
});

describe("输出画布契约", () => {
  it("默认 HD，UHD 竖屏与横屏均为原生尺寸", () => {
    expect(explainerOutputSize("9:16")).toEqual({ width: 1080, height: 1920 });
    expect(explainerOutputSize("9:16", "uhd")).toEqual({ width: 2160, height: 3840 });
    expect(explainerOutputSize("16:9", "uhd")).toEqual({ width: 3840, height: 2160 });
  });
});

const CARD_SRC = `import React from "react";
// 这是注释里的中文，不该进展示文案
export const meta = { width: 960, height: 540, fps: 30, durationInFrames: 110 };
const CONFIG = { lead: 0.3, hold: 1.8 };
const BARS = [16, 23, 30];
const MONTHS = ["1月", "2月", "3月"];
export default function Demo({ hostSrc }: { hostSrc?: string }) {
  return (
    <div>
      <h1>柱状增长</h1>
      <span>半年翻了一倍</span>
      {hostSrc}
    </div>
  );
}
`;

describe("card-registry", () => {
  it("解析 frontmatter（中文字段 + 列表拆分）", () => {
    const fm = parseFrontmatter(`---\nname: bar-chart-growth\n标题: 柱状增长\n输入: 文, 人(可选)\n语义: 数据\nprops: hostSrc\n---\n正文`);
    expect(fm.name).toBe("bar-chart-growth");
    expect(fm["标题"]).toBe("柱状增长");
    expect(fm["输入"]).toBe("文, 人(可选)");
  });

  it("抽取模块级 const 字面量槽（跳过函数与运行期表达式）", () => {
    const slots = extractConstSlots(CARD_SRC);
    const names = slots.map((s) => s.name);
    expect(names).toContain("BARS");
    expect(names).toContain("MONTHS");
    expect(names).toContain("CONFIG");
    expect(slots.find((s) => s.name === "BARS")?.value).toEqual([16, 23, 30]);
    expect(names).not.toContain("meta");
  });

  it("展示文案抽取剥掉注释里的中文", () => {
    const strings = extractDisplayStrings(CARD_SRC);
    expect(strings).toContain("柱状增长");
    expect(strings.some((s) => s.includes("不该进展示文案"))).toBe(false);
  });

  it("内容补丁：const 槽替换 + 唯一字符串替换；找不到/不唯一即抛错", () => {
    const patched = patchCardSource(CARD_SRC, {
      consts: { BARS: [40, 55, 72] },
      replaces: [{ from: "半年翻了一倍", to: "从 12 家到 260 家" }],
    });
    expect(patched.source).toContain("const BARS = [40,55,72];");
    expect(patched.source).toContain("从 12 家到 260 家");
    expect(patched.applied).toContain("const:BARS");
    expect(() => patchCardSource(CARD_SRC, { consts: { NOPE: 1 } })).toThrow(/找不到内容槽/);
    expect(() => patchCardSource(CARD_SRC, { replaces: [{ from: "柱状增长", to: "x" }] }))
      .not.toThrow();
    expect(() => patchCardSource(CARD_SRC.replace("半年翻了一倍", "重复字"), { replaces: [{ from: "重复字", to: "x" }] }))
      .not.toThrow();
    expect(() => patchCardSource("const A = 1;\nconst B = 1;\n", { replaces: [{ from: "1", to: "2" }] }))
      .toThrow(/不唯一/);
  });

  it("对象槽浅合并：只给要改的键，其余键（时间轴/缓动/几何）保持不变", () => {
    const patched = patchCardSource(CARD_SRC, { consts: { CONFIG: { hold: 3.2 } } });
    expect(patched.source).toContain('"lead":0.3');
    expect(patched.source).toContain('"hold":3.2');
    const config = JSON.parse(/const CONFIG = (.*);/.exec(patched.source)![1]!) as { lead: number; hold: number };
    expect(config).toEqual({ lead: 0.3, hold: 3.2 });
  });

  it("注册表白名单过滤", () => {
    const dir = mkdtempSync(join(tmpdir(), "tc-cards-"));
    mkdirSync(join(dir, "references/cards"), { recursive: true });
    mkdirSync(join(dir, "template/cards"), { recursive: true });
    writeFileSync(join(dir, "references/cards/keep.md"), "---\nname: keep\n标题: 保留\n语义: 数据\n---\n");
    writeFileSync(join(dir, "references/cards/drop.md"), "---\nname: drop\n标题: 丢弃\n语义: 数据\n---\n");
    writeFileSync(join(dir, "template/cards/keep.tsx"), CARD_SRC);
    writeFileSync(join(dir, "template/cards/drop.tsx"), CARD_SRC);
    const registry = buildCardRegistry(dir, { whitelist: ["keep"] });
    expect(registry.entries.map((e) => e.slug)).toEqual(["keep"]);
    expect(registry.bySlug.get("keep")?.semantics).toEqual(["数据"]);
  });
});

describe("aligner", () => {
  it("阿拉伯数字 → 汉字读法（对齐键）", () => {
    expect(intToChinese(0)).toBe("零");
    expect(intToChinese(18)).toBe("十八");
    expect(intToChinese(260)).toBe("二百六十");
    expect(intToChinese(2026)).toBe("二千零二十六");
    expect(normalizeSpoken("成本下降12%，产能25万")).toContain("十二");
    expect(normalizeSpoken("成本下降12%")).not.toMatch(/[0-9%]/);
  });

  it("DP 逐字对齐：句级起止正确、match=1、words 逐字", () => {
    const script: ExplainerScript = {
      sentences: [
        { i: 1, text: "获客增长系统。" },
        { i: 2, text: "先有人群，再有内容。" },
      ],
    };
    // 模拟 ASR 词表（字级等分；含一个繁体"獲"验证繁简归一）
    const words = [
      { text: "獲客", start: 0, end: 0.6 },
      { text: "增长", start: 0.6, end: 1.2 },
      { text: "系统", start: 1.2, end: 1.8 },
      { text: "先有", start: 2.0, end: 2.4 },
      { text: "人群", start: 2.4, end: 2.8 },
      { text: "再有", start: 2.8, end: 3.2 },
      { text: "内容", start: 3.2, end: 3.6 },
    ];
    const result = alignScriptToTimestamps(script, words, 3.8);
    expect(result.total).toBe(3.8);
    expect(result.sentences).toHaveLength(2);
    expect(result.sentences[0]!.start).toBeCloseTo(0, 2);
    expect(result.sentences[0]!.end).toBeCloseTo(1.8, 2);
    expect(result.sentences[0]!.match).toBe(1);
    expect(result.sentences[0]!.ok).toBe(true);
    expect(result.sentences[1]!.start).toBeGreaterThanOrEqual(2.0);
    expect(result.sentences[1]!.words.map((w) => w.text).join("")).toBe("先有人群再有内容");
  });

  it("缺字插值：ASR 漏字时仍给出单调时间且不越界", () => {
    const script: ExplainerScript = { sentences: [{ i: 1, text: "一二三四五六" }] };
    const words = [
      { text: "一二", start: 0, end: 0.4 },
      { text: "五六", start: 1.0, end: 1.4 },
    ];
    const result = alignScriptToTimestamps(script, words, 1.5);
    const charTimes = result.sentences[0]!.words.map((w) => w.start);
    for (let i = 1; i < charTimes.length; i += 1) expect(charTimes[i]!).toBeGreaterThanOrEqual(charTimes[i - 1]!);
    expect(charTimes[charTimes.length - 1]!).toBeLessThanOrEqual(1.5);
    expect(result.sentences[0]!.match).toBeLessThan(1);
  });

  it("timing 展开：标点零时长、CJK 保留 token 跨度（vendor make_timing 同契约）", () => {
    const timestamps: TimestampsFile = {
      sr: 16000,
      total: 1.2,
      sentences: [{
        i: 1, text: "你好，AI。", start: 0, end: 1.2, asr: "", match: 1, ok: true,
        words: [
          { text: "你", start: 0, end: 0.3 },
          { text: "好", start: 0.3, end: 0.6 },
          { text: "ai", start: 0.8, end: 1.0 },
        ],
      }],
    };
    const chars = expandToTiming(timestamps);
    expect(chars.map((c) => c.ch).join("")).toBe("你好，AI。");
    const comma = chars.find((c) => c.ch === "，")!;
    expect(comma.t).toBe(comma.e);
    expect(chars.find((c) => c.ch === "你")!.t).toBe(0);
  });
});

describe("shotbook 校验", () => {
  const registryDir = mkdtempSync(join(tmpdir(), "tc-registry-"));
  mkdirSync(join(registryDir, "references/cards"), { recursive: true });
  mkdirSync(join(registryDir, "template/cards"), { recursive: true });
  for (const slug of ["card-a", "card-b", "card-c"]) {
    writeFileSync(join(registryDir, `references/cards/${slug}.md`), `---\nname: ${slug}\n标题: ${slug}\n语义: 数据\n---\n`);
    writeFileSync(join(registryDir, `template/cards/${slug}.tsx`), CARD_SRC.replace("柱状增长", slug));
  }
  const registry = buildCardRegistry(registryDir);
  const script: ExplainerScript = { sentences: [{ i: 1, text: "第一句话。" }, { i: 2, text: "第二句话。" }] };
  const timestamps: TimestampsFile = {
    sr: 16000, total: 6,
    sentences: [
      { i: 1, text: "第一句话。", start: 0, end: 2.5, asr: "", match: 1, ok: true, words: [{ text: "第", start: 0, end: 0.2 }, { text: "一", start: 0.2, end: 0.4 }] },
      { i: 2, text: "第二句话。", start: 2.5, end: 6, asr: "", match: 1, ok: true, words: [{ text: "第", start: 2.5, end: 2.7 }, { text: "二", start: 2.7, end: 2.9 }] },
    ],
  };
  const semantics: SemanticsFile = {
    sentences: [
      { i: 1, text: "第一句话。", sem: "论点", weight: "main", entities: [], need: "", shot: null },
      { i: 2, text: "第二句话。", sem: "数据", weight: "main", entities: [], need: "", shot: null },
    ],
  };
  const good: ExplainerShotbook = {
    style: { domain: "测试", tone: "克制", palette: { base: "#000", accent: "#fff", ink: "#eee" }, font: "sans", energy: "中" },
    rhythmTable: [
      { shotId: "s01", hostForm: "半身", container: "装框", card: "card-a" },
      { shotId: "s02", hostForm: "角标左下", container: "底床", card: "card-b" },
    ],
    shots: [
      { id: "s01", start: 0, end: 2.5, text: "第一句话。", card: "card-a", content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "" },
      { id: "s02", start: 2.5, end: 6, text: "第二句话。", card: "card-b", content: {}, replace: [], skin: {}, material: { kind: "文" }, sfx: [], notes: "" },
    ],
  };
  const check = (shotbook: ExplainerShotbook) =>
    validateShotbook({ shotbook, script, timestamps, registry, engineDir: registryDir });

  it("正样本通过（含 beats/anchors 派生）", () => {
    const result = check(good);
    expect(result.errors).toEqual([]);
    const beats = deriveBeats(good, timestamps, semantics);
    expect(beats).toHaveLength(2);
    expect(beats[0]!.anchor).toBe("第一");
    expect(timestamps.sentences.some((s) => s.words.some((w) => w.text === "第"))).toBe(true);
    const anchors = deriveAnchors(beats, good);
    expect(anchors[0]!.burst).toBe(true); // 首镜必须连拍
  });

  it("文本改写/漏字 → FAIL（防编造）", () => {
    const bad = { ...good, shots: [{ ...good.shots[0]!, text: "改写过的句子。" }, good.shots[1]!] };
    const result = check(bad as ExplainerShotbook);
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.rule === "文本")).toBe(true);
  });

  it("卡不在白名单 → FAIL", () => {
    const bad = { ...good, shots: [{ ...good.shots[0]!, card: "card-z" }, good.shots[1]!] };
    const result = check(bad as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "选卡")).toBe(true);
  });

  it("同卡连用 3 镜 → FAIL；短镜 → FAIL；素材缺 ref → FAIL", () => {
    const three = {
      ...good,
      shots: [
        { ...good.shots[0]!, id: "s01", start: 0, end: 2, card: "card-a" },
        { ...good.shots[1]!, id: "s02", start: 2, end: 4, card: "card-a", text: "第二句话。" },
        { ...good.shots[1]!, id: "s03", start: 4, end: 6, card: "card-a", text: "第二句话。" },
      ],
      rhythmTable: [
        { shotId: "s01", hostForm: "半身", container: "装框", card: "card-a" },
        { shotId: "s02", hostForm: "半身", container: "装框", card: "card-a" },
        { shotId: "s03", hostForm: "半身", container: "装框", card: "card-a" },
      ],
    };
    const result = check(three as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "版式")).toBe(true);
    const shortShot = {
      ...good,
      shots: [
        { ...good.shots[0]!, end: 0.5 },
        { ...good.shots[1]!, start: 0.5 },
      ],
    };
    expect(check(shortShot as ExplainerShotbook).errors.some((e) => /镜长/.test(e.message))).toBe(true);
    const noRef = {
      ...good,
      shots: [{ ...good.shots[0]!, material: { kind: "图" } }, good.shots[1]!],
    };
    expect(check(noRef as ExplainerShotbook).errors.some((e) => e.rule === "素材")).toBe(true);
  });

  it("sfx 落点越界 → FAIL", () => {
    const badSfx = {
      ...good,
      shots: [{ ...good.shots[0]!, sfx: [{ t: 2.4, name: "whoosh", vol: 0.3 }] }, good.shots[1]!],
    };
    const result = check(badSfx as ExplainerShotbook);
    expect(result.errors.some((e) => e.rule === "音效")).toBe(true);
  });
});

describe("engine 许可闸与就绪度", () => {
  const fakeEngine = (opts: { license?: boolean; grant?: boolean } = {}): string => {
    const dir = mkdtempSync(join(tmpdir(), "tc-engine-"));
    for (const rel of REQUIRED_ENGINE_FILES) {
      const path = join(dir, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, rel === "LICENSE" ? "PolyForm Noncommercial License 1.0.0" : "x");
    }
    mkdirSync(join(dir, "template/cards"), { recursive: true });
    mkdirSync(join(dir, "template/motion-systems"), { recursive: true });
    mkdirSync(join(dir, "references/cards"), { recursive: true });
    writeFileSync(join(dir, "template/cards/a.tsx"), "// card");
    writeFileSync(join(dir, "PINNED"), JSON.stringify({ commit: "deadbeef", cards: 108 }));
    if (opts.grant) writeFileSync(join(dir, "LICENSE-GRANT.md"), "授权方：A\n被授权方：B\n范围：C\n日期：2026-09-26\n");
    if (opts.license === false) {
      writeFileSync(join(dir, "LICENSE"), "");
    }
    mkdirSync(join(dir, "runtime"), { recursive: true });
    writeFileSync(join(dir, "runtime/package.json"), JSON.stringify({ dependencies: { remotion: "4.0.519" } }));
    return dir;
  };

  it("noncommercial：无授权文件也可渲染（评估口径）", () => {
    const dir = fakeEngine();
    const license = licenseStateOf(dir, { TALKCRAFT_LICENSE_SCOPE: "noncommercial" });
    expect(license.okToRender).toBe(true);
    expect(license.upstreamLicenseKind).toBe("polyform-noncommercial");
  });

  it("authorized：缺 LICENSE-GRANT.md → 拒绝渲染；补齐即通过", () => {
    const without = fakeEngine();
    expect(licenseStateOf(without, { TALKCRAFT_LICENSE_SCOPE: "authorized" }).okToRender).toBe(false);
    const withGrant = fakeEngine({ grant: true });
    expect(licenseStateOf(withGrant, { TALKCRAFT_LICENSE_SCOPE: "authorized" }).okToRender).toBe(true);
  });

  it("就绪度：缺运行时依赖/冒烟标记 → ready=false 且原因可执行", () => {
    const dir = fakeEngine();
    const status = engineStatus(dir, { TALKCRAFT_LICENSE_SCOPE: "noncommercial" });
    expect(status.installed).toBe(true);
    expect(status.cardCount).toBe(1);
    expect(status.ready).toBe(false);
    expect(status.reason).toMatch(/运行时/);
  });

  it("非法许可口径直接抛错（不静默回落）", () => {
    const dir = fakeEngine();
    expect(() => licenseStateOf(dir, { TALKCRAFT_LICENSE_SCOPE: "whatever" })).toThrow(/TALKCRAFT_LICENSE_SCOPE/);
  });
});

describe("渲染 CLI 组装", () => {
  it("UHD 强制单段单帧，HD 维持可配置并行度", () => {
    expect(renderWorkerCount(2160, 3840, 8)).toBe(1);
    expect(renderWorkerCount(3840, 2160, 2)).toBe(1);
    expect(renderWorkerCount(1080, 1920, 2)).toBe(2);
    expect(() => renderWorkerCount(1080, 1920, 0)).toThrow(/正整数/);
  });

  it("三态范围与参数顺序（render_shots.mjs 真实契约）", () => {
    expect(renderShotsArgs({ scope: "full", parallel: 2, muxOut: "../out/v1.mp4", propsFile: "props.json" }))
      .toEqual(["--shots", "shots.json", "--all", "--parallel", "2", "--mux", "../out/v1.mp4", "--props", "@props.json"]);
    expect(renderShotsArgs({ scope: "changed:s07" })).toEqual(["--shots", "shots.json", "--changed", "s07", "--parallel", "2"]);
    expect(renderShotsArgs({ scope: "only:s07,s08" })).toEqual(["--shots", "shots.json", "--only", "s07,s08", "--parallel", "2"]);
    expect(() => renderShotsArgs({ scope: "nope" })).toThrow(/渲染范围非法/);
  });
});

describe("真实引擎契约（vendor/talkcraft 在场时才跑）", () => {
  const engineDir = join(process.cwd(), "vendor/talkcraft");
  const enabled = existsSync(join(engineDir, "PINNED"));
  it.skipIf(!enabled)("108 张卡与 frontmatter 可解析（抽样 5 张）", () => {
    const registry = buildCardRegistry(engineDir);
    expect(registry.entries.length).toBeGreaterThanOrEqual(100);
    for (const entry of registry.entries.slice(0, 5)) {
      expect(entry.slug.length).toBeGreaterThan(0);
      expect(entry.codePath).toMatch(/template\/cards\//);
      expect(readFileSync(join(engineDir, entry.codePath), "utf8").length).toBeGreaterThan(200);
    }
  });
});


describe("Remotion provider 参数合同", () => {
  it("唯一提交入口的 extra 参数与 CLI 顶层参数得到相同执行参数", () => {
    const params = { jobDir: "/tmp/prepared", audioSeconds: 6.25, scope: "only:s01,s02", parallel: 3 };
    const nested = remotionSubmitParams({ prompt: "script", estimatedUnits: 6, params: { durationSec: 6, extra: params } });
    expect(nested).toEqual(remotionSubmitParams({ prompt: "script", estimatedUnits: 6, params }));
    expect(renderShotsArgs(nested)).toContain("s01,s02");
    expect(nested.jobDir).toBe("/tmp/prepared");
  });
  it("冲突参数与空范围在任何文件写入/进程启动前拒绝", async () => {
    const provider = new RemotionProvider({ env: {} });
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { jobDir: "/a", extra: { jobDir: "/b" } } })).rejects.toThrow("冲突");
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { extra: { scope: "only:", audioSeconds: 5 } } })).rejects.toThrow();
    await expect(provider.submit({ prompt: "script", estimatedUnits: 6, params: { extra: { parallel: 0 } } })).rejects.toThrow();
  });
});

describe("解说片 submit 路由不可变请求复放", () => {
  let caller: any;
  const scope = { tenantId: "tenant-ex", workspaceId: "workspace-ex" };
  let saved: any;
  let row: any;
  const prepare = vi.fn(), submit = vi.fn(), create = vi.fn(), approve = vi.fn(), update = vi.fn(), renderJob = vi.fn(), register = vi.fn();
  const query = vi.fn();
  beforeAll(async () => {
    const { initTRPC } = await import("@trpc/server");
    const t = initTRPC.context<any>().create();
    vi.doMock("../../trpc/context.js", () => ({ router: t.router, protectedProcedure: t.procedure,
      writeProcedure: t.procedure, scopeOf: (identity: any) => ({ tenantId: identity.tenantId, workspaceId: identity.workspaceId }) }));
    vi.doMock("@workloom/db", () => ({ getAppPool: () => ({}), getGatewayPool: () => ({}) }));
    vi.doMock("../gen/submit.js", () => ({ submitGenJob: submit }));
    vi.doMock("../media/register-local.js", () => ({ registerLocalAsset: register }));
    vi.doMock("@workloom/base/asset-cms", () => ({ create, approve }));
    vi.doMock("@workloom/base/fence-engine", () => ({ judge: () => ({ level: "auto", impacts: [], triggeredBy: [] }) }));
    vi.doMock("@workloom/base/model-router", () => ({ checkRenderBudget: () => ({ allowed: true }), planTierToPlanId: () => "pro" }));
    vi.doMock("../router.js", () => ({ loadActiveRules: async () => ({ rules: [], defaultLevel: "auto" }) }));
    vi.doMock("./pipeline.js", () => ({ runExplainerPipeline: prepare }));
    vi.doMock("./db.js", () => ({ scopedQuery: query, projectOf: async () => ({ id: "project-ex", kind: "explainer" }),
      latestShotbook: async () => row, updateShotbook: update, renderJobOf: renderJob }));
    caller = (await import("./router.js")).explainerRouter.createCaller({ identity: { ...scope, memberNo: "MEM-EX", plan: "pro" } } as any);
  });
  beforeEach(() => {
    saved = null;
    row = { id: "shotbook", project_id: "project-ex", version: 3, script_text: "正文句子。", shotbook: { shots: [{ id: "s1", card: "verified-card" }] } };
    prepare.mockReset().mockResolvedValue({ jobDir: "/tmp/prepared-project", voice: { sha256: "voice" }, timestamps: { total: 5.4, sentences: [{ i: 1, ok: true }] } });
    submit.mockReset().mockResolvedValue({ taskId: "accepted-task" }); update.mockReset();
    renderJob.mockReset().mockResolvedValue(null);
    register.mockReset().mockResolvedValue({ assetId: "registered-final-cut", sha256: "registered-sha", bytes: 1 });
    create.mockReset().mockImplementation(async (_a, _g, _s, input) => {
      saved = { id: `${input.scriptKey}-v1`, project_id: input.projectId, shot_id: input.shotId, script_key: input.scriptKey,
        version: 1, md: input.md, fields: input.fields, status: "draft" };
      return saved;
    });
    approve.mockReset().mockImplementation(async () => { saved = { ...saved, status: "approved" }; return { script: saved }; });
    query.mockReset().mockImplementation(async (sql, params, actualScope) => {
      expect(actualScope).toEqual(scope);
      if (sql.includes("SELECT s.* FROM render_scripts")) {
        expect(params).toEqual([scope.workspaceId, expect.stringMatching(/^explainer-shotbook(?:-uhd)?$/), scope.tenantId, "project-ex"]);
        return saved && (!saved.script_key || saved.script_key === params[1]) ? [saved] : [];
      }
      if (sql.includes("SUM(")) return [{ total: "0" }];
      if (sql.includes("FROM explainer_shotbooks")) return [row];
      throw new Error(`unexpected query ${sql}`);
    });
  });
  it("接受后记账失败重试复用相同 script/version/params，不重做配音工程，不重复审批", async () => {
    submit.mockRejectedValueOnce(new Error("SUBMISSION_FINALIZATION_PENDING"));
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("SUBMISSION_FINALIZATION_PENDING");
    const first = submit.mock.calls[0]?.[0];
    await caller.submit({ projectId: "project-ex" });
    const repeated = submit.mock.calls[1]?.[0];
    expect(repeated.script).toEqual(first.script); expect(repeated.params).toEqual(first.params);
    expect(prepare).toHaveBeenCalledTimes(1); expect(create).toHaveBeenCalledTimes(1); expect(approve).toHaveBeenCalledTimes(1);
    expect(repeated.idempotencyKey).toBe("explainer:shotbook:v3");
  });
  it("UHD 采用独立脚本与幂等键，重试沿用已装配的原生 4K 画布", async () => {
    await caller.submit({ projectId: "project-ex", quality: "uhd" });
    const first = submit.mock.calls[0]?.[0];
    expect(first.script.script_key).toBe("explainer-shotbook-uhd");
    expect(first.idempotencyKey).toBe("explainer:shotbook:v3:uhd");
    expect(first.params.resolution).toBe("2160x3840");
    expect(prepare.mock.calls[0]?.[0].quality).toBe("uhd");
    await caller.submit({ projectId: "project-ex", quality: "uhd" });
    const repeated = submit.mock.calls[1]?.[0];
    expect(repeated.script).toEqual(first.script);
    expect(repeated.params).toEqual(first.params);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(approve).toHaveBeenCalledTimes(1);
  });
  it("另一清晰度仍在渲染时拒绝覆盖分镜的工程目录", async () => {
    renderJob.mockImplementation(async (_scope, key) => key === "explainer:shotbook:v3:uhd" ? { status: "running" } : null);
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("仍在运行");
    expect(prepare).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });
  it.each([{ voiceProfile: "changed" }, { renderScope: "only:s1" }, { assets: [{ from: "/a", to: "b" }] }])("相同分镜改变输入 %j，在重做准备/调用供应商前拒绝", async (patch) => {
    await caller.submit({ projectId: "project-ex" });
    await expect(caller.submit({ projectId: "project-ex", ...patch })).rejects.toThrow("绑定其他");
    expect(prepare).toHaveBeenCalledTimes(1); expect(submit).toHaveBeenCalledTimes(1);
  });
  it("同工作区其他项目分镜不能套用当前项目提交或交付", async () => {
    row.project_id = "project-other";
    await expect(caller.submit({ projectId: "project-ex", shotbookId: "shotbook" })).rejects.toThrow("不属于");
    await expect(caller.finalize({ projectId: "project-ex", shotbookId: "shotbook" })).rejects.toThrow("当前项目");
    expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
  });
  it.each(["original", "samepath-replacement", "success-error", "missing-state", "missing-binding"])("真实 HTTP finalize %s 核对原产物再交付，不靠 DB done 给当前片补发成功", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "growth explainer finalize 中文-")), video = join(root, "out", "v1.mp4");
    mkdirSync(join(root, "out"));
    const ffmpeg = process.env.WL_FFMPEG || "ffmpeg", ffprobe = process.env.WL_FFPROBE || "ffprobe";
    const generate = (color: string) => {
      const r = spawnSync(ffmpeg, ["-hide_banner", "-v", "error", "-y", "-f", "lavfi", "-i", `color=${color}:s=1080x1920:r=17:d=0.3`,
        "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", video], { encoding: "utf8", timeout: 30_000 });
      expect(r.status, r.stderr).toBe(0);
    };
    generate("black");
    const hash = () => createHash("sha256").update(readFileSync(video)).digest("hex"), original = hash();
    const state: Record<string, unknown> = { status: "succeeded", taskId: "original-issued", jobDir: root, outputPath: video,
      outputSha256: original, outputBytes: statSync(video).size };
    if (kind === "samepath-replacement") generate("blue");
    if (kind === "success-error") state.error = "actual renderer error";
    if (kind === "missing-binding") { delete state.outputSha256; delete state.outputBytes; }
    if (kind !== "missing-state") writeFileSync(join(root, "status.json"), JSON.stringify(state));
    writeFileSync(join(root, "job.json"), JSON.stringify({ quality: "hd", aspect: "9:16" }));
    row = { ...row, job_dir: root, shotbook: { ...row.shotbook, style: { domain: "真实恢复" } } };
    renderJob.mockResolvedValue({ id: "db-done-job", status: "done" });
    const current = hash(), previousProbe = process.env.WL_FFPROBE;
    process.env.WL_FFPROBE = ffprobe;
    try {
      if (kind === "original") {
        expect(await caller.finalize({ projectId: "project-ex" })).toMatchObject({ ready: true, status: "delivered" });
        expect(createHash("sha256").update(readFileSync(join(root, "out", "delivery.mp4"))).digest("hex")).toBe(original);
        expect(register).toHaveBeenCalledTimes(1);
      } else {
        await expect(caller.finalize({ projectId: "project-ex" })).rejects.toThrow(/POST_RESUME_/);
        expect(existsSync(join(root, "out", "delivery.mp4"))).toBe(false); expect(register).not.toHaveBeenCalled();
        const report = JSON.parse(readFileSync(join(root, "out", "qa-report.json"), "utf8"));
        expect(report).toMatchObject({ pass: false, sourceArtifact: null, qualityReviewed: false });
      }
      expect(hash()).toBe(current); expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled();
    } finally { if (previousProbe === undefined) delete process.env.WL_FFPROBE; else process.env.WL_FFPROBE = previousProbe; rmSync(root, { recursive: true, force: true }); }
  });
  it("旧脚本缺少不可变请求凭据时拒绝重建和重发", async () => {
    saved = { id: "legacy", version: 6, md: "old", fields: {} };
    await expect(caller.submit({ projectId: "project-ex" })).rejects.toThrow("未核实");
    expect(prepare).not.toHaveBeenCalled(); expect(submit).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
  });
});
