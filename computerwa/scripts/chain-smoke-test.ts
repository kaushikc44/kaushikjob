/**
 * End-to-end check of the on-chain flow against a local validator or devnet
 * using a throwaway Keypair (generated here, never saved).
 *
 *   solana-test-validator --reset --quiet &        # or use devnet
 *   SOLANA_RPC=http://127.0.0.1:8899 npm run e2e:chain
 */
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import seed from "../src/data/pools.json";
import type { SeedFile } from "../src/lib/types";
import {
  assertNotMainnet,
  createDemoMint,
  distributeDemoTokens,
  findRecords,
  readMintState,
  registerPool,
  requestDevnetAirdrop,
  type TxSigner,
} from "../src/lib/solana/chain";
import { assertNotMainnetEndpoint } from "../src/lib/solana/config";
import { poolDataHash } from "../src/lib/solana/records";
import { allocateToHolders, computeDistribution, formatUsd } from "../src/lib/finance";

async function main() {
  const rpc = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
  assertNotMainnetEndpoint(rpc);
  const connection = new Connection(rpc, "confirmed");
  const kp = Keypair.generate();
  const signer: TxSigner = {
    publicKey: kp.publicKey,
    signTransaction: async <T extends Transaction>(tx: T) => {
      tx.partialSign(kp);
      return tx;
    },
  };
  const pool = (seed as SeedFile).pools[0];
  const step = (s: string) => console.log(`\n▶ ${s}`);

  step(`genesis check on ${rpc}`);
  console.log("  genesis:", await assertNotMainnet(connection));

  step("airdrop 2 SOL to throwaway wallet " + kp.publicKey.toBase58());
  console.log("  sig:", await requestDevnetAirdrop(connection, kp.publicKey, 2));

  step("register pool record (memo)");
  const dataHash = await poolDataHash(pool);
  const regSig = await registerPool(connection, signer, { poolId: pool.id, gpuModel: pool.gpuModel, units: pool.units, dataHash });
  console.log("  sig:", regSig, "\n  dataHash:", dataHash);

  step(`create test mint with supply ${pool.tokenSupply}`);
  const { signature: mintSig, mint } = await createDemoMint(connection, signer, { poolId: pool.id, supply: BigInt(pool.tokenSupply) });
  console.log("  sig:", mintSig, "\n  mint:", mint.toBase58());

  step("distribute test tokens to 2 throwaway holders");
  const a = Keypair.generate().publicKey.toBase58();
  const b = Keypair.generate().publicKey.toBase58();
  const distSig = await distributeDemoTokens(connection, signer, {
    poolId: pool.id,
    mint,
    recipients: [
      { address: a, amount: 250_000n },
      { address: b, amount: 100_000n },
    ],
  });
  console.log("  sig:", distSig);

  step("read mint state back from chain");
  const state = await readMintState(connection, mint.toBase58());
  console.log("  supply:", state.supply.toString(), "decimals:", state.decimals, "mintAuthority:", state.mintAuthority);
  state.holders.forEach((h) => console.log("  holder", h.owner, h.balance.toString()));
  if (state.supply !== BigInt(pool.tokenSupply)) throw new Error("supply mismatch");
  if (state.holders.length !== 3) throw new Error(`expected 3 holders, got ${state.holders.length}`);

  step("rediscover records from wallet history");
  const recs = await findRecords(connection, kp.publicKey);
  recs.forEach((r) => console.log("  ", r.record.t, r.signature.slice(0, 16) + "…"));
  const types = new Set(recs.map((r) => r.record.t));
  for (const t of ["pool-registration", "demo-token-mint", "demo-token-transfer"]) {
    if (!types.has(t as never)) throw new Error(`record ${t} not found`);
  }

  step("simulate allocation for latest month using on-chain balances");
  const m = pool.months.at(-1)!;
  const opex = Object.values(m.opex).reduce((x, y) => x + y, 0);
  const dist = computeDistribution({ revenue: m.revenue, operatingExpenses: opex, reserve: m.reserve, holderSharePct: pool.holderSharePct });
  const alloc = allocateToHolders(dist.holderPoolCents, state.holders.map((h) => ({ address: h.owner, balance: h.balance })), state.supply);
  console.log("  holder pool:", formatUsd(dist.holderPoolCents));
  alloc.allocations.forEach((x) => console.log("  ", x.address.slice(0, 8), `${x.sharePct}%`, formatUsd(x.allocationCents)));

  console.log("\n✅ chain smoke test passed");
}

main().catch((e) => {
  console.error("\n❌", e);
  process.exit(1);
});
