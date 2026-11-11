import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseStrictSceneJsonObject, recoverSceneJsonMissingComma, recoverSceneJsonMissingSeparators } from "./scene-json-comma-recovery.js";

describe("SceneArchitect single comma recovery", () => {
  it.each([
    ["object members", ' \r\n{"目的":"走过弯道🏍️" \n', '"时长":10}\t'],
    ["nested object members", '{"opening":{"duration":10', '"purpose":"进入弯道"}}'],
    ["array objects", '{"scenes":[{"duration":10}', '{"duration":10}]}'],
    ["nested arrays", '{"scenes":[[0,1]', '[2,3]]}'],
    ["array scalars with a lexical boundary", '{"timing":[-1.25e2 \r\n', '2],"flag":true}'],
    ["array literal and string", '{"elements":[null ', '"头盔"]}'],
    ["array scalar and delimited object", '{"elements":[true', '{"id":"helmet"}]}'],
    ["escaped strings and punctuation in values", '{"opening":"看见\\"转弯\\"\\n,{[:" ', '"ending":"停下"}'],
  ])("inserts one exact UTF-8 byte between %s", (_case, prefix, suffix) => {
    const raw = prefix + suffix;
    const content = prefix + "," + suffix;
    const result = recoverSceneJsonMissingComma(raw);
    expect(() => JSON.parse(raw)).toThrow(SyntaxError);
    expect(result).toEqual({
      content,
      data: JSON.parse(content),
      originalSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      repairedSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      insertionByteOffset: Buffer.byteLength(prefix, "utf8"),
    });
    const bytes = Buffer.from(content, "utf8");
    const position = result!.insertionByteOffset;
    expect(bytes[position]).toBe(0x2c);
    expect(Buffer.concat([bytes.subarray(0, position), bytes.subarray(position + 1)]))
      .toEqual(Buffer.from(raw, "utf8"));
  });

  it.each([
    ["already valid", '{"opening":"下山","ending":"到达"}'],
    ["empty", ""],
    ["non-object root", '[{"duration":10} {"duration":10}]'],
    ["fenced object", '```json\n{"a":1 "b":2}\n```'],
    ["leading prose", '结果：{"a":1 "b":2}'],
    ["trailing prose", '{"a":1 "b":2}结束'],
    ["extra JSON document", '{"a":1 "b":2}{}'],
    ["two missing commas", '{"opening":1 "scenes":[1 2],"ending":3}'],
    ["missing closing array", '{"a":[1 2}'],
    ["missing closing object", '{"a":1 "b":2'],
    ["trailing comma", '{"a":1 "b":2,}'],
    ["missing colon", '{"a":1 "b"2}'],
    ["unquoted key", '{"a":1 b:2}'],
    ["duplicate decoded key", '{"a":1 "\\u0061":2}'],
    ["duplicate key after insertion", '{"a":1 "b":2,"nest":{"duration":1,"duration":2}}'],
    ["duplicate prototype-like key", '{"__proto__":1 "__proto__":2}'],
    ["unescaped quote in text", '{"a":"走进"弯道","b":2}'],
    ["unescaped newline in text", '{"a":"走\n进" "b":2}'],
    ["invalid escape", '{"a":"\\x2c" "b":2}'],
    ["lone unescaped surrogate", '{"a":"\ud800" "b":2}'],
    ["non-JSON whitespace", '{"a":1\u00a0"b":2}'],
    ["fused numeric lexeme", '{"a":[01]}'],
    ["fused literals", '{"a":[truefalse]}'],
    ["adjacent quotes without a lexical boundary", '{"a":["走进""弯道"]}'],
    ["overdeep response", '{"a":' + "[".repeat(65) + "1 2" + "]".repeat(65) + "}"],
  ])("declines %s", (_case, raw) => {
    expect(recoverSceneJsonMissingComma(raw)).toBeUndefined();
  });

  it("compares duplicate keys by object scope and preserves encoded Unicode", () => {
    const raw = '{"a":{"\\u006b":"\\ud83c\\udfcd"} "b":{"k":"头盔"}}';
    const recovery = recoverSceneJsonMissingComma(raw);
    expect(recovery?.data).toEqual({ a: { k: "🏍" }, b: { k: "头盔" } });
    expect(recovery?.content).toBe('{"a":{"\\u006b":"\\ud83c\\udfcd"} ,"b":{"k":"头盔"}}');
  });
});

