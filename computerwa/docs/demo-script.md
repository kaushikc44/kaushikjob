# Technical demonstration script (about 5 minutes)

**Setup (before the demo)**
- `npm run build && npm start` (or the Vercel URL). Wallet on **devnet** with at least 0.1 SOL (fund it in advance, because the faucet can rate-limit).
- If you have no extension wallet: build with `NEXT_PUBLIC_ENABLE_BURNER_WALLET=true` and choose "Burner Wallet".
- Have Solana Explorer (devnet) open in a second tab.

| Time | Action | Talking point |
|---|---|---|
| 0:00 | `/` marketplace | 3 pools; the banner and "Fictional demo data" badges; latest-month utilisation, revenue and distributable cash. B200 is *Commissioning*. |
| 0:30 | Open H100 pool → revenue chart | Stacked bars = opex + reserve + distributable. Hover a month for exact values. Each chart is labelled *off-chain input*. |
| 1:00 | Formula inspector → choose **Oct 25** | Formula with real numbers substituted; computed in integer cents by `finance.ts`. |
| 1:30 | Ledger → filter **Maintenance** | Component replacements are drawn from the reserve, not from distributable cash. |
| 1:50 | Connect wallet → step 2 **Register pool** | Memo transaction; show the Explorer link and the memo JSON with `dataHash`. Badge: *matches current off-chain record*. |
| 2:40 | Step 3 **Create test token** | One atomic transaction: create mint + ATA + mintTo + no-rights memo. Show mint authority = your wallet, 0 decimals, fixed supply 1,000,000. |
| 3:20 | Step 4 **+ 2 random demo addresses** → **Send** | Holders list now shows 650k / 250k / 100k, read via `getProgramAccounts`. |
| 3:50 | **Simulate a distribution** | Source = on-chain balances at slot N. Allocations sum exactly to the holder pool (largest remainder). |
| 4:20 | Stress −40% revenue (×2) | Shortfall banner; every holder gets $0. Then type a negative revenue to show validation. |
| 4:40 | `/transparency` | On-chain facts vs off-chain inputs for each pool. Optional: edit `pools.json` → *changed since registration*. |

**Fallback if devnet is down or rate-limited:** run `solana-test-validator --reset` locally, start the app with `NEXT_PUBLIC_SOLANA_RPC=http://127.0.0.1:8899 NEXT_PUBLIC_SOLANA_CLUSTER=localnet NEXT_PUBLIC_ENABLE_BURNER_WALLET=true`, and say clearly that you are on a local validator.
