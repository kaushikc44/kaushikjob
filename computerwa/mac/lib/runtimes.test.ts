import { describe, expect, it } from "vitest";
import { classifyModels, exposedOnLan, installGuidance, isLoopbackUrl, probeRuntime, type RuntimeCandidate } from "./runtimes";
import { startMockModel } from "./testkit";

describe("model classification (name-based, never guesses)", () => {
  it("recognises Gemma 4 ids but not size tags or other Gemma versions", () => {
    const c = classifyModels(["gemma4:12b", "google/gemma-4-it", "gemma_4", "gemma3:4b", "gemma:4b", "gemma2:9b", "llama3.1:8b"]);
    expect(c.gemma4).toEqual(["gemma4:12b", "google/gemma-4-it", "gemma_4"]);
    expect(c.otherGemma).toEqual(["gemma3:4b", "gemma:4b", "gemma2:9b"]);
    expect(c.others).toEqual(["llama3.1:8b"]);
  });
});

describe("runtime probing", () => {
  it("lists real model ids from /v1/models", async () => {
    const m = await startMockModel({ models: ["a", "gemma4:x"] });
    const p = await probeRuntime({ id: "custom", label: "t", baseUrl: m.url });
    expect(p).toMatchObject({ reachable: true, models: ["a", "gemma4:x"] });
    m.close();
  });
  it("reports unreachable servers without throwing", async () => {
    const c: RuntimeCandidate = { id: "custom", label: "dead", baseUrl: "http://127.0.0.1:9/v1" };
    expect(await probeRuntime(c, { timeoutMs: 500 })).toMatchObject({ reachable: false, models: [] });
  });
  it("reports HTTP errors and malformed bodies", async () => {
    const bad = (async () => new Response("nope", { status: 500 })) as typeof fetch;
    expect(await probeRuntime({ id: "custom", label: "t", baseUrl: "http://x/v1" }, { fetchImpl: bad })).toMatchObject({ reachable: true, models: [], error: "HTTP 500 from /models" });
    const weird = (async () => new Response(JSON.stringify({ data: [{ id: 5 }, { id: "ok" }, {}] }))) as typeof fetch;
    expect((await probeRuntime({ id: "custom", label: "t", baseUrl: "http://x/v1" }, { fetchImpl: weird })).models).toEqual(["ok"]);
  });
});

describe("exposure and guidance", () => {
  it("only loopback URLs count as local", () => {
    expect(isLoopbackUrl("http://127.0.0.1:11434/v1")).toBe(true);
    expect(isLoopbackUrl("http://localhost:1234")).toBe(true);
    expect(isLoopbackUrl("http://192.168.1.5:11434/v1")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
  it("detects a model server answering on a LAN address", async () => {
    const hit = await exposedOnLan("http://127.0.0.1:11434/v1", ["10.0.0.5", "10.0.0.6"], async (url) => url.startsWith("http://10.0.0.6:11434/v1/models"));
    expect(hit).toBe("10.0.0.6");
    expect(await exposedOnLan("http://127.0.0.1:11434/v1", ["10.0.0.5"], async () => false)).toBeNull();
  });
  it("never tells the tool to download automatically and never invents a tag", () => {
    const text = installGuidance("ollama", true).join("\n");
    expect(text).toContain("ollama pull <tag>");
    expect(text).toContain("does not guess the tag");
    expect(installGuidance("none", false).join("\n")).toMatch(/will not install system software/);
  });
});
