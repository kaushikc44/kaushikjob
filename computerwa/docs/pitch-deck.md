# ComputeRWA: five-slide pitch deck (content)

## Slide 1: The problem
**AI inference needs billions in GPUs, and the capital behind them can't see what it's financing.**
- A single 64× H100 pool is about $2M of hardware that depreciates within 3–5 years.
- Investors get quarterly PDFs: no unit-level asset records, no reconciliation from usage to revenue to cash.
- Utilisation, power and maintenance costs decide whether there is *any* cash to distribute, and they are the least visible numbers.

## Slide 2: ComputeRWA
**A transparency and financing layer for AI compute infrastructure.**
- Each GPU pool has an identifiable asset record: model, units, serials, location, acquisition cost.
- Monthly revenue, operating costs and maintenance reserves reconcile into **distributable cash** with a formula anyone can inspect.
- Economic interests are represented as SPL tokens, and the allocation per holder is computed from on-chain balances.
- *Prototype: fictional data, devnet test tokens with no rights.*

## Slide 3: How it works (demo)
1. **Inspect** the pool: charts, monthly P&L, ledger, formula inspector.
2. **Register**: a Solana memo commits to the SHA-256 of the off-chain accounting record. If anyone edits the numbers, the hash stops matching.
3. **Tokenise**: one atomic transaction creates the mint, mints the supply and records a no-rights notice.
4. **Simulate**: stress revenue and opex and watch holder allocations update from live on-chain balances.

## Slide 4: Why it's credible
- **On-chain facts are kept separate from off-chain claims.** Signatures, mint, supply, holders and the data hash are verifiable. Revenue is labelled *reported, unverified*.
- **Conservative maths:** integer cents, reserves before distributions, a zero floor, explicit shortfall, exact-sum rounding. Unit-tested across edge cases.
- **No promised yield:** the product shows how cash flow *would* be allocated, never what anyone will earn.
- Built on existing SPL programs only. No custom contract risk in the MVP.

## Slide 5: Roadmap and ask
- **Next:** Anchor registry with operator and auditor co-signatures; metered usage attestations from inference gateways; signed monthly statements anchored on-chain.
- **Then:** legal wrapper and compliance review **before** any real economic rights are offered.
- **Ask:** pilot operators with real GPU fleets willing to share anonymised utilisation and cost data, plus feedback from infrastructure investors on which disclosures they'd need.
