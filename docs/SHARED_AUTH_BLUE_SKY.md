# P2P workbooks — blue-sky prospectus

**Status:** thinking-out-loud, deliberately ambitious. Companion to
`SHARED_AUTH_PROSPECTUS.md`, which is the practical version. This one is
asking "if we go all the way, what becomes possible that's genuinely
impossible today?"

## The frame I want to start with

Most "collaboration" software is really *coordination* software with a
shared database in the middle. Google Docs, Notion, Figma, Snowflake,
Salesforce — all of them work because every party trusts a central
operator to hold the data and arbitrate access. That trusted middle is so
load-bearing that we don't see it anymore. It's just how software works.

But the trusted middle is the source of three enterprise pain points that
nobody has actually solved — they've only been priced.

1. **You can't collaborate with someone who doesn't trust the same
   middle.** Walmart and P&G can collaborate in Snowflake because they
   both trust Snowflake. Walmart and a regional supplier who can't afford
   Snowflake? They email CSVs.
2. **The middle sees everything.** The whole reason data clean rooms,
   confidential computing, and MPC exist is that "trust the operator" is
   not an acceptable answer for some collaborations — M&A, regulators,
   competitors, sovereign data, AI evaluation.
3. **The middle is a subpoena target, a breach surface, and a
   geopolitical liability.** GDPR, Schrems II, ITAR, CMMC, China data
   localization — these regimes exist because someone in a courtroom or
   parliament finally noticed that all the data lives in one place.

Removing the middle — really removing it, not pretending — is the
blue-sky move. P2P workbooks are a way to do that without asking
enterprises to adopt blockchain, run their own infrastructure, or learn
homomorphic encryption.

## The pain point that doesn't exist today (because nobody can solve it)

Pick any pair of companies in a real-world business relationship. Pick
the most sensitive thing they could usefully analyze together. Examples:

- A bank and its prospective acquirer want to model the merged loan book
  before announcing the deal.
- A manufacturer and a Tier-2 supplier want to forecast demand together
  without either revealing margins.
- A pharma sponsor and a CRO want to compare interim trial results
  without unblinding.
- An insurer and a reinsurer want to price a treaty against the actual
  policy book, not a summary.
- A model vendor and a regulated customer want to evaluate the model on
  the customer's real production data.
- A defense prime and an allied-nation subcontractor want to run joint
  mission analysis on ITAR-controlled data.

In every one of these, the collaboration is *worth doing* — there's real
value on the table. And in every one, the collaboration today happens
via one of four bad options:

1. **One side trusts the other.** Send the data, hope it doesn't leak,
   sign an NDA whose enforcement mechanism is "we'll sue you after the
   fact."
2. **Both sides trust a third party.** Stand up a Snowflake clean room,
   an AWS Clean Room, a Habu deployment. Six-figure annual contracts,
   eight weeks of integration, and the third party can still see
   everything if subpoenaed.
3. **Neither side trusts anyone, so they don't collaborate.** This is
   the dark matter of enterprise — the analyses that *should* happen but
   don't, because the trust cost exceeds the analytical value. Nobody
   measures it because there's no artifact to measure.
4. **They hire McKinsey.** Consultants are a human-shaped trusted middle
   with malpractice insurance and an NDA. Slow, expensive, and the
   consultant ends up with the merged dataset on their laptop anyway.

The pain point: **there is no lightweight way for two organizations to
do confidential joint analysis.** Heavyweight ways exist; the spectrum
between "send a CSV" and "deploy a clean room" is empty. That gap is
where most cross-org analysis lives, and it's currently filled with
emailed spreadsheets and prayer.

## The blue-sky proposal: workbooks as ephemeral computational meshes

Push every property of P2P workbooks to the limit and you get something
that doesn't have a name yet. Try this framing:

> A workbook is not a file. It is a meeting place where code and data
> from different parties briefly converge to compute, then disperse,
> leaving only the outputs that policy permitted.

What that actually means in mechanism:

- **Code and data have provenance.** A workbook block is a signed unit:
  "this transform was contributed by alice@bank-a.com." A dataset
  reference is signed: "this column lives on bob@bank-b.com's machine
  and is governed by policy P." The author of the workbook composes
  these pieces; they can't see inside them.
- **Computation happens where the data is.** When the workbook needs to
  join Bank A's loan book to Bank B's deposit book, the join doesn't
  happen at a central server. Bank A's daemon sends the join key and
  the aggregation function to Bank B's daemon. Bank B computes locally,
  returns only the result. The raw rows never leave Bank B's machine.
- **Policy is mechanical, not contractual.** "Bob can see aggregates
  with k≥50, never raw rows" is enforced by Bank B's daemon refusing to
  emit anything else. Not "we promise" — actually impossible. The
  workbook *cannot* compute the disallowed thing because the data isn't
  in a place where it can be computed.
