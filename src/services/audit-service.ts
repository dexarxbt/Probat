import { randomUUID } from 'node:crypto';
import {
  CreateAuditInputSchema,
  ReviewClaimInputSchema,
  deriveAuditReviewStatus,
  deriveSettledAuditExecutionStatus,
  hasObservableTargetBinding,
  legacyStatusForExecutionStatus,
  targetObservationHash as observationHashFor,
  type Audit,
  type Claim,
  type CreateAuditInput,
  type KaneRun,
  type Receipt,
  type ReceiptView,
  type ReviewClaimInput,
} from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { targetFingerprint } from '../lib/fingerprint.js';
import { sha256, slugify, stableJson } from '../lib/hash.js';
import type { KaneAdapter, KaneDoctorResult } from '../adapters/kane-adapter.js';
import type { TargetObserver } from '../adapters/target-observer.js';
import type { FileStore } from '../store/file-store.js';
import {
  compileBrowserAssertion,
  extractClaims,
  reviewClaim as applyClaimReview,
} from './claim-extractor.js';
import type { ReadmeSourceService } from './readme-source.js';
import type { KaneTestService } from './test-generator.js';
import type {
  ReceiptIssuanceIntent,
  ReceiptService,
} from './receipt-service.js';

export interface VerifyOptions {
  headless?: boolean;
  author?: boolean;
  retry?: boolean;
  push?: boolean;
  timeoutSeconds?: number;
}

export interface VerifyResult {
  audit: Audit;
  claim: Claim;
  run: KaneRun;
  receipt: Receipt | null;
  testHashBefore: string | null;
  testHashAfter: string | null;
}

export class AuditService {
  constructor(
    private readonly workspaceRoot: string,
    private readonly store: FileStore,
    private readonly readmes: ReadmeSourceService,
    private readonly tests: KaneTestService,
    private readonly kane: KaneAdapter,
    private readonly targets: TargetObserver,
    private readonly receipts: ReceiptService,
  ) {}

  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  async doctor(): Promise<KaneDoctorResult & { node: string; workspace: string }> {
    const result = await this.kane.doctor(this.workspaceRoot);
    return { ...result, node: process.version, workspace: this.workspaceRoot };
  }

