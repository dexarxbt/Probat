# Probat Backend Tasks

- [x] Establish strict TypeScript project, dependency lock, and ignored runtime-state boundaries.
- [x] Implement validated domain records and normalized errors.
- [x] Implement local/HTTPS README ingestion, citations, source hashing, and Git/worktree fingerprints.
- [x] Implement deterministic typed claim inventory and manual review transitions.
- [x] Implement atomic revisioned JSON persistence and sanitized public artifact export.
- [x] Generate persistent content-addressed Kane `_test.md` files with stable hashes.
- [x] Implement safe Kane process execution and defensive NDJSON parsing.
- [x] Implement fail-closed verdict classification, immutable versioned receipts through v4, append-only supersession, and freshness.
- [x] Implement CLI commands and loopback-only Fastify API routes.
- [x] Add meaningful Kiro validation hooks.
- [x] Add a deterministic local judge target and zero-dependency integrity regression suite.
- [x] Validate clean install, build, tests, CLI/API workflows, persistence, and public sanitization.
- [x] Complete and inspect successful Kane browser verification while preserving all attempts. Canonical audit `aud_final-judge-smoke_810584a1` is current and verified at pushed replay run `run_3406dd60-b56f-4828-b2c8-98783ec1e182`; self-contained v4 receipt `rcpt_18751727-de18-4362-9fe3-930a7e70daa3` records exit `0`, terminal `passed`, and structured `claimSatisfied: true`, and supersedes verified retry receipt `rcpt_08b66a1a-3d48-42cb-85a0-8bee0257cac4`. Fresh authored agent-misstep evidence remains immutable in the chain and is now classified fail-closed. The test hash remains `4ffbd872da419d4f8a1eedf52ebd60cd2d96ea3ee0bd01fc5ac40a20d8ee8f43`, and deterministic validation passes 11/11.