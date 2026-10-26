/** Pure Ark video request construction. It never reads files, credentials, or the network. */
import { createHash } from "node:crypto";

export interface VideoSubmissionArtifact {
  path: string;
  sha256: string;
  bytes: number;
  mime: string;
}

export interface VideoSubmissionImage {
  url: string;
  purpose: string;
  artifact?: VideoSubmissionArtifact;
  characterId?: string;
  characterVersion?: number;
  angle?: string;
}

export interface VideoSubmissionRequestOptions {
  model: string;
  prompt: string;
  firstFrame?: VideoSubmissionImage;
  refs: VideoSubmissionImage[];
  seconds: number;
  generateAudio: boolean;
  seed?: number;
  aspect: string;
  resolution: string;
}

/** URL-free evidence; external metadata is deliberately not called verified source bytes. */
export interface VideoSubmissionInput {
  role: "first_frame" | "reference_image";
  purpose: string;
  sourceType: "inline-image" | "remote-image" | "asset-reference";
  verification: "inline-bytes" | "metadata-only" | "external-reference";
  imageSha256?: string;
  imageBytes?: number;
  mime?: string;
  artifact?: VideoSubmissionArtifact;
  characterId?: string;
  characterVersion?: number;
  angle?: string;
}

export interface VideoSubmissionRequest {
  body: Record<string, unknown>;
  mode: "text" | "first-frame" | "reference-image";
  /** SHA256 of the exact UTF-8 JSON.stringify(body) bytes to send. */
  wireRequestSha256: string;
  promptSha256: string;
  /** Stable mode and ordered input metadata, with no URL or encoded image data. */
  inputPlanSha256: string;
  inputs: VideoSubmissionInput[];
}

type ModelFamily = "1.0" | "2.0" | "2.5";
const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const plain = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const text = (value: unknown): value is string => typeof value === "string" && Boolean(value.trim()) && !/[\u0000-\u001f\u007f]/.test(value);
const safeEvidenceText = (value: unknown): value is string => text(value) && !/(?:https?:\/\/|asset:\/\/|data:image\/)/i.test(value);
const imageMimes = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif"]);
const aspects = new Set(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"]);

function invalid(code: string, detail: string): never {
  // Do not interpolate user prompts, URLs, or encoded image data into an error.
  throw new Error(`VIDEO_SUBMISSION_${code}: ${detail}`);
}

function modelFamily(model: unknown): ModelFamily {
  if (typeof model !== "string") return invalid("MODEL_UNSUPPORTED", "an explicit supported Model ID is required");
  if (/^doubao-seedance-1-0-pro(?:-fast)?(?:-\d{6})?$/.test(model)) return "1.0";
  if (/^doubao-seedance-2-0(?:-fast)?(?:-\d{6})?$/.test(model)) return "2.0";
  if (/^doubao-seedance-2-5(?:-\d{6})?$/.test(model)) return "2.5";
  return invalid("MODEL_UNSUPPORTED", "unknown model or endpoint has no explicit capability contract");
}

function artifactMetadata(value: unknown): VideoSubmissionArtifact | undefined {
  if (value === undefined) return undefined;
  if (!plain(value) || !safeEvidenceText(value.path) || value.path.trim() !== value.path
    || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)
    || !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0
    || typeof value.mime !== "string" || !imageMimes.has(value.mime)) {
    return invalid("ARTIFACT_INVALID", "artifact requires a local path, full SHA256, positive byte count and image MIME");
  }
  return { path: value.path, sha256: value.sha256 as string, bytes: value.bytes as number, mime: value.mime };
}

function imageInput(value: unknown, role: VideoSubmissionInput["role"]): { url: string; evidence: VideoSubmissionInput; duplicateKey: string } {
  if (!plain(value) || !text(value.url) || value.url.trim() !== value.url || !safeEvidenceText(value.purpose)) {
    return invalid("IMAGE_INVALID", "each image requires a source URL and a URL-free purpose");
  }
  if (value.characterId !== undefined && (!safeEvidenceText(value.characterId) || /[\\/]/.test(value.characterId))) {
    return invalid("CHARACTER_INVALID", "character identity must be a nonempty component");
  }
  if (value.characterVersion !== undefined && (!Number.isSafeInteger(value.characterVersion)
    || Number(value.characterVersion) < 1 || value.characterId === undefined)) {
    return invalid("CHARACTER_INVALID", "character version requires an identity and a positive integer");
  }
  if (value.angle !== undefined && (typeof value.angle !== "string" || !/^[A-Za-z][A-Za-z0-9-]*$/.test(value.angle))) {
    return invalid("ANGLE_INVALID", "image angle must be an explicit angle label");
  }
  const artifact = artifactMetadata(value.artifact);
  let sourceType: VideoSubmissionInput["sourceType"];
  let verification: VideoSubmissionInput["verification"];
  let imageSha256 = artifact?.sha256;
  let imageBytes = artifact?.bytes;
  let mime = artifact?.mime;
  if (value.url.startsWith("data:")) {
    const data = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(value.url);
    if (!data || !imageMimes.has(data[1]!) || !data[2] || data[2].length % 4 !== 0) {
      return invalid("IMAGE_DATA_INVALID", "inline image must contain canonical image Base64");
    }
    const bytes = Buffer.from(data[2], "base64");
    if (bytes.length === 0 || bytes.toString("base64") !== data[2]) return invalid("IMAGE_DATA_INVALID", "inline image Base64 is malformed");
    imageSha256 = sha256(bytes); imageBytes = bytes.length; mime = data[1]!;
    if (artifact && (artifact.sha256 !== imageSha256 || artifact.bytes !== imageBytes || artifact.mime !== mime)) {
      return invalid("ARTIFACT_MISMATCH", "inline image bytes, SHA256 or MIME differ from the frozen artifact");
    }
    sourceType = "inline-image"; verification = "inline-bytes";
  } else if (/^asset:\/\/[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.url)) {
    if (artifact) return invalid("ARTIFACT_INVALID", "a provider asset ID cannot claim local artifact bytes");
    sourceType = "asset-reference"; verification = "external-reference";
  } else {
    let url: URL;
    try { url = new URL(value.url); } catch { return invalid("IMAGE_URL_INVALID", "image source must be HTTP(S), inline image data, or a provider asset ID"); }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return invalid("IMAGE_URL_INVALID", "remote image requires HTTP(S) without embedded credentials");
    }
    sourceType = "remote-image"; verification = artifact ? "metadata-only" : "external-reference";
  }
  const evidence: VideoSubmissionInput = {
    role, purpose: value.purpose, sourceType, verification,
    ...(imageSha256 !== undefined ? { imageSha256 } : {}),
    ...(imageBytes !== undefined ? { imageBytes } : {}),
    ...(mime !== undefined ? { mime } : {}),
    ...(artifact ? { artifact } : {}),
    ...(value.characterId !== undefined ? { characterId: value.characterId as string } : {}),
    ...(value.characterVersion !== undefined ? { characterVersion: value.characterVersion as number } : {}),
    ...(value.angle !== undefined ? { angle: value.angle as string } : {}),
  };
  return { url: value.url, evidence, duplicateKey: imageSha256 ? `image:${imageSha256}` : `url:${value.url}` };
}

