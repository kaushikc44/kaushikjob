import Link from "next/link";

export default function NotFound() {
  return (
    <div className="card mx-auto max-w-lg text-center">
      <h1 className="text-xl font-semibold text-white">Not found</h1>
      <p className="mt-2 text-slate-400">That asset pool does not exist in the demo data set.</p>
      <Link href="/" className="btn-primary mt-4">
        Back to marketplace
      </Link>
    </div>
  );
}
