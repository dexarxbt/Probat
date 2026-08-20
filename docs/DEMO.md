# Probat product walkthrough

A concise recording should show one complete idea: a README claim enters as source text and leaves as a receipt whose lineage can be inspected.

## Prepare

```powershell
npm ci
npm run validate
npm run doctor
```

The deterministic suite validates integrity logic; it is not Kane browser evidence. Continue to a fresh run only when `doctor` reports `installed`, `authenticated`, and `runnerReady` as `true`.

Never display `.testmuai/evidence/`, Kane `output-*` directories, credentials, local session metadata, or ignored `data/` records.

## Start both local processes

Terminal one—the application under test:

```powershell
npm run demo
```

Terminal two—Probat:

```powershell
npm run dev
```

Open:

```text
http://127.0.0.1:4310/ui/
```

The UI should show Kane readiness in the top-right status and load any existing local audits.

## Recording flow

### 1. Frame the problem

Open with the sentence:

> A README claim is easy to publish and hard to trust later. Probat binds the sentence to the browser result that proves or contradicts it.

Keep the product interface visible while introducing the five-step chain: cite, constrain, observe, run, receipt.

### 2. Create an audit

Select **New audit** and enter:

```text
Project name: proof-demo
README source: fixtures/example/README.md
Target URL: http://127.0.0.1:4321
Revision marker: probat-demo-v1
```

Create the audit. In the proof console, show:

- the exact quotation and line citation;
- the observed revision;
- `title_contains` as the typed assertion kind;
- the assertion and plan hashes;
- subjective or unsupported prose remaining unverifiable.

### 3. Record the human boundary

Approve only:

```text
The page title contains "Example Domain".
```

Explain that approval cannot change the quotation or expected value. It only permits the deterministic plan already derived from that sentence to enter the execution queue.

### 4. Run Kane

Select **Run Kane** with **Headless** enabled. Leave Author, Retry, and Push off unless the recording deliberately needs those official Kane modes.

While the request is active, state what Probat is waiting for:

- a real process exit;
- `run_end` and `test_md_done` completion;
- one structured `claim_satisfied` value;
- unchanged source, target marker, assertion plan, and test bytes.

After completion, show the resulting run card and its labeled **Pre-execution** and **Post-execution** digests. A verified run must show exit `0`, terminal `passed`, and claim `true`.

If the run is blocked, show the blocker. Do not retry by editing the generated test and do not substitute preserved evidence as though it were the new run.

### 5. Inspect the receipt

Open the newest receipt and pause on:

- process exit;
- terminal status;
- structured claim result;
- source hash;
- target fingerprint;
- test hash;
- assertion-plan hash;
- Kane run ID;
- superseded receipt ID.

Then return to execution history and show that earlier attempts remain present.

### 6. Show the Kiro engineering trace

Open the repository and show these files briefly:

```text
.kiro/specs/probat-backend/requirements.md
.kiro/specs/probat-backend/design.md
.kiro/specs/probat-backend/tasks.md
.kiro/steering/verification.md
.kiro/hooks/validate-typescript-on-save.json
.kiro/hooks/validate-completed-task.json
```

Describe the actual effect of each layer:

- the spec fixed the evidence lifecycle before implementation;
- steering prevented setup failures from becoming product failures;
- hooks kept strict type-check and the full validation sequence active;
- semantic review found mixed receipt tuples, weak journal ancestry, automation-misstep classification, and unsafe public paths;
- each finding became a persisted invariant or regression assertion.

## Preserved evidence

The repository contains an inspected projection of audit `aud_final-judge-smoke_810584a1`. This is preserved evidence—not the run created during a recording.

Current chain:

```text
Run: run_3406dd60-b56f-4828-b2c8-98783ec1e182
Receipt: rcpt_18751727-de18-4362-9fe3-930a7e70daa3
Supersedes: rcpt_08b66a1a-3d48-42cb-85a0-8bee0257cac4
Preserved authored attempt: rcpt_2aab3cb8-714d-4e0b-9612-4393cbc8f52f
Test hash: 4ffbd872da419d4f8a1eedf52ebd60cd2d96ea3ee0bd01fc5ac40a20d8ee8f43
```

The authored attempt remains linked to a public Kane result that identifies `automation_bug/agent_misstep`. Probat preserves that attempt and blocks the failure mode rather than presenting it as a product contradiction.

## Optional terminal close

End with the deterministic gate:

```powershell
npm run validate
npm audit --omit=dev
```

The useful closing statement is concrete:

> The UI is the inspection surface. The receipt is the product boundary. The source, marker, test bytes, Kane terminal tuple, and append-only history are what make the verdict durable.
