import { explorerAddressUrl, explorerTxUrl } from "@/lib/solana/config";

export function short(s: string, n = 6) {
  return s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`;
}

export function TxLink({ sig, full }: { sig: string; full?: boolean }) {
  return (
    <a href={explorerTxUrl(sig)} target="_blank" rel="noreferrer" className="mono text-accent hover:underline" title={sig}>
      {full ? sig : short(sig, 8)}
    </a>
  );
}

export function AddressLink({ address, full }: { address: string; full?: boolean }) {
  return (
    <a href={explorerAddressUrl(address)} target="_blank" rel="noreferrer" className="mono text-accent hover:underline" title={address}>
      {full ? address : short(address)}
    </a>
  );
}