  async createAudit(rawInput: CreateAuditInput): Promise<Audit> {
    const input = CreateAuditInputSchema.parse(rawInput);
    const loaded = await this.readmes.load(input.readme);
    const projectSlug = slugify(input.project);
    const auditId = `aud_${projectSlug}_${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const claims = extractClaims(auditId, loaded);
    const observedTarget = input.targetRevision
      ? await this.targets.observe(input.targetUrl, input.targetRevision)
      : null;
    let target: Audit['target'];
    if (observedTarget) {
      const observation = observedTarget.observation;
      if (observation.kind !== 'deployment-manifest-v2') {
        throw new ProbatError(
          'INVALID_STATE',
          'New target ingestion requires a deployment-manifest-v2 observation.',
          409,
        );
      }
      target = {
        url: observation.entrypointUrl,
        revision: input.targetRevision,
        fingerprint: observedTarget.fingerprint,
        fingerprintKind: 'observed-manifest-v3',
        observation,
      };
    } else {
      target = {
        url: input.targetUrl,
        revision: null,
        fingerprint: targetFingerprint(input.targetUrl, null),
        fingerprintKind: 'declared-v1',
        observation: null,
      };
    }
    const audit: Audit = {
      version: 1,
      recordRevision: 0,
      proofIntegrity: 'typed-v2',
      id: auditId,
      projectSlug,
      ...settledAuditStatuses(claims, target),
      source: loaded.source,
      target,
      claims,
      runs: [],
      receiptIds: [],
      createdAt: now,
      updatedAt: now,
    };
    return this.store.saveAudit(audit, null);
  }

  async listAudits(): Promise<Audit[]> {
    return this.store.listAudits();
  }

  async getAudit(id: string): Promise<Audit> {
    return this.store.getAudit(id);
  }

  async getReceipt(id: string): Promise<ReceiptView> {
    return this.store.getReceipt(id);
  }

  async reviewClaim(auditId: string, claimId: string, rawInput: ReviewClaimInput): Promise<Audit> {
    const input = ReviewClaimInputSchema.parse(rawInput);
    const release = await this.store.acquireAuditLock(auditId);
    try {
      const audit = await this.store.getAudit(auditId);
      const index = audit.claims.findIndex((claim) => claim.id === claimId);
      if (index < 0) {
        throw new ProbatError('CLAIM_NOT_FOUND', `Claim '${claimId}' was not found.`, 404);
      }
      const current = audit.claims[index];
      if (!current) throw new ProbatError('CLAIM_NOT_FOUND', `Claim '${claimId}' was not found.`, 404);
      const updated = applyClaimReview(current, input);
      const claims = [...audit.claims];
      claims[index] = updated;
      return this.store.saveAudit(
        {
          ...audit,
          claims,
          proofIntegrity: summarizeProofIntegrity(claims),
          ...settledAuditStatuses(claims, audit.target),
          updatedAt: new Date().toISOString(),
        },
        audit.recordRevision,
      );
    } finally {
      await release();
    }
  }

  async verifyClaim(
    auditId: string,
    claimId: string,
    options: VerifyOptions = {},
  ): Promise<VerifyResult> {
    const release = await this.store.acquireAuditLock(auditId);
    try {
      let audit = await this.store.getAudit(auditId);
      const claimIndex = audit.claims.findIndex((claim) => claim.id === claimId);
      if (claimIndex < 0) {
        throw new ProbatError('CLAIM_NOT_FOUND', `Claim '${claimId}' was not found.`, 404);
      }
      const claim = audit.claims[claimIndex];
      if (!claim) throw new ProbatError('CLAIM_NOT_FOUND', `Claim '${claimId}' was not found.`, 404);
      if (claim.reviewStatus !== 'approved' || claim.testability !== 'testable') {
        throw new ProbatError(
          'INVALID_STATE',
          'Only individually reviewed and approved browser-verifiable claims can be verified.',
          409,
        );
      }
      const currentTargetObservation = audit.target.observation;
      if (
        !audit.target.revision ||
        audit.target.fingerprintKind !== 'observed-manifest-v3' ||
        currentTargetObservation?.kind !== 'deployment-manifest-v2'
      ) {
        throw new ProbatError(
          'INVALID_STATE',
          'Current-policy verification requires a newly ingested target with a valid deployment manifest at /.well-known/probat-manifest.json.',
          409,
        );
      }
      const targetRevision = audit.target.revision;
      const targetObservationHash = currentTargetObservation.manifestHash;
      const assertionHash = sha256(claim.quote);
      const compiledAssertion = compileBrowserAssertion(claim.quote);
      const assertionPlanHash = compiledAssertion
        ? sha256(stableJson(compiledAssertion))
        : null;
      if (
        claim.assertionHash !== assertionHash ||
        !compiledAssertion ||
        !assertionPlanHash ||
        stableJson(claim.assertion) !== stableJson(compiledAssertion) ||
        claim.assertionPlanHash !== assertionPlanHash ||
        claim.evidenceVersion !== 'typed-v2'
      ) {
        throw new ProbatError(
          'INVALID_STATE',
          'The claim is not bound to a constrained assertion compiled from its exact README quotation. Review the claim again before verification.',
          409,
        );
      }

      const sourceBefore = await this.readmes.load(audit.source.locator);
      let targetBefore;
      try {
        targetBefore = await this.targets.observe(audit.target.url, targetRevision);
      } catch (error) {
        await this.markClaimStale(audit, claimIndex);
        throw error;
      }
      if (
        sourceBefore.source.contentHash !== audit.source.contentHash ||
        targetBefore.fingerprint !== audit.target.fingerprint ||
        observationHashFor(targetBefore.observation) !== targetObservationHash
      ) {
        await this.markClaimStale(audit, claimIndex);
        throw new ProbatError(
          'INVALID_STATE',
          'Source or independently observed target identity changed after ingestion. Re-ingest before verification.',
          409,
        );
      }

      const issuanceIntent: ReceiptIssuanceIntent =
        claim.latestReceiptId === null
          ? { supersessionReason: 'first' }
          : claim.freshness === 'stale'
            ? { supersessionReason: 'freshness-renewal' }
            : { supersessionReason: 'retry' };
      const generated = await this.tests.ensureTest(audit.projectSlug, claim);
      const preparedClaim: Claim = {
        ...claim,
        testPath: generated.relativePath,
        testHash: generated.hash,
        testFormatVersion: generated.formatVersion,
        freshness: 'current',
        updatedAt: new Date().toISOString(),
      };
      const preparedClaims = [...audit.claims];
      preparedClaims[claimIndex] = preparedClaim;
      audit = await this.store.saveAudit(
        {
          ...audit,
          claims: preparedClaims,
          executionStatus: 'running',
          status: legacyStatusForExecutionStatus('running'),
          updatedAt: new Date().toISOString(),
        },
        audit.recordRevision,
      );

      const preRunTestHash = await this.tests.currentHash(generated.absolutePath);
      const execution =
        preRunTestHash === generated.hash
          ? await this.kane.runTest({
              testPath: generated.absolutePath,
              targetUrl: audit.target.url,
              cwd: this.workspaceRoot,
              ...(options.headless === undefined ? {} : { headless: options.headless }),
              ...(options.author === undefined ? {} : { author: options.author }),
              ...(options.retry === undefined ? {} : { retry: options.retry }),
              ...(options.push === undefined ? {} : { push: options.push }),
              ...(options.timeoutSeconds === undefined
                ? {}
                : { timeoutSeconds: options.timeoutSeconds }),
            })
          : {
              id: `run_${randomUUID()}`,
              verdict: 'blocked' as const,
              exitCode: null,
              terminal: null,
              progress: [],
              invalidOutputLines: 0,
              protocol: {
                valid: false,
                mode: 'invalid' as const,
                error: 'The immutable test hash did not match immediately before Kane launch.',
                runEndCount: 0,
                testMdDoneCount: 0,
              },
              stderrSummary: 'Kane was not started because the immutable test binding changed.',
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
            };

      const postRunTestHash = await this.tests.currentHash(generated.relativePath);
      let postRunSourceHash = 'unavailable';
      try {
        postRunSourceHash = (await this.readmes.load(audit.source.locator)).source.contentHash;
      } catch {
        // Missing source blocks receipt issuance below.
      }
      let postRunTargetFingerprint = 'unavailable';
      let postRunTargetObservationHash = 'unavailable';
      try {
        const observed = await this.targets.observe(audit.target.url, targetRevision);
        postRunTargetFingerprint = observed.fingerprint;
        postRunTargetObservationHash = observationHashFor(observed.observation) ?? 'unavailable';
      } catch {
        // Missing target observation blocks receipt issuance below.
      }
      const bindingsCurrent =
        preRunTestHash === generated.hash &&
        postRunTestHash === generated.hash &&
        postRunSourceHash === audit.source.contentHash &&
        postRunTargetFingerprint === audit.target.fingerprint &&
        postRunTargetObservationHash === targetObservationHash &&
        preparedClaim.assertionHash === assertionHash &&
        preparedClaim.assertionPlanHash === assertionPlanHash &&
        preparedClaim.evidenceVersion === 'typed-v2';
      const effectiveVerdict = bindingsCurrent ? execution.verdict : 'blocked';
      const terminal = execution.terminal;
      const run: KaneRun = {
        id: execution.id,
        auditId: audit.id,
        claimId,
        verdict: effectiveVerdict,
        exitCode: execution.exitCode,
        terminalStatus: terminal?.status ?? null,
        claimSatisfied: terminal?.claimSatisfied ?? null,
        summary: bindingsCurrent
          ? terminal?.summary ||
            (execution.verdict === 'verified'
              ? 'Kane completed the immutable browser test and explicitly reported the claim satisfied.'
              : execution.verdict === 'disproved'
                ? 'Kane completed the immutable browser test and explicitly reported the claim unsatisfied.'
                : 'Kane could not complete a valid browser verification.')
          : 'Verification bindings changed or became unavailable during execution; no receipt was issued.',
        reason: bindingsCurrent
          ? terminal?.reason || execution.stderrSummary
          : 'The exact source, deployment manifest, entrypoint, assertion, or immutable test hash did not match both preflight and completion.',
        durationSeconds: terminal?.durationSeconds ?? null,
        credits: terminal?.credits ?? null,
        testUrl: terminal?.testUrl ?? null,
        testPath: generated.relativePath,
        testHash: generated.hash,
        testHashBefore: preRunTestHash,
        testHashAfter: postRunTestHash,
        testBytesUnchanged:
          preRunTestHash !== null &&
          postRunTestHash !== null &&
          preRunTestHash === postRunTestHash,
        evidencePolicyVersion: 2,
        protocol: execution.protocol,
        testFormatVersion: generated.formatVersion,
        assertionHash,
        assertionPlanHash,
        evidenceVersion: 'typed-v2',
        sourceHash: audit.source.contentHash,
        targetFingerprint: audit.target.fingerprint,
        targetRevision,
        targetObservationHash,
        targetBindingKind: currentTargetObservation.kind,
        targetManifestHash: currentTargetObservation.manifestHash,
        targetEntrypointUrl: currentTargetObservation.entrypointUrl,
        targetEntrypointHash: currentTargetObservation.entrypointHash,
        progress: execution.progress,
        invalidOutputLines: execution.invalidOutputLines,
        localSessionDir: terminal?.sessionDir ?? null,
        localRunDir: terminal?.runDir ?? null,
        startedAt: execution.startedAt,
        completedAt: execution.completedAt,
      };

      let receipt: Receipt | null = null;
      if (run.verdict === 'verified' || run.verdict === 'disproved') {
        receipt = this.receipts.issue(audit, preparedClaim, run, issuanceIntent);
      }
      const completedClaim: Claim = {
        ...preparedClaim,
        verdict: run.verdict,
        freshness: bindingsCurrent ? 'current' : 'stale',
        latestReceiptId: receipt?.id ?? preparedClaim.latestReceiptId,
        updatedAt: new Date().toISOString(),
      };
      const completedClaims = [...audit.claims];
      completedClaims[claimIndex] = completedClaim;
      const completedAudit: Audit = {
        ...audit,
        claims: completedClaims,
        runs: [...audit.runs, run],
        receiptIds: receipt ? [...audit.receiptIds, receipt.id] : audit.receiptIds,
        ...settledAuditStatuses(completedClaims, audit.target),
        updatedAt: new Date().toISOString(),
      };
      audit = receipt
        ? await this.store.commitVerification(completedAudit, receipt, audit.recordRevision)
        : await this.store.saveAudit(completedAudit, audit.recordRevision);

      const persistedRun = audit.runs.find((entry) => entry.id === run.id);
      if (!persistedRun) {
        throw new ProbatError(
          'PERSISTENCE_ERROR',
          'The completed Kane run was not present after persistence.',
          500,
        );
      }
      return {
        audit,
        claim: completedClaim,
        run: persistedRun,
        receipt,
        testHashBefore: persistedRun.testHashBefore,
        testHashAfter: persistedRun.testHashAfter,
      };
    } finally {
      await release();
    }
  }

  async verifyAudit(auditId: string, options: VerifyOptions = {}): Promise<VerifyResult[]> {
    const audit = await this.store.getAudit(auditId);
    const eligible = audit.claims.filter(
      (claim) => claim.reviewStatus === 'approved' && claim.testability === 'testable',
    );
    if (eligible.length === 0) {
      throw new ProbatError('INVALID_STATE', 'The audit has no approved testable claims.', 409);
    }
    const results: VerifyResult[] = [];
    for (const claim of eligible) {
      results.push(await this.verifyClaim(auditId, claim.id, options));
    }
    return results;
  }

  async refreshFreshness(auditId: string): Promise<Audit> {
    const release = await this.store.acquireAuditLock(auditId);
    try {
      const audit = await this.store.getAudit(auditId);
      let currentSourceHash = audit.source.contentHash;
      try {
        currentSourceHash = (await this.readmes.load(audit.source.locator)).source.contentHash;
      } catch {
        currentSourceHash = 'unavailable';
      }
      let currentTargetFingerprint = 'unavailable';
      let currentTargetObservationHash = 'unavailable';
      if (hasObservableTargetBinding(audit.target) && audit.target.revision) {
        try {
          const observed =
            audit.target.fingerprintKind === 'observed-revision-v2'
              ? await this.targets.observeLegacyRevision(audit.target.url, audit.target.revision)
              : await this.targets.observe(audit.target.url, audit.target.revision);
          currentTargetFingerprint = observed.fingerprint;
          currentTargetObservationHash = observationHashFor(observed.observation) ?? 'unavailable';
        } catch {
          currentTargetFingerprint = 'unavailable';
          currentTargetObservationHash = 'unavailable';
        }
      }
      const storedTargetObservationHash = observationHashFor(audit.target.observation);
      const claims = await Promise.all(
        audit.claims.map(async (claim) => {
          const currentTestHash = claim.testPath ? await this.tests.currentHash(claim.testPath) : null;
          const stale = Boolean(
            claim.latestReceiptId &&
              (currentSourceHash !== audit.source.contentHash ||
                currentTargetFingerprint !== audit.target.fingerprint ||
                currentTargetObservationHash !== storedTargetObservationHash ||
                currentTestHash !== claim.testHash ||
                claim.assertionHash !== sha256(claim.quote) ||
                !claim.assertion ||
                claim.assertionPlanHash !== sha256(stableJson(claim.assertion)) ||
                claim.evidenceVersion !== 'typed-v2'),
          );
          return { ...claim, freshness: stale ? ('stale' as const) : ('current' as const) };
        }),
      );
      return this.store.saveAudit(
        {
          ...audit,
          claims,
          ...settledAuditStatuses(claims, audit.target),
          updatedAt: new Date().toISOString(),
        },
        audit.recordRevision,
      );
    } finally {
      await release();
    }
  }

  private async markClaimStale(audit: Audit, claimIndex: number): Promise<void> {
    const claim = audit.claims[claimIndex];
    if (!claim) return;
    const claims = [...audit.claims];
    claims[claimIndex] = {
      ...claim,
      freshness: 'stale',
      updatedAt: new Date().toISOString(),
    };
    await this.store.saveAudit(
      {
        ...audit,
        claims,
        ...settledAuditStatuses(claims, audit.target),
        updatedAt: new Date().toISOString(),
      },
      audit.recordRevision,
    );
  }
}

function summarizeProofIntegrity(claims: Claim[]): Audit['proofIntegrity'] {
  return claims
    .filter((claim) => claim.testability === 'testable')
    .every((claim) => claim.evidenceVersion === 'typed-v2')
    ? 'typed-v2'
    : 'legacy-present';
}

function settledAuditStatuses(
  claims: Claim[],
  target: Audit['target'],
): Pick<Audit, 'reviewStatus' | 'executionStatus' | 'status'> {
  const reviewStatus = deriveAuditReviewStatus(claims);
  const executionStatus = deriveSettledAuditExecutionStatus({ claims, target });
  return {
    reviewStatus,
    executionStatus,
    status: legacyStatusForExecutionStatus(executionStatus),
  };
}
