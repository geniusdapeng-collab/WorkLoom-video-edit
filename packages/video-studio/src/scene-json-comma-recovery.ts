import { createHash } from "node:crypto";

type ValueKind = "container" | "scalar";
type SceneRecovery = {
  content: string;
  data: Record<string, unknown>;
  originalSha256: string;
  repairedSha256: string;
};
type SceneCommaRecovery = Readonly<SceneRecovery & { insertionByteOffset: number }>;
type SceneSeparatorRecovery = Readonly<SceneRecovery & { insertionByteOffsets: readonly number[] }>;

const MAX_SEPARATOR_RECOVERY_BYTES = 1_048_576;

/**
 * Recover absent separators from the complete SceneArchitect object.
 * Every key and value must already be a valid JSON token. The final strict
 * parse checks the entire repaired body, including text after the insertions.
 */
function recoverSceneJson(raw: string, maxInsertions: 1 | 8): SceneSeparatorRecovery | undefined {
  const whitespace = /[ \t\r\n]*/y;
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const scalar = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  let offset = 0;
  const insertions: number[] = [];

  function readToken(pattern: RegExp) {
    pattern.lastIndex = offset;
    const token = pattern.exec(raw)?.[0];
    if (token !== undefined) offset = pattern.lastIndex;
    return token;
  }

  function take(char: string) {
    if (raw[offset] !== char) return false;
    offset++;
    return true;
  }

  function insertComma() {
    if (insertions.length === maxInsertions) return false;
    insertions.push(offset);
    return true;
  }

  function readValue(depth: number): ValueKind | undefined {
    // Bound recursion for an otherwise untrusted response. Native scenes
    // require only a few levels of nesting.
    if (depth > 64) return undefined;
    if (take("{")) return readObject(depth) ? "container" : undefined;
    if (take("[")) return readArray(depth) ? "container" : undefined;
    if (readToken(string) !== undefined || readToken(scalar) !== undefined) return "scalar";
  }

  function readObject(depth: number): boolean {
    readToken(whitespace);
    if (take("}")) return true;
    const keys = new Set<string>();
    for (;;) {
      const token = readToken(string);
      if (token === undefined) return false;
      const key = JSON.parse(token) as string;
      if (keys.has(key)) return false;
      keys.add(key);
      readToken(whitespace);
      if (!take(":")) return false;
      readToken(whitespace);
      if (!readValue(depth + 1)) return false;
      readToken(whitespace);
      if (take("}")) return true;
      if (!take(",") && (raw[offset] !== '"' || !insertComma())) return false;
      readToken(whitespace);
    }
  }

  function readArray(depth: number): boolean {
    readToken(whitespace);
    if (take("]")) return true;
    for (;;) {
      const value = readValue(depth + 1);
      if (!value) return false;
      const spacing = readToken(whitespace);
      if (take("]")) return true;
      if (!take(",")) {
        // Adjacent scalar lexemes can be one malformed number, literal or
        // string. Require a whitespace boundary or a delimited container.
        if (!spacing && value === "scalar" && raw[offset] !== "{" && raw[offset] !== "[") return false;
        if (!insertComma()) return false;
      }
      readToken(whitespace);
    }
  }

  readToken(whitespace);
  if (!take("{") || !readObject(0)) return undefined;
  readToken(whitespace);
  if (offset !== raw.length || insertions.length === 0) return undefined;

  const original = Buffer.from(raw, "utf8");
  if (original.toString("utf8") !== raw) return undefined;
  const parts: string[] = [];
  const insertionByteOffsets: number[] = [];
  let start = 0;
  let byteOffset = 0;
  for (const insertion of insertions) {
    const prefix = raw.slice(start, insertion);
    byteOffset += Buffer.byteLength(prefix, "utf8");
    insertionByteOffsets.push(byteOffset);
    parts.push(prefix, ",");
    start = insertion;
  }
  const content = parts.join("") + raw.slice(start);
  let data: Record<string, unknown>;
  try { data = JSON.parse(content) as Record<string, unknown>; }
  catch { return undefined; }
  return Object.freeze({
    content,
    data,
    originalSha256: createHash("sha256").update(original).digest("hex"),
    repairedSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    insertionByteOffsets: Object.freeze(insertionByteOffsets),
  });
}

export function recoverSceneJsonMissingComma(raw: string): SceneCommaRecovery | undefined {
  const recovery = recoverSceneJson(raw, 1);
  if (!recovery) return undefined;
  const { insertionByteOffsets, ...result } = recovery;
  return Object.freeze({ ...result, insertionByteOffset: insertionByteOffsets[0]! });
}

/** Use only for complete native Responses bodies, never as a partial JSON parser. */
export function recoverSceneJsonMissingSeparators(raw: string): SceneSeparatorRecovery | undefined {
  if (raw.length > MAX_SEPARATOR_RECOVERY_BYTES || Buffer.byteLength(raw, "utf8") > MAX_SEPARATOR_RECOVERY_BYTES) {
    return undefined;
  }
  return recoverSceneJson(raw, 8);
}

/** Parse the entire native body without allowing JSON.parse's last-key-wins behavior. */
export function parseStrictSceneJsonObject(raw: string): Record<string, unknown> | undefined {
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { return undefined; }
  if (!data || typeof data !== "object" || Array.isArray(data) || Buffer.from(raw, "utf8").toString("utf8") !== raw) {
    return undefined;
  }

  // Syntax is already verified. Walk the tokens without recursion or a new
  // response size limit. A string followed by a colon must be an object key.
  const containers: Array<Set<string> | null> = [];
  const whitespace = /[ \t\r\n]*/y;
  for (let offset = 0; offset < raw.length; offset++) {
    switch (raw[offset]) {
      case "{": containers.push(new Set()); break;
      case "[": containers.push(null); break;
      case "}":
      case "]": containers.pop(); break;
      case '"': {
        const start = offset++;
        while (raw[offset] !== '"') {
          if (raw[offset] === "\\") offset++;
          offset++;
        }
        const keys = containers.at(-1);
        if (!keys) break;
        whitespace.lastIndex = offset + 1;
        whitespace.exec(raw);
        if (raw[whitespace.lastIndex] !== ":") break;
        const key = JSON.parse(raw.slice(start, offset + 1)) as string;
        if (keys.has(key)) return undefined;
        keys.add(key);
        break;
      }
    }
  }
  return data as Record<string, unknown>;
}
