# Probat Backend Design

## Architecture

The CLI and loopback-only Fastify API share an `AuditService`. The service coordinates README ingestion, deterministic typed-assertion extraction, manual review state, content-addressed test generation, independently observed target revisions, the Kane adapter, receipt issuance, freshness evaluation, and publication of sanitized artifacts.

## Persistence

A versioned JSON store under `data/` holds one file per audit and receipt. Mutable audit writes use revision compare-and-swap plus atomic replacement; receipt commits use immutable files and recoverable journals. Every read is schema-validated, and legacy unbound evidence is marked stale. Public scorecard bundles are derived into `artifacts/public/` and omit credentials, raw Kane prose, progress, and private paths.

## Kane boundary

The adapter spawns `kane-cli` directly with argument arrays and `shell: false`. It parses NDJSON defensively and combines the `run_end` terminal state with process status. Only passed + `claim_satisfied: true` verifies; only failed + `claim_satisfied: false` disproves. Setup errors, timeouts, malformed output, and missing terminal state remain blocked. Persistent, create-only Markdown tests live under `kane-tests/<project-slug>/` and include their full content hash in the filename.

## Claim extraction

The backend provides deterministic baseline extraction so installation remains functional without an additional AI API. Exact README quotations and line citations are preserved, but only two constrained assertion plans are executable in the current product: page-title substring and visible link-label equality. Literal operands are encoded as data in generated tests; unsupported, subjective, security, and performance statements remain unverifiable rather than becoming free-form agent prompts.

## Target identity

A target with a declared revision must serve that exact value from `/.well-known/probat-revision`. Probat observes and hashes the same-origin marker before and after Kane. A changed, missing, redirected, oversized, or mismatched marker blocks receipt issuance.

## Security

Local source paths are canonicalized and constrained to the workspace. Remote sources require credential-free, bounded public GitHub HTTPS URLs. README content is never executed. Child processes use no shell. The HTTP API binds only to loopback and rejects credential headers. Authoritative private state and raw evidence remain ignored.
