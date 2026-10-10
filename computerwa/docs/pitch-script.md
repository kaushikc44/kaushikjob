# Three-minute pitch script

**[0:00–0:25] Hook**
"Every AI answer you get runs on a GPU someone had to pay for. A single rack of H100s costs about two million dollars, and the people financing that hardware mostly get a quarterly PDF. They can't see the machines, the utilisation or where the revenue went. ComputeRWA fixes the visibility part."

**[0:25–0:55] Problem**
"Whether a GPU pool produces cash for its financiers comes down to three numbers: how busy the GPUs are, what power and colocation cost, and how much has to be set aside to replace failing parts. Today those numbers sit in operator spreadsheets. Investors can't reconcile usage to revenue to distributions, so capital is expensive, or it never shows up."

**[0:55–1:50] Demo**
"Here's our marketplace: three GPU pools. All of this data is fictional for the hackathon, and we label it everywhere. Let's open the Sydney H100 pool. This chart shows where every dollar of revenue went: operating costs, the maintenance reserve, and what's left to distribute. The formula inspector shows the exact calculation for any month.
Now the on-chain part. I connect a devnet wallet and register the pool. That writes a Solana record containing a hash of this pool's accounting data. See the badge: *matches*. If anyone quietly edits a revenue number, it flips to *changed*. Next I mint test tokens representing demo interests. The same transaction records that they carry no rights. Then I send some to two other holders.
In the simulator, those balances are read live from chain: 65, 25 and 10 percent. If I cut revenue by 40 percent, costs and reserve exceed revenue, distributable cash is zero, and nobody gets an allocation. The maths doesn't hide bad months."

**[1:50–2:25] Why us / why it's credible**
"We keep what the chain can prove, like signatures, supply, holders and the data hash, separate from what an operator merely reports. The financial engine works in integer cents and is unit-tested for losses, rounding and edge cases. And we never show a promised yield. We show how cash flow *would* be allocated."

**[2:25–3:00] Roadmap and close**
"Next: an on-chain registry co-signed by operators and auditors, usage attestations straight from inference gateways, and a proper legal and compliance review before any real economic rights exist. AI compute is becoming infrastructure, and infrastructure finance runs on trust you can verify. ComputeRWA is that verification layer. Thank you."
