"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { CLUSTER } from "@/lib/solana/config";

/** Wallet state only exists in the browser; render a placeholder until mounted to avoid hydration mismatch. */
function WalletButton() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-10 w-36 animate-pulse rounded-lg bg-ink-800" />;
  return <WalletMultiButton />;
}

const NAV = [
  { href: "/", label: "Marketplace" },
  { href: "/simulator", label: "Distribution simulator" },
  { href: "/transparency", label: "On-chain records" },
  { href: "/about", label: "How it works" },
];

export function Header() {
  const path = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-ink-700 bg-ink-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-3">
        <Link href="/" className="flex items-center gap-2">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent font-black text-ink-950">C</span>
          <span className="text-lg font-bold tracking-tight">
            Compute<span className="text-accent">RWA</span>
          </span>
          <span className="badge bg-amber-400/15 text-amber-300">{CLUSTER} · demo</span>
        </Link>
        <nav className="order-3 flex w-full gap-1 overflow-x-auto text-sm md:order-2 md:w-auto">
          {NAV.map((n) => {
            const active = n.href === "/" ? path === "/" || path.startsWith("/pools") : path.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                className={`whitespace-nowrap rounded-lg px-3 py-1.5 ${active ? "bg-ink-800 text-white" : "text-slate-400 hover:text-white"}`}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
        <div className="order-2 md:order-3">
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
