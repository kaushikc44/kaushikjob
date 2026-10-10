/**
 * Solana devnet operations used by the UI and by the Node smoke test.
 * Functions take a minimal `TxSigner`, so they work with a browser wallet
 * (Wallet Adapter) or a local test Keypair. No private keys are ever
 * requested from the user; mint keypairs are generated fresh per mint.
 */
import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  MINT_SIZE,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  APP_TAG,
  type ComputeRwaRecord,
  encodeRecord,
  NO_RIGHTS_NOTICE,
  parseMemoField,
  RECORD_VERSION,
} from "./records";
import { MAINNET_GENESIS_HASH } from "./config";

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
/** Demo tokens use 0 decimals: 1 token = 1 unit of demo interest. */
export const DEMO_DECIMALS = 0;

export interface TxSigner {
  publicKey: PublicKey;
  signTransaction<T extends Transaction>(tx: T): Promise<T>;
}

export function memoInstruction(text: string, signer: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [{ pubkey: signer, isSigner: true, isWritable: false }],
    data: new TextEncoder().encode(text) as Buffer,
  });
}

/** Refuses to operate on mainnet, checked against the genesis hash the RPC reports. */
export async function assertNotMainnet(connection: Connection): Promise<string> {
  const genesis = await connection.getGenesisHash();
  if (genesis === MAINNET_GENESIS_HASH) {
    throw new Error("Connected RPC is Solana mainnet. ComputeRWA only runs on devnet/localnet.");
  }
  return genesis;
}

