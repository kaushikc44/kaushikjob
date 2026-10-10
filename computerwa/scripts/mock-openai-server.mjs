// MOCK model server for local testing when the Mac mini is not available.
// Speaks the OpenAI /v1 chat-completions shape with canned output. It is NOT Gemma:
// run the gateway with UPSTREAM_MODEL=mock-model PUBLIC_MODEL_ID=mock-model so nothing is mislabelled.
//   node scripts/mock-openai-server.mjs [port]   (default 11500, binds 127.0.0.1)
import { createServer } from "node:http";

const port = Number(process.argv[2] || 11500);
createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/v1/models") {
      return res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
    }
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = JSON.parse(raw || "{}");
      const prompt = (body.messages ?? []).map((m) => m.content).join(" ");
      const words = Math.min(body.max_tokens ?? 32, 24);
      const content = Array.from({ length: words }, (_, i) => `mock${i}`).join(" ");
      setTimeout(() => {
        res.end(
          JSON.stringify({
            id: `chatcmpl-mock-${Date.now()}`,
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: "mock-model",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: words, total_tokens: Math.ceil(prompt.length / 4) + words },
          }),
        );
      }, 120 + Math.random() * 200);
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
}).listen(port, "127.0.0.1", () => console.log(`[mock-model] MOCK OpenAI-compatible server on http://127.0.0.1:${port}/v1`));
