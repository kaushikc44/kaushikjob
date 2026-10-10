/** Entry point: `npm run gateway` (reads env; see gateway/.env.example). */
import { ConfigError, loadConfig } from "./config";
import { createGateway } from "./server";

try {
  const config = loadConfig();
  const { server, ledger } = createGateway(config);
  if (ledger.skippedLines) console.warn(`[gateway] skipped ${ledger.skippedLines} unreadable ledger line(s)`);
  server.listen(config.port, config.host, () => {
    console.log(`[gateway] listening on http://${config.host}:${config.port} → model "${config.publicModelId}" (upstream not logged)`);
    if (config.host !== "127.0.0.1" && config.host !== "localhost") {
      console.warn("[gateway] bound to a non-loopback address — make sure only the gateway (not the model server) is reachable from outside.");
    }
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
} catch (e) {
  console.error(e instanceof ConfigError ? `[gateway] config error: ${e.message}` : e);
  process.exit(1);
}