async function signAndSend(
  connection: Connection,
  signer: TxSigner,
  tx: Transaction,
  extraSigners: Keypair[] = [],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = signer.publicKey;
  if (extraSigners.length) tx.partialSign(...extraSigners);
  const signed = await signer.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
  const res = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(res.value.err)}`);
  return signature;
}

export async function requestDevnetAirdrop(connection: Connection, to: PublicKey, sol = 1): Promise<string> {
  await assertNotMainnet(connection);
  const signature = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  const latest = await connection.getLatestBlockhash("confirmed");
  await connection.confirmTransaction({ signature, ...latest }, "confirmed");
  return signature;
}

export async function registerPool(
  connection: Connection,
  signer: TxSigner,
  params: { poolId: string; gpuModel: string; units: number; dataHash: string },
): Promise<string> {
  await assertNotMainnet(connection);
  const memo = encodeRecord({
    app: APP_TAG,
    v: RECORD_VERSION,
    t: "pool-registration",
    pool: params.poolId,
    gpu: params.gpuModel,
    units: params.units,
    dataHash: params.dataHash,
    demo: true,
  });
  return signAndSend(connection, signer, new Transaction().add(memoInstruction(memo, signer.publicKey)));
}

/**
 * Creates a new SPL mint (0 decimals, mint authority = signer, no freeze
 * authority), creates the signer's associated token account, mints `supply`
 * test tokens to it and writes a memo stating the token carries no rights —
 * all in one atomic transaction.
 */
export async function createDemoMint(
  connection: Connection,
  signer: TxSigner,
  params: { poolId: string; supply: bigint },
): Promise<{ signature: string; mint: PublicKey }> {
  await assertNotMainnet(connection);
  if (params.supply <= 0n) throw new Error("Supply must be positive");
  const mintKp = Keypair.generate();
  const owner = signer.publicKey;
  const ata = getAssociatedTokenAddressSync(mintKp.publicKey, owner);
  const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
  const memo = encodeRecord({
    app: APP_TAG,
    v: RECORD_VERSION,
    t: "demo-token-mint",
    pool: params.poolId,
    mint: mintKp.publicKey.toBase58(),
    supply: params.supply.toString(),
    notice: NO_RIGHTS_NOTICE,
  });
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: owner,
      newAccountPubkey: mintKp.publicKey,
      space: MINT_SIZE,
      lamports: rent,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMint2Instruction(mintKp.publicKey, DEMO_DECIMALS, owner, null),
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, mintKp.publicKey),
    createMintToInstruction(mintKp.publicKey, ata, owner, params.supply),
    memoInstruction(memo, owner),
  );
  const signature = await signAndSend(connection, signer, tx, [mintKp]);
  return { signature, mint: mintKp.publicKey };
}

export interface Recipient {
  address: string;
  amount: bigint;
}

export function parseRecipient(address: string): PublicKey {
  try {
    const pk = new PublicKey(address.trim());
    return pk;
  } catch {
    throw new Error(`Invalid Solana address: ${address}`);
  }
}

/** Transfers test tokens from the signer to up to 8 recipients in one transaction. */
export async function distributeDemoTokens(
  connection: Connection,
  signer: TxSigner,
  params: { poolId: string; mint: PublicKey; recipients: Recipient[] },
): Promise<string> {
  await assertNotMainnet(connection);
  const { recipients, mint } = params;
  if (!recipients.length) throw new Error("Add at least one recipient");
  if (recipients.length > 8) throw new Error("At most 8 recipients per transaction");
  const owner = signer.publicKey;
  const sourceAta = getAssociatedTokenAddressSync(mint, owner);
  const tx = new Transaction();
  for (const r of recipients) {
    if (r.amount <= 0n) throw new Error("Amounts must be positive whole tokens");
    const dest = parseRecipient(r.address);
    const destAta = getAssociatedTokenAddressSync(mint, dest, true);
    tx.add(
      createAssociatedTokenAccountIdempotentInstruction(owner, destAta, dest, mint),
      createTransferCheckedInstruction(sourceAta, mint, destAta, owner, r.amount, DEMO_DECIMALS),
    );
  }
  tx.add(
    memoInstruction(
      encodeRecord({
        app: APP_TAG,
        v: RECORD_VERSION,
        t: "demo-token-transfer",
        pool: params.poolId,
        mint: mint.toBase58(),
        recipients: recipients.length,
        notice: NO_RIGHTS_NOTICE,
      }),
      owner,
    ),
  );
  return signAndSend(connection, signer, tx);
}

export interface MintState {
  mint: string;
  supply: bigint;
  decimals: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  holders: { owner: string; tokenAccount: string; balance: bigint }[];
  slot: number;
  fetchedAt: string;
}

/** Reads mint supply and all token accounts for the mint directly from chain. */
export async function readMintState(connection: Connection, mintAddress: string): Promise<MintState> {
  const mint = parseRecipient(mintAddress);
  const info = await getMint(connection, mint, "confirmed");
  const accounts = await connection.getProgramAccounts(TOKEN_PROGRAM_ID, {
    commitment: "confirmed",
    filters: [{ dataSize: AccountLayout.span }, { memcmp: { offset: 0, bytes: mint.toBase58() } }],
  });
  const holders = accounts
    .map(({ pubkey, account }) => {
      const decoded = AccountLayout.decode(account.data);
      return { owner: new PublicKey(decoded.owner).toBase58(), tokenAccount: pubkey.toBase58(), balance: decoded.amount };
    })
    .filter((h) => h.balance > 0n)
    .sort((a, b) => (b.balance > a.balance ? 1 : b.balance < a.balance ? -1 : a.owner.localeCompare(b.owner)));
  const slot = await connection.getSlot("confirmed");
  return {
    mint: mint.toBase58(),
    supply: info.supply,
    decimals: info.decimals,
    mintAuthority: info.mintAuthority?.toBase58() ?? null,
    freezeAuthority: info.freezeAuthority?.toBase58() ?? null,
    holders,
    slot,
    fetchedAt: new Date().toISOString(),
  };
}

export interface FoundRecord {
  signature: string;
  slot: number;
  blockTime: number | null;
  record: ComputeRwaRecord;
  confirmationStatus?: string | null;
}

/** Rediscovers ComputeRWA records from an address's recent transaction history. */
export async function findRecords(connection: Connection, address: PublicKey, limit = 200): Promise<FoundRecord[]> {
  const sigs = await connection.getSignaturesForAddress(address, { limit }, "confirmed");
  const out: FoundRecord[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    for (const record of parseMemoField(s.memo)) {
      out.push({ signature: s.signature, slot: s.slot, blockTime: s.blockTime ?? null, record, confirmationStatus: s.confirmationStatus });
    }
  }
  return out;
}

export { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID };
