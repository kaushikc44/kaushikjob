/** Secret redaction applied to everything the tooling prints or writes to reports. */

const KEY_RE = /crwa_[0-9a-f]{8}_[A-Za-z0-9_-]{43}/g;

export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text.replace(KEY_RE, "crwa_[redacted]");
  for (const s of extraSecrets) {
    if (s && s.length >= 8) out = out.split(s).join("[redacted]");
  }
  return out;
}

export function redactDeep<T>(value: T, extraSecrets: string[] = []): T {
  return JSON.parse(redact(JSON.stringify(value), extraSecrets)) as T;
}

/** Values of env vars that are secrets, for use as `extraSecrets`. */
export function secretValuesFromEnv(env: Record<string, string | undefined>): string[] {
  const names = ["INFERENCE_GATEWAY_READ_KEY", "UPSTREAM_API_KEY"];
  return names.map((n) => env[n] ?? "").filter((v) => v.length >= 8);
}
