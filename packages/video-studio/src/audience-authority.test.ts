import { describe, expect, it } from "vitest";
import { bindExplicitAudienceMetadata, explicitAudienceFromIntent } from "./audience-authority.js";

describe("explicit audience authority", () => {
  it("extracts only the named customer audience", () => {
    expect(explicitAudienceFromIntent("给开发者做一条 30 秒的官网介绍片")).toBe("开发者");
    expect(explicitAudienceFromIntent("面向开发者的抖音介绍片")).toBe("开发者");
    expect(explicitAudienceFromIntent("面向 25-30 岁女性的种草片")).toBe("25-30 岁女性");
  });

  it("does not invent an unnamed audience", () => {
    expect(explicitAudienceFromIntent("拍一条城市人文短片")).toBeNull();
  });

  it("binds audience into Brief without mutating the caller metadata", () => {
    const metadata = { brief: { duration: 30 } };
    const bound = bindExplicitAudienceMetadata(metadata, "面向开发者的介绍片");
    expect(bound).toMatchObject({ audience: "开发者", changed: true });
    expect((bound.metadata.brief as Record<string, unknown>).audience).toBe("开发者");
    expect(metadata).toEqual({ brief: { duration: 30 } });
  });
});