- **The session is the artifact.** When everyone closes the workbook,
  the mesh dissolves. No central server held the merged state. The
  workbook file each party keeps contains their own contributions plus
  the policy-allowed outputs of the joint computation. There is no
  third copy.
- **Audit is built in.** Every contribution, every computation, every
  output is signed and logged in a CRDT that all participants share.
  The audit log can be reconstructed years later from any participant's
  copy.

This is qualitatively different from anything that exists. It's not a
file format, not a SaaS, not a clean room. It's a *protocol for
ephemeral confidential computation*, and the workbook is its UI.

## Why P2P is load-bearing here, not a tech aesthetic

You could imagine doing all of the above with a central operator (us)
that holds the orchestration logic and just promises not to look at the
data. Many companies do exactly this — Habu, LiveRamp, AWS Clean Rooms.
The problem is that "promises not to look" doesn't survive three
specific stress tests that enterprises actually apply:

1. **Subpoena.** A regulator asks the central operator for the data.
   The operator complies, because it has to. The participants find out
   from the news.
2. **Breach.** The central operator gets compromised. Every clean-room
   tenant's data is now in the breach. (This has happened.)
3. **Geopolitics.** The central operator is in jurisdiction X. Customer
   is in jurisdiction Y. CFIUS, GDPR adequacy, Chinese cybersecurity
   law, ITAR — pick your acronym, the operator becomes the problem.

P2P removes the central operator from the data path entirely. The key
broker still exists (someone has to verify SSO and release the wrapping
key), but the *contents* never traverse the broker. We can be subpoenaed
all day; we don't have anything to give. We can be breached; the breach
yields key metadata, not loan books. We can be in California while our
customers are in Frankfurt and Singapore; we never held their data.

This isn't a marketing claim — it's an architectural property that's
provable. "Cannot comply" is a stronger guarantee than "promises not
to," and enterprises in regulated industries know the difference.

## Three concrete enterprise scenarios, fully drawn

### Scenario 1: M&A diligence room

Today, a $500M acquisition involves uploading 40 GB of target company
documents and data extracts to Datasite or Intralinks. The VDR vendor
sees everything. Bidders' analysts download files to their laptops.
Half the deal team's data ends up in personal Dropbox accounts. The
seller has no real-time visibility into what was accessed; the bidders
have no guarantee the seller didn't pull access mid-bid.

In a P2P workbook world: the seller publishes a workbook per topic
(financials, customer concentration, IP, HR). Each workbook has policy
"bidders in IdP group `project-aurora-bidders`, expires day-of-bid."
Bidders open the workbook on their analysts' machines via their own
SSO. Computations (cohort analysis, sensitivity modeling) run locally;
underlying rows are referenced via signed pointers back to the seller's
daemon, which serves them on policy-checked request. When the bid
window closes, the seller revokes the IdP group. Every bidder copy
becomes a brick. Audit log shows exactly who accessed what, when,
reconstructible from either side's logs.

What this replaces: a $50K-$200K VDR contract, a 6-week setup, and the
inherent leak of "we have to give the bidders the data."

### Scenario 2: Federated AI evaluation

A bank is considering buying an AI model from a vendor for fraud
detection. The bank cannot send their transaction data to the vendor
(regulatory). The vendor cannot send their model to the bank (it's
their entire business). Today: the deal happens via the vendor running
the model on a synthetic dataset the bank constructs, which is
expensive to produce and produces evaluation results everyone knows
are unreliable.

P2P workbook: the vendor publishes a "model evaluation workbook" that
contains the model as a signed binary blob, runnable but not
extractable, executing in a sandboxed WASM runtime on the bank's
machine. The workbook also contains evaluation harness code (precision/
recall/F1 across cohorts) authored jointly. The bank opens the workbook
behind their firewall, points it at production data via local file
references, runs the evaluation. The vendor sees the metrics; the bank
sees the model's behavior. Neither sees the other's contribution.

What this enables that's currently impossible: every regulated
industry's AI procurement, which is currently stuck in a synthetic-
data-evaluation purgatory that everyone knows is broken.

### Scenario 3: Supply chain forecasting consortium

Five Tier-1 suppliers all sell to the same auto OEM. They'd benefit
from sharing demand signals to manage inventory — but they're
competitors. Today: they don't, and the bullwhip effect costs them
collectively 10-15% of revenue in over/understock.

P2P workbook: the OEM publishes a forecasting workbook. Each supplier
contributes their forward order book as a signed dataset reference.
The workbook computes only aggregate signals — total orders by
component category, week-over-week deltas — and returns them to all
participants. No supplier ever sees another supplier's order book. The
OEM sees the aggregates but not who contributed what. Aggregation
floors enforce k-anonymity.

