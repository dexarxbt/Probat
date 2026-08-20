# Probat Backend Requirements

## 1. Source ingestion

1.1 WHEN a user supplies a local Markdown path, Probat SHALL load it without executing repository code.

1.2 WHEN a user supplies a public HTTPS README URL, Probat SHALL fetch only bounded Markdown content and reject unsupported protocols or oversized responses.

1.3 Probat SHALL preserve each extracted claim's exact quotation, path or URL, line range, source hash, and available Git fingerprint.

## 2. Claim lifecycle

2.1 WHEN source content is ingested, Probat SHALL inventory likely product claims with stable IDs and explicit extraction rationale.

2.2 Probat SHALL distinguish pending, verified, disproved, blocked, unverifiable, and error verdicts.

2.3 Probat SHALL keep freshness separate from verdict and mark evidence stale when source, target, or test fingerprints change.

2.4 A user SHALL be able to approve, reject, or mark a claim unverifiable before verification; review SHALL NOT rewrite the immutable README quotation or executable assertion.

## 3. Kane verification

3.1 WHEN an approved testable claim is verified, Probat SHALL generate a persistent `_test.md` file and invoke Kane with `--agent`.

3.2 Probat SHALL use the process exit code plus the stable terminal event to classify the run.

3.3 IF Kane cannot produce a valid completed run, Probat SHALL return blocked or error rather than disproved.

3.4 Probat SHALL retain sanitized failed and passing run summaries and hashes without committing credentials or raw evidence packs.

## 4. Proof Receipts

4.1 WHEN a valid Kane run completes, Probat SHALL issue an immutable receipt binding claim citation, source fingerprint, target fingerprint, test hash, verdict, run metadata, and evidence link.

4.2 A new receipt SHALL supersede rather than mutate a previous receipt.

## 5. Interfaces

5.1 Probat SHALL expose doctor, audit, ingest, review, verify, list, show, freshness, and serve CLI commands.

5.2 Probat SHALL expose health, audits, claims, verification, receipts, and freshness HTTP endpoints.

5.3 Invalid external input SHALL produce actionable messages without stack traces or secrets.

## 6. Reliability and security

6.1 Persistence SHALL use atomic writes and schema validation.

6.2 Probat SHALL not execute code from an audited repository or interpolate external values into a shell command.

6.3 Probat SHALL run locally without a paid database, hosted backend, or paid API.
