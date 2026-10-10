import type { Metadata } from "next";
import "./globals.css";
import { WalletProviders } from "@/components/WalletProviders";
import { Header } from "@/components/Header";
import { DemoBanner } from "@/components/Disclaimer";

export const metadata: Metadata = {
  title: "ComputeRWA — transparent AI compute asset pools (demo)",
  description:
    "Hackathon prototype: inspect GPU asset pools, their financial performance, devnet test tokens and simulated distributions.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>
          <DemoBanner />
          <Header />
          <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
          <footer className="mx-auto max-w-7xl px-4 pb-10 pt-4 text-xs text-slate-500">
            ComputeRWA prototype · Solana devnet only · Fictional data · No legal ownership, custody, compliance or yield is
            established or implied.
          </footer>
        </WalletProviders>
      </body>
    </html>
  );
}