/** Build one mutually exclusive input mode and bind its wire bytes to safe ordered evidence. */
export function buildVideoSubmissionRequest(options: VideoSubmissionRequestOptions): VideoSubmissionRequest {
  if (!plain(options)) return invalid("OPTIONS_INVALID", "request options must be an object");
  const family = modelFamily(options.model);
  if (typeof options.prompt !== "string" || !options.prompt.trim()) return invalid("PROMPT_INVALID", "a nonempty final prompt is required");
  if (family !== "1.0" && /--(?:seed|frames|camera[_-]fixed|cf)(?=$|[\s=])/i.test(options.prompt)) {
    return invalid("PROMPT_PARAMETER_UNSUPPORTED", "2.x prompt cannot carry seed, frames or fixed-camera weak parameters");
  }
  const [min, max]: [number, number] = family === "2.5" ? [4, 30] : family === "2.0" ? [4, 15] : [2, 12];
  if (!Number.isInteger(options.seconds) || options.seconds < min || options.seconds > max) {
    return invalid("DURATION_INVALID", "duration must be an unchanged integer within the selected model capability");
  }
  if (!Array.isArray(options.refs)) return invalid("REFERENCES_INVALID", "references must be an explicit array");
  if (Object.hasOwn(options, "lastFrame")) return invalid("LAST_FRAME_UNSUPPORTED", "this builder has no last-frame input contract");
  if (options.firstFrame !== undefined && options.refs.length > 0) return invalid("MIXED_MODES", "first-frame and reference-image inputs are mutually exclusive");
  if (family === "1.0" && options.refs.length > 0) return invalid("REFERENCES_UNSUPPORTED", "legacy 1.0 model does not support reference-image mode");
  const maxRefs = family === "2.0" ? 9 : 30;
  if (options.refs.length > maxRefs) return invalid("REFERENCE_LIMIT", "reference image count exceeds the selected model capability");
  if (!aspects.has(options.aspect)) return invalid("ASPECT_INVALID", "aspect must be a supported explicit ratio");
  const resolutions = family === "2.0" ? ["480p", "720p", "1080p", "4k"] : ["480p", "720p", "1080p"];
  if (!resolutions.includes(options.resolution)) return invalid("RESOLUTION_INVALID", "resolution is unsupported by the selected model family");
  if (typeof options.generateAudio !== "boolean") return invalid("AUDIO_INVALID", "generateAudio must be explicit boolean");
  if (family === "1.0" && options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < -1 || options.seed > 2147483647)) {
    return invalid("SEED_INVALID", "legacy seed must be an integer from -1 through 2147483647");
  }
  const mode: VideoSubmissionRequest["mode"] = options.firstFrame !== undefined ? "first-frame" : options.refs.length ? "reference-image" : "text";
  const images = mode === "first-frame" ? [imageInput(options.firstFrame, "first_frame")]
    : Array.from(options.refs, (image) => imageInput(image, "reference_image"));
  const urls = new Set<string>(); const identities = new Set<string>();
  for (const image of images) {
    if (urls.has(image.url) || identities.has(image.duplicateKey)) return invalid("REFERENCE_DUPLICATE", "duplicate reference URL or image bytes cannot be silently dropped");
    urls.add(image.url); identities.add(image.duplicateKey);
  }
  const inputs = images.map((image) => image.evidence);
  const body: Record<string, unknown> = {
    model: options.model,
    content: [{ type: "text", text: options.prompt }, ...images.map((image) => ({ type: "image_url", image_url: { url: image.url }, role: image.evidence.role }))],
    duration: options.seconds,
    ...(mode === "first-frame" ? {} : { ratio: options.aspect }),
    ...(mode === "reference-image" ? { omni_reference_task_type: "reference" } : {}),
    resolution: options.resolution,
    generate_audio: options.generateAudio,
    watermark: false,
    return_last_frame: true,
    ...(family === "1.0" && options.seed !== undefined ? { seed: options.seed } : {}),
  };
  return { body, mode, wireRequestSha256: sha256(JSON.stringify(body)), promptSha256: sha256(options.prompt),
    inputPlanSha256: sha256(JSON.stringify({ mode, inputs })), inputs };
}