What this replaces: a "supply chain visibility platform" that costs
$2M/year and that nobody actually trusts because it requires sending
raw data to a third party.

## What this means for AI agents (the second-order effect)

Every enterprise is currently building AI agents that can only operate
inside their own perimeter. The agent can read your CRM, write to your
database, file your tickets. It cannot do anything that crosses an
organizational boundary, because there's no protocol for cross-org
agent action that doesn't require one company to host the other's
agent.

A P2P workbook is *exactly* such a protocol. Two agents from two
companies can meet inside a workbook, exchange messages and signed
data references, run computations against each other's data under
policy, and produce a joint output — all without either company hosting
the other's code or seeing the other's data. The workbook is the
substrate; the agents are participants.

Concrete near-future scenario: my procurement agent meets your sales
agent in a workbook. Mine has my requirements and budget signed by my
CFO; yours has your inventory and pricing signed by your CRO. They
negotiate, generate a contract draft, and present it to both humans.
Neither company exposed an API; neither agent left its home perimeter.
The workbook is the meeting room.

This is probably the largest blue-sky payoff. As agents proliferate, the
question of *how agents from different organizations interact safely*
becomes urgent. Today the answers are "they don't" or "via a shared SaaS
that hosts both." A P2P artifact substrate is a third answer that
doesn't require either party to give up sovereignty.

## What's hard about this — really hard

- **Computing on data you can't see is genuinely difficult.** Not all
  computations decompose into "you compute locally, send me the
  aggregate." Joins, ML training, ranking — these need either a real
  cryptographic technique (MPC, homomorphic encryption, TEEs) or
  careful protocol design that limits what's expressible. We can punt
  on this for v1 by only supporting the easy cases (filter + aggregate +
  group-by) but we should be honest that the full vision needs
  cryptographic muscle we don't currently have.
- **Trusted execution environments are the pragmatic shortcut.** A WASM
  sandbox is not a TEE. To actually claim "the model runs on the
  bank's data and the vendor cannot extract weights," we need Intel SGX
  / AMD SEV-SNP / Apple Silicon Secure Enclave-backed attestation. This
  is real engineering, not a weekend project.
- **Policy languages are a tarpit.** "Aggregate with k≥50" is easy to
  state, easy to enforce. "Don't compute anything that, when combined
  with public data, would re-identify an individual" is undecidable.
  Pick your battles; ship the easy primitives, let users compose them,
  do not try to invent a general-purpose privacy DSL.
- **Discovery and rendezvous in P2P at enterprise scale is unsolved
  for the niche we're entering.** Iroh handles the technical layer;
  the *organizational* discovery problem ("how does Bank A find Bank
  B's daemon when both are behind corporate firewalls and Zscaler
  proxies?") needs design work that is not just a NAT problem.
- **This sounds like blockchain to procurement officers.** It isn't,
  but the overlap in vocabulary will be a perpetual sales hazard. Every
  pitch needs a "we are not blockchain, here's why" slide.
- **The market for "the thing that doesn't exist today" is by
  definition unmeasurable.** Nobody has a budget line for "confidential
  cross-org analysis we currently don't do." The first sales cycles
  will be replacement sales (eat the clean-room budget) before they
  become creation sales (unlock collaborations that didn't happen).

## What "winning" looks like

If this works, in five years the sentence "they have to be on the same
platform to collaborate" sounds as dated as "they have to use the same
operating system to exchange documents." Cross-organizational analysis
becomes a casual operation — the verb is "send a workbook" the way the
verb today is "send an email." The data clean room category collapses
into a feature of every enterprise workbook tool. Companies that today
don't collaborate because the trust cost exceeds the value start
collaborating, and most of them are doing things that nobody currently
sees because the artifact didn't exist.

The downstream effect: a generation of agentic software that operates
across organizational boundaries by default, because the substrate for
cross-org computation already exists.

## What I'd build first to test the hypothesis

The fastest way to find out if this vision is real is to pick the
narrowest possible enterprise scenario where the pain is sharpest and
ship something embarrassingly minimal. My nominee: **the federated AI
evaluation workbook.** Specifically:

- One model vendor + one regulated customer.
- Workbook runs the vendor's model in WASM on the customer's data.
- Outputs metrics to both parties' copies.
- No real cryptographic guarantees yet — just policy + sandboxing +
  audit log. Be explicit about the trust model.
- Sell it for $50K to one bank and one model vendor, where today the
  alternative is six months of legal review.

If two companies will pay for that thin wedge, the broader vision has
legs. If they won't, the broader vision is a daydream and we should
focus on the practical Phase A in the other prospectus.

The blue-sky version and the practical version are not in tension —
the blue-sky version is what the practical version becomes if the
market pulls hard enough.
