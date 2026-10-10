export function DemoBanner() {
  return (
    <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-200">
      <strong>Hackathon prototype.</strong> All asset, revenue and cost data is fictional. Test tokens on Solana devnet carry{" "}
      <strong>no ownership, redemption or payment rights</strong>. Nothing here is an offer, investment advice or a promise of yield.
    </div>
  );
}

export function OffChainNote({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-xs text-slate-400">
      <span className="badge mr-1 bg-slate-500/20 text-slate-300">off-chain input</span>
      {children ?? "Operator-reported demo figures. Not independently verified."}
    </p>
  );
}
