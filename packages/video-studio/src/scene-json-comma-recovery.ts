import { createHash } from "node:crypto";

type ValueKind = "container" | "scalar";
type SceneCommaRecovery = Readonly<{
  content: string;
  data: Record<string, unknown>;
  originalSha256: string;
  repairedSha256: string;
  insertionByteOffset: number;
}>;

/**
 * Recover a single absent separator from the complete SceneArchitect object.
 * Every key and value must already be a valid JSON token. The final strict
 * parse checks the entire repaired body, including text after the insertion.
 */
export function recoverSceneJsonMissingComma(raw: string): SceneCommaRecovery | undefined {
  const whitespace = /[ \t\r\n]*/y;
  const string = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/y;
  const scalar = /(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/y;
  let offset = 0;
  let insertion: number | undefined;

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
    if (insertion !== undefined) return false;
    insertion = offset;
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
  if (offset !== raw.length || insertion === undefined) return undefined;

  const original = Buffer.from(raw, "utf8");
  if (original.toString("utf8") !== raw) return undefined;
  const prefix = raw.slice(0, insertion);
  const content = prefix + "," + raw.slice(insertion);
  let data: Record<string, unknown>;
  try { data = JSON.parse(content) as Record<string, unknown>; }
  catch { return undefined; }
  return Object.freeze({
    content,
    data,
    originalSha256: createHash("sha256").update(original).digest("hex"),
    repairedSha256: createHash("sha256").update(content, "utf8").digest("hex"),
    insertionByteOffset: Buffer.byteLength(prefix, "utf8"),
  });
}
