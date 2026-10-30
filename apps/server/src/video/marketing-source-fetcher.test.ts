import { createServer, type Server } from "node:http";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fetchMarketingSource,
  fetchMarketingSourceWithRetry,
  publicSourceAddress,
  requestSource,
  retryableMarketingSourceError,
  sourceDocument,
  sourceUrl,
  SOURCE_MAX_BYTES,
  SOURCE_MAX_TEXT_CHARS,
  type SourceTransport,
} from "./marketing-source-fetcher.js";
let server: Server, origin: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/redirect") { res.writeHead(302, { location: "/page" }); res.end(); return; }
    if (req.url === "/private") { res.writeHead(302, { location: "http://127.0.0.1/secret" }); res.end(); return; }
    if (req.url === "/loop") { res.writeHead(302, { location: "/loop" }); res.end(); return; }
    if (req.url === "/slow") return;
    if (req.url === "/denied") { res.writeHead(403); res.end("denied"); return; }
    if (req.url === "/large") { res.writeHead(200, { "content-type": "text/plain", "content-length": SOURCE_MAX_BYTES + 1 }); res.end(); return; }
    if (req.url === "/broken") { res.writeHead(200, { "content-type": "text/plain", "content-length": 500 }); res.write("partial"); setImmediate(() => res.destroy()); return; }
    if (req.url === "/gzip") { res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "content-encoding": "gzip" }); res.end(gzipSync("完整中文正文")); return; }
    if (req.url === "/binary") { res.writeHead(200, { "content-type": "image/png" }); res.end("image"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><script>伪造事实</script><style>隐藏内容</style><p>星野 F3 &amp; 风量 9 档</p><img src="/hero.jpg"><p>完整尾部 &#x4e2d;文</p></html>');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
const resolver = async () => [{ address: "93.184.216.34", family: 4 }];
const transport: SourceTransport = async (url, _address, signal) => requestSource(new URL(url.pathname, origin), { address: "127.0.0.1", family: 4 }, signal);
function fetchPage(route: string, options: Parameters<typeof fetchMarketingSource>[1] = {}) { return fetchMarketingSource(`https://source.example.com${route}`, { resolver, transport, ...options }); }
describe("来源公网地址与真实HTTP读取", () => {
  it.each(["0.0.0.0", "10.1.1.1", "127.0.0.1", "172.16.4.5", "192.168.1.1", "100.64.0.1", "169.254.169.254", "192.0.2.1", "198.51.100.1", "203.0.113.8", "224.0.0.1", "::1", "::ffff:8.8.8.8", "fc00::1", "fe80::1", "2001:db8::1", "2001:0000::1", "2002:0808:0808::1"])("非公网%s禁止", value => expect(publicSourceAddress(value)).toBe(false));
  it.each(["8.8.8.8", "192.2.1.1", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"])("公网%s可用", value => expect(publicSourceAddress(value)).toBe(true));
  it.each(["file:///etc/passwd", "https://user:pass@source.example.com/", "https://source.example.com:8080/", "http://source.example.com:443/", "http://localhost/", "https://host.local/", "https://127.1/", "http://[::1]/"])("URL%s在请求前拒绝", value => expect(() => sourceUrl(value)).toThrow(/SOURCE_URL/));
  it("真实HTTP保留完整中文正文、实体、图片候选、重定向和双摘要", async () => {
    const result = await fetchPage("/redirect");
    expect(result.snapshot).toMatchObject({ finalUrl: "https://source.example.com/page", redirectChain: ["https://source.example.com/redirect"], text: "星野 F3 & 风量 9 档\n完整尾部 中文", assetUrls: ["https://source.example.com/hero.jpg"] });
    expect(result.snapshot.rawSha256).toMatch(/^[a-f0-9]{64}$/); expect(result.snapshot.textSha256).not.toBe(result.snapshot.rawSha256);
    expect(result.rawBytes.toString()).toContain("伪造事实"); expect(result.snapshot.text).not.toContain("伪造事实");
  });
  it("低层传输确实使用传入DNS地址，hostname不需解析也保持Host", async () => {
    const local = new URL(origin); local.hostname = "nonexistent-host.example.com";
    const result = await requestSource(local, { address: "127.0.0.1", family: 4 }, AbortSignal.timeout(1000)); expect(result.status).toBe(200);
  });
  it.each([["/private", "SOURCE_URL_PRIVATE"], ["/loop", "SOURCE_REDIRECT_INVALID"], ["/denied", "SOURCE_HTTP_FAILED"], ["/large", "SOURCE_TOO_LARGE"], ["/binary", "SOURCE_TYPE_UNSUPPORTED"], ["/broken", "SOURCE_ABORTED"]])("%s失败关闭", async (route, error) => { await expect(fetchPage(route!)).rejects.toThrow(error); });
  it("解压后保存实际字节，并拒绝压缩炸弹", async () => {
    expect((await fetchPage("/gzip")).snapshot.text).toBe("完整中文正文");
    await expect(fetchPage("/", { transport: async () => ({ status: 200, headers: { "content-type": "text/plain", "content-encoding": "gzip" }, body: gzipSync("x".repeat(SOURCE_MAX_BYTES + 1)) }) })).rejects.toThrow();
  });
  it("任一DNS答复为私网即拒绝，不挑选看似可用的首条", async () => {
    const blocked = vi.fn(transport);
    await expect(fetchPage("/", { resolver: async () => [...await resolver(), { address: "127.0.0.1", family: 4 }], transport: blocked })).rejects.toThrow("SOURCE_URL_PRIVATE");
    expect(blocked).not.toHaveBeenCalled();
  });
  it.each(["dns", "transport", "socket"])("%s超时都终止，不无限等待", async kind => {
    await expect(fetchPage(kind === "socket" ? "/slow" : "/", { timeoutMs: 30,
      ...(kind === "dns" ? { resolver: () => new Promise(() => {}) } : kind === "transport" ? { transport: () => new Promise(() => {}) } : {}) })).rejects.toThrow(/abort|timeout/i);
  });
  it("拒绝空文/验证码/长文，不把裁剪当完整原文", () => {
    for (const value of ["", "请完成安全验证", "x".repeat(SOURCE_MAX_TEXT_CHARS + 1)]) expect(() => sourceDocument(value, "text/plain", "https://source.example.com/")).toThrow();
    const largeButBounded = sourceDocument("可核实正文\n".repeat(8_000), "text/plain", "https://source.example.com/").text;
    expect(largeButBounded.length).toBeGreaterThan(24_000);
    expect(largeButBounded.length).toBeLessThanOrEqual(SOURCE_MAX_TEXT_CHARS);
    expect(sourceDocument('<img src="http://127.0.0.1/x">有效正文', "text/html", "https://source.example.com/").assetUrls).toEqual([]);
  });
  it("公开 GET 只对瞬时网络/429/5xx重试，策略失败立即关闭", async () => {
    let attempts = 0;
    const flaky: SourceTransport = async (url, address, signal) => {
      attempts++;
      if (attempts === 1) return { status: 503, headers: {}, body: Buffer.from("busy") };
      return requestSource(new URL(url.pathname, origin), { address: "127.0.0.1", family: 4 }, signal);
    };
    const result = await fetchMarketingSourceWithRetry("https://source.example.com/page", {
      resolver,
      transport: flaky,
      attemptTimeoutsMs: [1000, 1000],
      retryDelaysMs: [0],
    });
    expect(result.snapshot.text).toContain("星野 F3");
    expect(attempts).toBe(2);
    expect(retryableMarketingSourceError(new Error("SOURCE_HTTP_FAILED：来源HTTP 429"))).toBe(true);
    expect(retryableMarketingSourceError(new Error("SOURCE_URL_PRIVATE：私网"))).toBe(false);
    await expect(fetchMarketingSourceWithRetry("http://127.0.0.1/", {
      attemptTimeoutsMs: [1000, 1000],
      retryDelaysMs: [0],
    })).rejects.toThrow("SOURCE_URL_PRIVATE");
  });
});

describe("来源 HTML 的真实图片候选", () => {
  const pageUrl = "https://source.example.com/news/article.html";
  const document = (markup: string) => sourceDocument(`<p>完整正文 &amp; 尾部</p>${markup}`, "text/html", pageUrl);

  it.each(["src", "data-src", "data-original", "data-src-original", "data-lazy-src"])("读取 %s，兼容大小写、单引号及非引号属性", attribute => {
    expect(document(`<IMG ${attribute.toUpperCase()}='../hero.jpg?variant=rc&amp;size=2'>`).assetUrls).toEqual(["https://source.example.com/hero.jpg?variant=rc&size=2"]);
    expect(document(`<img ${attribute}=/hero.jpg>`).assetUrls).toEqual(["https://source.example.com/hero.jpg"]);
  });

  it("保留同一标签的原图、懒加载图和 src，去重且原图优先于占位图", () => {
    expect(document('<img src="/placeholder.png" data-src="/real.jpg" data-original="/original.jpg" data-lazy-src="/real.jpg"><img src="/real.jpg">').assetUrls)
      .toEqual(["https://source.example.com/original.jpg", "https://source.example.com/real.jpg", "https://source.example.com/placeholder.png"]);
  });

  it("车家号 data-src-original 不被空或内联占位 src 遮住", () => {
    const imageUrl = "https://www2.autoimg.cn/chejiahaodfs/g33/M0B/A5/90/750x0_autohomecar__ChxpVmrNlSSAEhFhAAVW-cpKwlE948.jpg";
    expect(document(`<img src="data:image/gif;base64,AAAA" data-src-original="${imageUrl}"><img src="" data-src-original="${imageUrl}">`).assetUrls)
      .toEqual([imageUrl]);
  });

  it.each(["srcset", "data-srcset", "source-srcset"])("%s 收集每个密度/宽度候选，不破坏 URL 内逗号", attribute => {
    expect(document(`<img ${attribute}="//cdn.example.com/a,b.jpg 1x, ../large.jpg?x=1&amp;y=2 2x, /plain.jpg, /wide.jpg 1600w">`).assetUrls)
      .toEqual(["https://cdn.example.com/a,b.jpg", "https://source.example.com/large.jpg?x=1&y=2", "https://source.example.com/plain.jpg", "https://source.example.com/wide.jpg"]);
  });

  it("picture 的 source srcset 即使没有 src 也提取，标签内 > 不截断属性", () => {
    expect(document('<picture><source media="(width > 600px)" srcset="/wide.webp 800w, /wider.webp 1600w"><img alt="a > b" data-original="/fallback.jpg"></picture>').assetUrls)
      .toEqual(["https://source.example.com/wide.webp", "https://source.example.com/wider.webp", "https://source.example.com/fallback.jpg"]);
  });

  it("srcset 的无效描述符及 data URL 不生成伪相对路径候选", () => {
    expect(document('<img srcset="data:image/png;base64,AAAA 1x, /zero.jpg 0w, /conflict.jpg 1w 2x, /bad.jpg Infinityx, /negative.jpg -1x, /valid.jpg 1.5x, /valid2.jpg 2e0x">').assetUrls)
      .toEqual(["https://source.example.com/valid.jpg", "https://source.example.com/valid2.jpg"]);
  });

  it("所有入口仍拒绝内部域名、私网、凭据、端口、非 HTTP 协议和无效 URL", () => {
    const rejected = ["http://127.0.0.1/a.jpg", "https://host.local/a.jpg", "https://user:pass@cdn.example.com/a.jpg", "https://cdn.example.com:8080/a.jpg", "file:///tmp/a.jpg", "javascript:alert(1)", "data:image/png;base64,AAAA", "http://[not-ip]/a.jpg"];
    for (const attribute of ["src", "data-src", "data-original", "data-src-original", "data-lazy-src"]) {
      for (const url of rejected) expect(document(`<img ${attribute}="${url}">`).assetUrls, `${attribute}=${url}`).toEqual([]);
    }
    expect(document('<source srcset="http://127.0.0.1/a.jpg 1x, //host.internal/b.jpg 2x, /public.jpg 3x">').assetUrls)
      .toEqual(["https://source.example.com/public.jpg"]);
  });

  it.each(["script", "style", "noscript", "template"])("排除 %s 中的伪 img/source，保留块后的真实图片", tag => {
    const markup = `<${tag}><img src="/fake.jpg"><source srcset="/fake.webp 2x"></${tag}><img src="/real.jpg">`;
    expect(document(markup).assetUrls).toEqual(["https://source.example.com/real.jpg"]);
    expect(document(`<${tag}><img src="/unclosed.jpg">`).assetUrls).toEqual([]);
  });

  it("排除注释、嵌套模板、其它标签属性里的 img 字符串，不能由假标签提取候选", () => {
    expect(document(`<!-- <img src="/comment.jpg"> --><template><template><img src="/inner.jpg"></template><img src="/outer.jpg"></template><div title='<img src="/attribute.jpg">'>文本</div><img src="/real.jpg"><!-- <img src="/unclosed.jpg">`).assetUrls)
      .toEqual(["https://source.example.com/real.jpg"]);
  });

  it("脚本内注释/模板字符串不能吞掉 script 结束标签后的真实图", () => {
    expect(document('<script>const markup = \'<!-- <img src="/fake.jpg">\';</script><img src="/real.jpg">').assetUrls)
      .toEqual(["https://source.example.com/real.jpg"]);
    expect(document('<template><script>const markup = "</template>";</script><img src="/fake.jpg"></template><img src="/real.jpg">').assetUrls)
      .toEqual(["https://source.example.com/real.jpg"]);
  });

  it("真实 IT之家 RC 页的三组懒加载标签同时保留原图 srcset 和 CDN 变体", () => {
    // Root 于 2026-10-24 保存的 https://www.ithome.com/1/004/414.htm 标签（省略非 URL 属性）。
    const paths = ["19c620fd-e878-45bd-84e5-ca401f419897", "02958931-41f4-4f07-a2da-ce04b70d8a76", "14e43dcf-44df-4077-b6cd-9029285514d8"];
    const heights = [1285, 2158, 2023];
    const images = paths.map((id, index) => `<img src="//img.ithome.com/images/v2/t.png" class="lazy" srcset="https://img.ithome.com/newsuploadfiles/2026/9/${id}.jpg 2x" data-original="https://img.ithome.com/newsuploadfiles/2026/9/${id}.jpg@s_2,w_820,h_${heights[index]}">`).join("");
    const result = sourceDocument(`<p>820RR-RC 赛道版</p>${images}`, "text/html; charset=utf-8", "https://www.ithome.com/1/004/414.htm");
    for (const [index, id] of paths.entries()) {
      expect(result.assetUrls).toContain(`https://img.ithome.com/newsuploadfiles/2026/9/${id}.jpg`);
      expect(result.assetUrls).toContain(`https://img.ithome.com/newsuploadfiles/2026/9/${id}.jpg@s_2,w_820,h_${heights[index]}`);
    }
    expect(result.assetUrls).toHaveLength(7);
    expect(result.text).toBe("820RR-RC 赛道版");
  });

  it("图片候选新增不改变原文 text，文本和 JSON 不被当成 HTML 扫图", () => {
    const raw = '<p>第一段 &amp; 实话</p><script>隐藏事实</script><style>隐藏样式</style><!-- 隐藏注释 --><img data-original="/real.jpg"><p>尾部 &#x4e2d;文</p>';
    expect(sourceDocument(raw, "text/html", pageUrl)).toEqual({ text: "第一段 & 实话\n尾部 中文", assetUrls: ["https://source.example.com/real.jpg"] });
    for (const type of ["text/plain", "application/json"]) expect(sourceDocument(raw, type, pageUrl).assetUrls).toEqual([]);
  });
});
