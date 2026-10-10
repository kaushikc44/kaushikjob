import { TransparencyBoard } from "@/components/TransparencyBoard";

export const metadata = { title: "On-chain records · ComputeRWA (demo)" };

export default function TransparencyPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">On-chain records vs off-chain inputs</h1>
        <p className="mt-1 max-w-3xl text-slate-300">
          Each pool separates what Solana can prove (signatures, mint, supply, balances, committed data hash) from what an
          operator merely reports (revenue, costs, utilisation). A matching hash proves the off-chain file has not changed
          since it was registered. It does <strong>not</strong> prove that the figures are true.
        </p>
      </div>
      <TransparencyBoard />
    </div>
  );
}
