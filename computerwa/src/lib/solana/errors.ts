/** Turn wallet/RPC errors into actionable messages. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/user rejected|rejected the request|declined/i.test(msg)) return "You rejected the request in your wallet.";
  if (/prior credit|insufficient (funds|lamports)|0x1\b/i.test(msg))
    return "Not enough devnet SOL to pay fees/rent. Use “Airdrop devnet SOL” or https://faucet.solana.com.";
  if (/429|too many requests|airdrop.*limit|faucet has run dry/i.test(msg))
    return "The devnet faucet is rate-limited right now. Try again later or use https://faucet.solana.com.";
  if (/blockhash not found|block height exceeded|expired/i.test(msg)) return "Transaction expired before confirmation. Please retry.";
  if (/failed to fetch|network|ECONNREFUSED/i.test(msg)) return "Could not reach the Solana RPC endpoint. Check your connection or RPC setting.";
  if (/does not support signTransaction|signTransaction/i.test(msg)) return "This wallet cannot sign transactions for this app.";
  return msg;
}