describe("SceneArchitect bounded separator recovery", () => {
  it.each([
    [' \r\n{"目的":"走过弯道🏍️" \n', '"时长":10}\t'],
    ['{"opening":{"duration":10 ', '"purpose":"风雪"} ', '"ending":true}'],
    [' \t{"scenes":[{"a":"引号：\\""}', '{"a":"🏍️"} ', '{"a":"\\u5934"}] ', '"timing":[1,2,3]}\r\n'],
    ['{"timing":[-1.25e2 \r\n', '2 ', '3 ', '4]}'],
    ['{"values":[1 ', '2 ', '3 ', '4 ', '5 ', '6 ', '7 ', '8 ', '9]}'],
  ])("restores exact UTF-8 source at %j", (...parts: string[]) => {
    const raw = parts.join("");
    const content = parts.join(",");
    const offsets = parts.slice(1).map((_part, index) => Buffer.byteLength(parts.slice(0, index + 1).join(""), "utf8"));
    const result = recoverSceneJsonMissingSeparators(raw);
    expect(() => JSON.parse(raw)).toThrow(SyntaxError);
    expect(result).toEqual({
      content,
      data: JSON.parse(content),
      originalSha256: createHash("sha256").update(raw, "utf8").digest("hex"),
      repairedSha256: createHash("sha256").update(content, "utf8").digest("hex"),
      insertionByteOffsets: offsets,
    });
    expect(Object.isFrozen(result?.insertionByteOffsets)).toBe(true);
    const repaired = Buffer.from(result!.content, "utf8");
    const originalParts: Buffer[] = [];
    let start = 0;
    result!.insertionByteOffsets.forEach((offset, index) => {
      const insertion = offset + index;
      expect(repaired[insertion]).toBe(0x2c);
      originalParts.push(repaired.subarray(start, insertion));
      start = insertion + 1;
    });
    originalParts.push(repaired.subarray(start));
    expect(Buffer.concat(originalParts)).toEqual(Buffer.from(raw, "utf8"));
  });

  it.each([
    ["no insertion", '{"a":1,"b":[2,3]}'],
    ["nine missing separators", '{"a":[1 2 3 4 5 6 7 8 9 10]}'],
    ["closing array missing after two omissions", '{"a":[1 2 3}'],
    ["closing object missing after two omissions", '{"a":1 "b":[2 3]'],
    ["late trailing comma", '{"a":1 "b":[2 3],}'],
    ["duplicate decoded key after two omissions", '{"a":1 "b":[2 3],"\\u0061":4}'],
    ["duplicate decoded nested key", '{"a":1 "b":{"k":2 "\\u006b":3}}'],
    ["adjacent scalar numbers", '{"a":1 "b":[2 3,04]}'],
    ["adjacent scalar strings", '{"a":1 "b":[2 3,"x""y"]}'],
    ["a second root value", '{"a":1 "b":[2 3]} {}'],
    ["an unpaired surrogate", '{"a":1 "b":[2 3],"c":"\ud800"}'],
    ["overdeep response", '{"a":1 "b":' + "[".repeat(65) + "2 3" + "]".repeat(65) + "}"],
  ])("declines %s without yielding partial output", (_case, raw) => {
    expect(recoverSceneJsonMissingSeparators(raw)).toBeUndefined();
  });

  it("admits the exact size boundary and measures multibyte input in original bytes", () => {
    const prefix = '{"a":"';
    const suffix = '" "b":[1 2]}';
    const atLimit = prefix + "x".repeat(1_048_576 - Buffer.byteLength(prefix + suffix)) + suffix;
    const overLimit = atLimit.replace("x", "🏍️");
    expect(recoverSceneJsonMissingSeparators(atLimit)?.insertionByteOffsets).toHaveLength(2);
    expect(recoverSceneJsonMissingSeparators(overLimit)).toBeUndefined();
  });
});

describe("SceneArchitect strict complete reissue parsing", () => {
  it.each([
    '{"a":1,"\\u0061":2}',
    '{"a":[{"a":1,"\\u0061":2}]}',
    '{"__proto__":{},"__proto__":{}}',
    '{"a":1 "b":2}',
    '{"a":1} {}',
    '{"a":"\ud800"}',
    '\u00a0{"a":1}',
    '[]',
  ])("declines invalid or ambiguous native bodies: %j", raw => {
    expect(parseStrictSceneJsonObject(raw)).toBeUndefined();
  });

  it("allows identical keys in separate objects and ignores punctuation in string values", () => {
    const data = { a: [{ a: 'literal } [, "a": 2' }, { a: 3 }], b: { a: 1 } };
    expect(parseStrictSceneJsonObject(` \t${JSON.stringify(data)}\r\n`)).toEqual(data);
  });

  it("does not apply the local recovery size or recursion limit to valid native JSON", () => {
    const raw = '{"scene":' + "[".repeat(70) + '"' + "声".repeat(350_000) + '"' + "]".repeat(70) + "}";
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1_048_576);
    expect(parseStrictSceneJsonObject(raw)).toEqual(JSON.parse(raw));
  });
});
