export const metadata = { title: "How it works · ComputeRWA (demo)" };

const Box = ({ title, items, tone }: { title: string; items: string[]; tone: "chain" | "off" | "app" }) => {
  const cls =
    tone === "chain" ? "border-sky-500/40 bg-sky-500/5" : tone === "off" ? "border-ink-600 bg-ink-950/60" : "border-accent/40 bg-accent/5";
  return (
    <div className={`rounded-xl border p-4 ${cls}`}>
      <div className="font-semibold text-white">{title}</div>
      <ul className="mt-2 space-y-1 text-sm text-slate-300">
        {items.map((i) => (
          <li key={i}>• {i}</li>
        ))}
      </ul>
    </div>
  );
};

const Arrow = ({ label }: { label: string }) => (
  <div className="flex items-center justify-center py-1 text-xs text-slate-400 md:px-1 md:py-0">
    <span className="md:hidden">↓ {label}</span>
    <span className="hidden text-center md:block">
      {label}
      <br />→
    </span>
  </div>
);

export default function AboutPage() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold text-white">How ComputeRWA works</h1>
        <p className="mt-1 max-w-3xl text-slate-300">
          A transparency and financing layer for AI compute infrastructure. Identifiable hardware is linked to clearly documented
          (demo) economic interests, and inference revenue and expenses are reconciled into auditable distribution calculations.
        </p>
      </div>

      <section className="card">
        <h2 className="mb-4 text-lg font-semibold text-white">Architecture</h2>
        <div className="grid items-stretch gap-2 md:grid-cols-[1fr_auto_1fr_auto_1fr]">
          <Box tone="off" title="Off-chain accounting (seed JSON)" items={["Asset record: GPU model, units, serials", "Monthly revenue, utilisation", "Opex breakdown & reserve", "Ledger of transactions"]} />
          <Arrow label="sha256" />
          <Box tone="app" title="Next.js app (browser)" items={["Finance engine (integer cents, unit-tested)", "Charts, formula inspector, simulator", "Wallet Adapter (Phantom, Solflare…)", "Builds & signs devnet transactions"]} />
          <Arrow label="signed tx / RPC reads" />
          <Box tone="chain" title="Solana devnet" items={["SPL Memo: pool-registration record + data hash", "SPL Token: test mint, supply, holder balances", "Memo: no-rights notice in mint & transfers", "Records rediscovered via signature history"]} />
        </div>
        <p className="mt-4 text-xs text-slate-400">
          No backend, database or custom on-chain program is needed for the demo. Everything on-chain uses audited, already-deployed
          SPL programs.
        </p>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="card">
          <h2 className="mb-2 text-lg font-semibold text-white">What is on-chain (verifiable)</h2>
          <ul className="space-y-1 text-sm text-slate-300">
            <li>• That a wallet published a registration record for a pool, and when (slot / block time)</li>
            <li>• The SHA-256 of the off-chain accounting file at that time</li>
            <li>• The test token mint, its supply, decimals and mint authority</li>
            <li>• Which addresses hold test tokens, and how many</li>
            <li>• Transaction signatures for each step</li>
          </ul>
        </div>
        <div className="card">
          <h2 className="mb-2 text-lg font-semibold text-white">What is off-chain (reported, not verified)</h2>
          <ul className="space-y-1 text-sm text-slate-300">
            <li>• That the GPUs exist, their serials, location and condition</li>
            <li>• Revenue, utilisation, prices and every operating cost</li>
            <li>• Reserve contributions and maintenance spend</li>
            <li>• Any legal relationship between token holders and the hardware (none exists)</li>
          </ul>
        </div>
      </section>

      <section className="card">
        <h2 className="mb-2 text-lg font-semibold text-white">Demo limitations</h2>
        <ul className="space-y-1 text-sm text-slate-300">
          <li>• All operators, assets and financials are fictional. Nothing has been independently verified or audited.</li>
          <li>• Test tokens on devnet have no ownership, redemption, revenue or payment rights. Simulated allocations are not payments.</li>
          <li>• The prototype does not establish legal ownership, custody, regulatory compliance or any yield, fixed or otherwise.</li>
          <li>• Registration records are self-published by whichever wallet signs them; there is no operator or auditor attestation yet.</li>
          <li>• Mainnet is refused (endpoint check + genesis-hash check).</li>
        </ul>
      </section>

      <section className="card">
        <h2 className="mb-2 text-lg font-semibold text-white">Roadmap beyond the hackathon</h2>
        <ul className="space-y-1 text-sm text-slate-300">
          <li>• Anchor program for a pool registry PDA with operator + auditor co-signatures</li>
          <li>• Metered usage attestations from inference gateways, reconciled against invoices</li>
          <li>• Signed monthly statements, with each version&apos;s hash anchored on-chain</li>
          <li>• Legal wrapper and compliance review before any real-world economic rights are offered</li>
        </ul>
      </section>
    </div>
  );
}
