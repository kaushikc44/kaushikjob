/** Cluster configuration. This prototype refuses to run against mainnet. */

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

export type Cluster = "devnet" | "localnet";

export const RPC_ENDPOINT = process.env.NEXT_PUBLIC_SOLANA_RPC || "https://api.devnet.solana.com";
export const CLUSTER: Cluster = process.env.NEXT_PUBLIC_SOLANA_CLUSTER === "localnet" ? "localnet" : "devnet";
export const BURNER_ENABLED = process.env.NEXT_PUBLIC_ENABLE_BURNER_WALLET === "true";

/** Throws if an endpoint string looks like mainnet. A genesis-hash check also runs at connect time. */
export function assertNotMainnetEndpoint(endpoint: string): void {
  if (/mainnet/i.test(endpoint)) {
    throw new Error("ComputeRWA is a devnet-only prototype. Mainnet RPC endpoints are not allowed.");
  }
}

export function explorerTxUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}${clusterQuery()}`;
}

export function explorerAddressUrl(address: string): string {
  return `https://explorer.solana.com/address/${address}${clusterQuery()}`;
}

function clusterQuery(): string {
  if (CLUSTER === "localnet") return `?cluster=custom&customUrl=${encodeURIComponent(RPC_ENDPOINT)}`;
  return "?cluster=devnet";
}
