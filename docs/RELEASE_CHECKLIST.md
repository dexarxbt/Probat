# Probat release checklist

Use this gate before publishing source, evidence, a tag, or a product recording.

## Reproducibility

- [ ] Run `npm ci` from the committed lockfile.
- [ ] Run `npm run validate`.
- [ ] Run `npm audit --omit=dev`.
- [ ] Run `npm run doctor`; record Kane readiness separately from deterministic tests.
- [ ] Start `npm run demo` and `npm run dev`.
- [ ] Open `http://127.0.0.1:4310/ui/` and complete an ingest/review smoke flow.
- [ ] Clone the public repository into a clean directory and repeat install plus validation.

## Git boundary

- [ ] Review `git status`, staged paths, and the complete staged diff.
- [ ] Confirm `data/`, `.env`, raw `.testmuai/evidence/`, variables, private artifacts, generated `output-*`, and `semantic-review/` are absent.
- [ ] Stage only persistent `kane-tests/**/*_test.md`, never Kane output directories.
- [ ] Inspect every changed JSON file under `artifacts/public/`.
- [ ] Confirm author, committer, and tagger identities are intentional.
- [ ] Confirm no unexpected co-author trailers are present.
- [ ] Confirm the remote branch and annotated tag resolve to the intended commit.

## UI and local API

- [ ] `/ui/`, `/ui/app.css`, `/ui/app.js`, and `/ui/icon.svg` return HTTP 200.
- [ ] The transparent local logo renders in the README, masthead, footer, and browser icon without loading a third-party asset.
- [ ] UI responses include the strict Content Security Policy.
- [ ] Client code renders untrusted API values through text nodes, not HTML interpolation.
- [ ] A foreign Host request is rejected.
- [ ] A cross-origin mutation is rejected.
- [ ] Origin-less CLI/API requests and same-origin UI mutations still work.
- [ ] No remote font, analytics script, or third-party browser asset is loaded.

## Kane evidence

- [ ] Kane is installed, authenticated, and runner-ready before any fresh execution.
- [ ] The target serves the expected same-origin revision marker.
- [ ] The completed result displays labeled pre-execution and post-execution test digests.
- [ ] The test bytes are unchanged.
- [ ] `verified` uses only exit `0` / `passed` / `claimSatisfied: true`.
- [ ] `disproved` uses only exit `1` / `failed` / `claimSatisfied: false`.
- [ ] Timeout, setup, malformed, missing-terminal, `automation_bug`, and `agent_misstep` outcomes remain blocked.
- [ ] A v4 receipt exists only for a completed coherent tuple.
- [ ] Earlier blocked, disproved, and verified attempts remain in append-only history.
- [ ] A new receipt supersedes rather than rewrites its predecessor.

Preserved chain:

```text
Audit: aud_final-judge-smoke_810584a1
Current run: run_3406dd60-b56f-4828-b2c8-98783ec1e182
Current receipt: rcpt_18751727-de18-4362-9fe3-930a7e70daa3
Previous receipt: rcpt_08b66a1a-3d48-42cb-85a0-8bee0257cac4
Authored attempt: rcpt_2aab3cb8-714d-4e0b-9612-4393cbc8f52f
Test hash: 4ffbd872da419d4f8a1eedf52ebd60cd2d96ea3ee0bd01fc5ac40a20d8ee8f43
```

## Public projection

- [ ] No `summary`, `reason`, `progress`, stdout, stderr, session path, run path, or credential appears in public JSON.
- [ ] Citation and test paths are safe relative locators or `[REDACTED]`.
- [ ] URL userinfo, query strings, and fragments are removed.
- [ ] Every current receipt reference resolves.
- [ ] Every v4 public tuple matches its referenced run.
- [ ] Historical records are described as preserved evidence, never as a fresh execution.

## Recording

- [ ] Keep the UI, terminal text, and receipt fields readable.
- [ ] Show the exact claim and citation before the result.
- [ ] Show meaningful Kiro artifacts: spec, steering, hooks, and a review-derived invariant.
- [ ] Distinguish deterministic validation from Kane browser evidence.
- [ ] Do not display credentials, ignored local state, raw evidence, or unrelated windows.
- [ ] If a fresh execution blocks, show the blocker and the absence of a new receipt.
- [ ] Test the final video link in a private browser window.

## Stop conditions

Do not publish a new evidence claim when any of these is true:

- Kane readiness is false for a run described as fresh.
- The target marker is absent or changed.
- Before/after test hashes differ.
- A receipt is missing, stale, legacy-unbound, or uninspected.
- Public artifacts contain private prose, credentials, or local paths.
- The clean clone cannot install and pass validation.
