import { LiveInference } from "@/components/LiveInference";

export const metadata = { title: "Live inference · ComputeRWA (demo)" };

export default function InferencePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold text-white">Live inference: Mac mini gateway</h1>
        <p className="mt-1 max-w-3xl text-slate-300">
          Real usage from a free, authenticated inference API served by a single Mac mini (intended model: Gemma 4; the model actually served is shown below). Request counts, latency and token
          counts are <strong>measured</strong>. Operating cost is an <strong>estimate</strong> from stated assumptions. Customer
          revenue is <strong>$0</strong> because the API is free and no payments are recorded.
        </p>
      </div>
      <LiveInference />
    </div>
  );
}
