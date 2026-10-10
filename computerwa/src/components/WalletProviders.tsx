"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { UnsafeBurnerWalletAdapter } from "@solana/wallet-adapter-unsafe-burner";
import { assertNotMainnetEndpoint, BURNER_ENABLED, RPC_ENDPOINT } from "@/lib/solana/config";
import "@solana/wallet-adapter-react-ui/styles.css";

assertNotMainnetEndpoint(RPC_ENDPOINT);

export function WalletProviders({ children }: { children: ReactNode }) {
  // Phantom, Solflare, Backpack etc. are auto-detected via the Wallet Standard.
  // The burner wallet (in-memory throwaway key) is opt-in for demos/tests only.
  const wallets = useMemo(() => (BURNER_ENABLED ? [new UnsafeBurnerWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={RPC_ENDPOINT} config={{ commitment: "confirmed" }}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
