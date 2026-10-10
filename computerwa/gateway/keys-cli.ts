/**
 * Manage gateway API keys. The full key is printed once on creation and never stored.
 *   npm run gateway:keys -- create <name> [--scopes inference,usage:read] [--rpm 30]
 *   npm run gateway:keys -- list
 *   npm run gateway:keys -- revoke <id>
 */
import { KeyStore, type Scope } from "./keys";

const store = new KeyStore(process.env.GATEWAY_KEYS_FILE || "gateway-data/keys.json");
const [cmd, ...args] = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (cmd === "create") {
  const name = args.find((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
  if (!name) throw new Error("usage: create <name> [--scopes inference,usage:read] [--rpm N]");
  const scopes = (flag("--scopes") ?? "inference").split(",").map((s) => s.trim()) as Scope[];
  const rpm = flag("--rpm") ? Number(flag("--rpm")) : undefined;
  const { key, stored } = store.create(name, scopes, rpm);
  console.log(`Created key ${stored.id} (${stored.name}) scopes=${stored.scopes.join(",")}`);
  console.log(`\n  ${key}\n`);
  console.log("Store it now — only its hash is saved, it cannot be shown again.");
} else if (cmd === "list") {
  for (const k of store.list()) {
    console.log(`${k.id}  ${k.name.padEnd(20)} ${k.scopes.join(",").padEnd(22)} created ${k.createdAt}${k.revokedAt ? `  REVOKED ${k.revokedAt}` : ""}`);
  }
} else if (cmd === "revoke") {
  console.log(store.revoke(args[0] ?? "") ? `Revoked ${args[0]}` : "No active key with that id");
} else {
  console.log("usage: create <name> [--scopes inference,usage:read] [--rpm N] | list | revoke <id>");
  process.exit(1);
}
