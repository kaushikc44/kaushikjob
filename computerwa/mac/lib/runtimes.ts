/**
 * Discovers OpenAI-compatible model servers on this machine and the model ids
 * they actually serve. Nothing here guesses a model name.
 */

export interface RuntimeCandidate {
  id: "ollama" | "lmstudio" | "llamacpp-or-mlx" | "custom";
  label: string;
  baseUrl: string; // OpenAI-compatible, ends with /v1
}

export const RUNTIME_CANDIDATES: RuntimeCandidate[] = [
  { id: "ollama", label: "Ollama", baseUrl: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", label: "LM Studio", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "llamacpp-or-mlx", label: "llama.cpp server / mlx_lm.server", baseUrl: "http://127.0.0.1:8080/v1" },
];

export interface RuntimeProbe {
  candidate: RuntimeCandidate;
  reachable: boolean;
  models: string[];
  error?: string;
}

export async function probeRuntime(c: RuntimeCandidate, opts: { timeoutMs?: number; fetchImpl?: typeof fetch; apiKey?: string | null } = {}): Promise<RuntimeProbe> {
  const f = opts.fetchImpl ?? fetch;
  try {
    const res = await f(`${c.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {},
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    });
    if (!res.ok) return { candidate: c, reachable: true, models: [], error: `HTTP ${res.status} from /models` };
    const body = (await res.json()) as { data?: { id?: unknown }[] };
    const models = (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string" && id.length > 0);
    return { candidate: c, reachable: true, models };
  } catch {
    return { candidate: c, reachable: false, models: [] };
  }
}

export async function probeAll(candidates: RuntimeCandidate[] = RUNTIME_CANDIDATES, opts: Parameters<typeof probeRuntime>[1] = {}): Promise<RuntimeProbe[]> {
  return Promise.all(candidates.map((c) => probeRuntime(c, opts)));
}

export interface ModelClassification {
  gemma4: string[];
  otherGemma: string[];
  others: string[];
}

/**
 * Name-based only: the weights cannot be verified from an id. "Gemma 4" means
 * the id contains `gemma4`, `gemma-4`, `gemma_4` or `gemma.4` (not a size tag
 * like `gemma3:4b` or `gemma:4b`).
 */
export function classifyModels(ids: string[]): ModelClassification {
  const out: ModelClassification = { gemma4: [], otherGemma: [], others: [] };
  for (const id of ids) {
    if (/gemma[-_.]?4(?![0-9])/i.test(id)) out.gemma4.push(id);
    else if (/gemma/i.test(id)) out.otherGemma.push(id);
    else out.others.push(id);
  }
  return out;
}

/** Only accepts loopback model servers: the raw model port must never be reachable from outside. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, "");
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

/** True if the endpoint answers on a non-loopback interface (i.e. the model server is exposed). */
export async function exposedOnLan(baseUrl: string, lanIps: string[], probe: (url: string) => Promise<boolean>): Promise<string | null> {
  const u = new URL(baseUrl);
  for (const ip of lanIps) {
    const url = `${u.protocol}//${ip}:${u.port || (u.protocol === "https:" ? 443 : 80)}${u.pathname.replace(/\/+$/, "")}/models`;
    if (await probe(url)) return ip;
  }
  return null;
}

export function lanAddresses(ifaces: ReturnType<typeof import("node:os").networkInterfaces>): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}

/** Exact commands to print when no suitable model is installed. Never executed automatically. */
export function installGuidance(runtime: RuntimeCandidate["id"] | "none", haveOllamaCli: boolean): string[] {
  if (runtime === "ollama" || (runtime === "none" && haveOllamaCli)) {
    return [
      "Ollama is running but no Gemma 4 model is installed.",
      "1. Find the exact Gemma 4 tag in the Ollama library (https://ollama.com/library) — this tool does not guess the tag or its download size.",
      "2. Install it yourself:   ollama pull <tag>",
      "   or let setup do it once you have confirmed the tag and size:   npm run mac:setup -- --pull <tag>",
      "3. Re-run:   npm run mac:setup",
    ];
  }
  if (runtime === "none") {
    return [
      "No model server was found on 127.0.0.1 (ports 11434, 1234, 8080).",
      "Install and start one yourself (this tool will not install system software):",
      "  Ollama:     brew install ollama   (or the app from https://ollama.com/download), then `ollama serve` if the app is not running",
      "  LM Studio:  download from https://lmstudio.ai, load the model, enable the local server (keep \"Serve on Local Network\" OFF)",
      "Then install Gemma 4 (see https://ollama.com/library for the tag) and re-run `npm run mac:setup`.",
    ];
  }
  const generic = ["The model server is running but does not list a Gemma 4 model.", "Load Gemma 4 in that runtime, then re-run `npm run mac:setup` (or pass --model <id> if the id does not contain \"gemma4\"/\"gemma-4\")."];
  return haveOllamaCli ? [...generic, "If that server is Ollama:", ...installGuidance("ollama", true).slice(1)] : generic;
}
