import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { recoverSceneJsonMissingComma } from "./scene-json-comma-recovery.js";

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
