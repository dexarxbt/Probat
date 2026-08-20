# Repository Structure

- `src/domain`: validated domain records and shared errors.
- `src/lib`: hashing, process, path, and serialization utilities.
- `src/store`: atomic file-backed persistence.
- `src/services`: README, claims, Kane tests, receipts, audits, and freshness.
- `src/adapters`: external Kane CLI integration.
- `src/api`: Fastify routes and HTTP error mapping.
- `src/cli.ts`: user-facing command entry point.
- `kane-tests`: generated persistent Kane tests and commit-safe outputs.
- `artifacts/public`: sanitized scorecard records safe to publish.
- `data`: local runtime state, ignored by Git.

Dependencies point inward: API and CLI call services; services call domain/store/adapters; domain does not depend on infrastructure.
