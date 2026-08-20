# Probat Product Direction

Probat is a local-first developer tool that turns browser-verifiable README claims into Kane tests, verdicts, and source-bound Proof Receipts.

## Users

Developers and maintainers who need to know whether documentation still matches a running web application.

## Product promise

Every reported verdict must be traceable to an exact README quotation, source location, target fingerprint, unchanged test hash, and real Kane run.

## Required semantics

- Verified means Kane demonstrated the claimed behavior.
- Disproved means a completed Kane run observed contradictory behavior.
- Blocked means prerequisites or infrastructure prevented a valid verdict.
- Unverifiable means the claim cannot be objectively checked in a browser.
- Freshness is separate from verdict; previously verified evidence may become stale.

## Non-goals

No private repository OAuth, billing, multi-tenancy, cloud Kane execution, arbitrary target-repository code execution, performance benchmarking, or security certification in the current version.
