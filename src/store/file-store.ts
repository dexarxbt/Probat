import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AuditSchema,
  StoredAuditSchema,
  parseStoredAudit as parseAuditCompatibility,
  targetObservationHash,
  ReceiptSchema,
  ReceiptV4Schema,
  ReceiptV5Schema,
  ReceiptV6Schema,
  ReceiptV7Schema,
  type Audit,
  type Receipt,
  type ReceiptView,
} from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { stableJson } from '../lib/hash.js';

const LegacyVerificationTransactionSchema = z.object({
  version: z.literal(3),
  baseAudit: StoredAuditSchema,
  nextAudit: StoredAuditSchema,
  receipt: ReceiptV4Schema,
});
const Policy1VerificationTransactionSchema = z.object({
  version: z.literal(4),
  baseAudit: StoredAuditSchema,
  nextAudit: StoredAuditSchema,
  receipt: ReceiptV5Schema,
});
const Format2VerificationTransactionSchema = z.object({
  version: z.literal(5),
  baseAudit: StoredAuditSchema,
  nextAudit: StoredAuditSchema,
  receipt: ReceiptV6Schema,
});
const Format3VerificationTransactionSchema = z.object({
  version: z.literal(6),
  baseAudit: StoredAuditSchema,
  nextAudit: StoredAuditSchema,
  receipt: ReceiptV7Schema,
});
const CurrentReceiptSchema = z.discriminatedUnion('version', [
  ReceiptV6Schema,
  ReceiptV7Schema,
]);
const VerificationTransactionSchema = z.discriminatedUnion('version', [
  LegacyVerificationTransactionSchema,
  Policy1VerificationTransactionSchema,
  Format2VerificationTransactionSchema,
  Format3VerificationTransactionSchema,
]);
type VerificationTransaction = z.infer<typeof VerificationTransactionSchema>;

export class FileStore {
  readonly dataRoot: string;
  readonly publicRoot: string;
  private readonly auditRoot: string;
  private readonly receiptRoot: string;
  private readonly lockRoot: string;
  private readonly transactionRoot: string;
  private initialized = false;

  constructor(workspaceRoot: string) {
    this.dataRoot = join(workspaceRoot, 'data');
    this.publicRoot = join(workspaceRoot, 'artifacts', 'public');
    this.auditRoot = join(this.dataRoot, 'audits');
    this.receiptRoot = join(this.dataRoot, 'receipts');
    this.lockRoot = join(this.dataRoot, 'locks');
    this.transactionRoot = join(this.dataRoot, 'transactions');
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await Promise.all([
      mkdir(this.auditRoot, { recursive: true }),
      mkdir(this.receiptRoot, { recursive: true }),
      mkdir(this.lockRoot, { recursive: true }),
      mkdir(this.transactionRoot, { recursive: true }),
      mkdir(join(this.publicRoot, 'audits'), { recursive: true }),
      mkdir(join(this.publicRoot, 'receipts'), { recursive: true }),
    ]);
    this.initialized = true;
    await this.recoverTransactions();
    await this.rebuildPublicArtifacts();
  }

  async acquireAuditLock(auditId: string): Promise<() => Promise<void>> {
    await this.initialize();
    const lockPath = join(this.lockRoot, `${auditId}.lock`);
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
    } catch (error) {
      throw new ProbatError(
        'CONFLICT',
        `Audit '${auditId}' is already being modified by another process.`,
        409,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
    return async () => {
      await handle.close();
      await rm(lockPath, { force: true });
    };
  }

  async saveAudit(audit: Audit, expectedRevision: number | null): Promise<Audit> {
    const requested = AuditSchema.parse(audit);
    await this.initialize();
    const current = await this.readAuditIfExists(requested.id);
    assertExpectedRevision(requested.id, current, expectedRevision);
    if (current) assertHistoricalEvidenceUnchanged(current, requested);
    const next = AuditSchema.parse({
      ...requested,
      recordRevision: expectedRevision === null ? 0 : expectedRevision + 1,
    });
    await atomicJsonWrite(join(this.auditRoot, `${next.id}.json`), next);
    await this.exportPublicAudit(next);
    return next;
  }

  async commitVerification(
    audit: Audit,
    receipt: Receipt,
    expectedRevision: number,
  ): Promise<Audit> {
    const requestedAudit = AuditSchema.parse(audit);
    const parsedReceipt = CurrentReceiptSchema.parse(receipt);
    await this.initialize();
    const current = await this.readAuditIfExists(requestedAudit.id);
    assertExpectedRevision(requestedAudit.id, current, expectedRevision);
    if (!current) {
      throw new ProbatError('CONFLICT', `Audit '${requestedAudit.id}' no longer exists.`, 409);
    }
    assertVerificationAppend(current, requestedAudit, parsedReceipt);
    await this.assertProspectiveReceiptGraph(parsedReceipt, false);
    const nextAudit = AuditSchema.parse({
      ...requestedAudit,
      recordRevision: expectedRevision + 1,
    });
    const journalPath = join(this.transactionRoot, `${parsedReceipt.id}.json`);
    const transaction: VerificationTransaction =
      parsedReceipt.version === 6
        ? {
            version: 5,
            baseAudit: current,
            nextAudit,
            receipt: parsedReceipt,
          }
        : {
            version: 6,
            baseAudit: current,
            nextAudit,
            receipt: parsedReceipt,
          };
    await immutableJsonWrite(journalPath, transaction);
    try {
      await immutableJsonWrite(join(this.receiptRoot, `${parsedReceipt.id}.json`), parsedReceipt);
      await atomicJsonWrite(join(this.auditRoot, `${nextAudit.id}.json`), nextAudit);
      await this.exportPublicReceipt(parsedReceipt);
      await this.exportPublicAudit(nextAudit);
      await rm(journalPath, { force: true });
      return nextAudit;
    } catch (error) {
      throw new ProbatError(
        'PERSISTENCE_ERROR',
        'Verification evidence could not be committed atomically; recovery data was retained.',
        500,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  async getAudit(id: string): Promise<Audit> {
    await this.initialize();
    const audit = await this.readAuditIfExists(id);
    if (!audit) {
      throw new ProbatError('AUDIT_NOT_FOUND', `Audit '${id}' was not found.`, 404);
    }
    return audit;
  }

  async listAudits(): Promise<Audit[]> {
    await this.initialize();
    const audits = await this.listAuditsWithoutExport();
    return audits.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async getReceipt(id: string): Promise<ReceiptView> {
    await this.initialize();
    try {
      const receipts = await this.listReceiptsWithoutExport();
      const receipt = receipts.find((entry) => entry.id === id);
      if (!receipt) {
        throw new ProbatError('RECEIPT_NOT_FOUND', `Receipt '${id}' was not found.`, 404);
      }
      return deriveReceiptViews(receipts).find((entry) => entry.id === id) as ReceiptView;
    } catch (error) {
      if (isMissingFile(error)) {
        throw new ProbatError('RECEIPT_NOT_FOUND', `Receipt '${id}' was not found.`, 404);
      }
      if (error instanceof ProbatError) throw error;
      throw new ProbatError('PERSISTENCE_ERROR', `Receipt '${id}' could not be read.`, 500);
    }
  }

  private async recoverTransactions(): Promise<void> {
    const recoveryLockPath = join(this.lockRoot, 'transaction-recovery.lock');
    let recoveryLock;
    try {
      recoveryLock = await open(recoveryLockPath, 'wx');
    } catch (error) {
      throw new ProbatError(
        'CONFLICT',
        'Another Probat process is recovering verification transactions.',
        409,
        { cause: error instanceof Error ? error.message : String(error) },
      );
    }

    try {
      const files = (await readdir(this.transactionRoot)).filter((file) => file.endsWith('.json'));
      for (const file of files) {
        const path = join(this.transactionRoot, file);
        let transaction: VerificationTransaction;
        try {
          const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
          transaction = VerificationTransactionSchema.parse(raw);
          assertRecoveryTransaction(transaction);
          await this.assertProspectiveReceiptGraph(transaction.receipt, true);
        } catch (error) {
          if (error instanceof ProbatError && error.code === 'PERSISTENCE_ERROR') {
            throw error;
          }
          await this.quarantineTransaction(path);
          continue;
        }

        const current = await this.readAuditIfExists(transaction.nextAudit.id);
        if (!current) {
          await this.quarantineTransaction(path);
          continue;
        }

        let auditToExport: Audit;
        if (
          current.recordRevision === transaction.baseAudit.recordRevision &&
          stableJson(current) === stableJson(transaction.baseAudit)
        ) {
          await ensureImmutableJson(
            join(this.receiptRoot, `${transaction.receipt.id}.json`),
            transaction.receipt,
          );
          await atomicJsonWrite(
            join(this.auditRoot, `${transaction.nextAudit.id}.json`),
            transaction.nextAudit,
          );
          auditToExport = transaction.nextAudit;
        } else if (
          current.recordRevision === transaction.nextAudit.recordRevision &&
          stableJson(current) === stableJson(transaction.nextAudit)
        ) {
          await ensureImmutableJson(
            join(this.receiptRoot, `${transaction.receipt.id}.json`),
            transaction.receipt,
          );
          auditToExport = current;
        } else if (
          current.id === transaction.nextAudit.id &&
          current.recordRevision > transaction.nextAudit.recordRevision
        ) {
          try {
            assertHistoricalEvidenceUnchanged(transaction.nextAudit, current);
          } catch {
            await this.quarantineTransaction(path);
            continue;
          }
          await ensureImmutableJson(
            join(this.receiptRoot, `${transaction.receipt.id}.json`),
            transaction.receipt,
          );
          auditToExport = current;
        } else {
          await this.quarantineTransaction(path);
          continue;
        }

        await this.exportPublicReceipt(transaction.receipt);
        await this.exportPublicAudit(auditToExport);
        await rm(path, { force: true });
      }
    } finally {
      await recoveryLock.close();
      await rm(recoveryLockPath, { force: true });
    }
  }

  private async quarantineTransaction(path: string): Promise<void> {
    await rename(path, `${path}.unsafe-${randomUUID()}`);
  }

  private async rebuildPublicArtifacts(): Promise<void> {
    const audits = await this.listAuditsWithoutExport();
    const receiptViews = deriveReceiptViews(await this.listReceiptsWithoutExport());
    for (const audit of audits) {
      await atomicJsonWrite(
        join(this.publicRoot, 'audits', `${audit.id}.json`),
        sanitizeAudit(audit),
      );
    }
    for (const receipt of receiptViews) {
      await atomicJsonWrite(
        join(this.publicRoot, 'receipts', `${receipt.id}.json`),
        sanitizeReceipt(receipt),
      );
    }
    await this.exportPublicIndex(audits, receiptViews);
  }

  private async exportPublicReceipt(receipt: Receipt): Promise<void> {
    await mkdir(join(this.publicRoot, 'receipts'), { recursive: true });
    const receiptViews = deriveReceiptViews(await this.listReceiptsWithoutExport());
    if (!receiptViews.some((entry) => entry.id === receipt.id)) {
      throw new ProbatError(
        'PERSISTENCE_ERROR',
        `Receipt '${receipt.id}' could not be projected from canonical state.`,
        500,
      );
    }
    for (const view of receiptViews) {
      await atomicJsonWrite(
        join(this.publicRoot, 'receipts', `${view.id}.json`),
        sanitizeReceipt(view),
      );
    }
  }

  private async exportPublicAudit(audit: Audit): Promise<void> {
    const receiptViews = deriveReceiptViews(await this.listReceiptsWithoutExport());
    await mkdir(join(this.publicRoot, 'audits'), { recursive: true });
    await atomicJsonWrite(
      join(this.publicRoot, 'audits', `${audit.id}.json`),
      sanitizeAudit(audit),
    );

    const audits = await this.listAuditsWithoutExport();
    const byId = new Map(audits.map((entry) => [entry.id, entry]));
    byId.set(audit.id, audit);
    await this.exportPublicIndex(
      [...byId.values()],
      receiptViews,
    );
  }

  private async exportPublicIndex(
    audits: Audit[],
    receiptViews: ReceiptView[],
  ): Promise<void> {
    await atomicJsonWrite(join(this.publicRoot, 'index.json'), {
      generatedAt: new Date().toISOString(),
      audits: audits
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((entry) => {
          const auditReceipts = receiptViews.filter((receipt) => receipt.auditId === entry.id);
          return {
            id: entry.id,
            projectSlug: entry.projectSlug,
            reviewStatus: entry.reviewStatus,
            executionStatus: entry.executionStatus,
            status: entry.status,
            targetUrl: safePublicUrl(entry.target.url),
            claimCount: entry.claims.length,
            verified: entry.claims.filter((claim) => isCurrentBoundProof(claim, 'verified')).length,
            disproved: entry.claims.filter((claim) => isCurrentBoundProof(claim, 'disproved')).length,
            legacyEvidence: entry.claims.filter(
              (claim) =>
                claim.evidenceVersion === 'legacy-unbound' &&
                (claim.verdict === 'verified' || claim.verdict === 'disproved'),
            ).length,
            currentPolicyEvidence: auditReceipts.filter(
              (receipt) => receipt.policyAssessment.validity === 'current',
            ).length,
            legacyPolicyEvidence: auditReceipts.filter(
              (receipt) => receipt.policyAssessment.validity === 'legacy',
            ).length,
            correctedPolicyEvidence: auditReceipts.filter(
              (receipt) => receipt.policyAssessment.validity === 'corrected',
            ).length,
            supersededReceipts: auditReceipts.filter(
              (receipt) => receipt.lineageStatus === 'superseded',
            ).length,
            blocked: entry.claims.filter((claim) => claim.verdict === 'blocked').length,
            unverifiable: entry.claims.filter((claim) => claim.verdict === 'unverifiable').length,
            updatedAt: entry.updatedAt,
          };
        }),
    });
  }

  private async listAuditsWithoutExport(): Promise<Audit[]> {
    await mkdir(this.auditRoot, { recursive: true });
    const files = (await readdir(this.auditRoot)).filter((file) => file.endsWith('.json'));
    return Promise.all(
      files.map(async (file) => {
        const content = await readFile(join(this.auditRoot, file), 'utf8');
        return parseStoredAudit(JSON.parse(content));
      }),
    );
  }

  private async listReceiptsWithoutExport(): Promise<Receipt[]> {
    await mkdir(this.receiptRoot, { recursive: true });
    const files = (await readdir(this.receiptRoot)).filter((file) => file.endsWith('.json'));
    return Promise.all(
      files.map(async (file) =>
        ReceiptSchema.parse(JSON.parse(await readFile(join(this.receiptRoot, file), 'utf8'))),
      ),
    );
  }

  private async assertProspectiveReceiptGraph(
    receipt: Receipt,
    allowExistingEquivalent: boolean,
  ): Promise<void> {
    const existing = await this.listReceiptsWithoutExport();
    const matching = existing.filter((entry) => entry.id === receipt.id);
    if (matching.length > 1 || (!allowExistingEquivalent && matching.length > 0)) {
      throw new ProbatError(
        'CONFLICT',
        `Receipt graph contains duplicate ID '${receipt.id}'.`,
        409,
      );
    }
    if (matching.length === 1) {
      let existingRaw: unknown;
      try {
        existingRaw = JSON.parse(
          await readFile(join(this.receiptRoot, `${receipt.id}.json`), 'utf8'),
        ) as unknown;
      } catch (error) {
        if (isMissingFile(error)) {
          throw new ProbatError(
            'CONFLICT',
            `Receipt '${receipt.id}' exists outside its canonical path.`,
            409,
          );
        }
        throw error;
      }
      if (stableJson(existingRaw) !== stableJson(receipt)) {
        throw new ProbatError(
          allowExistingEquivalent ? 'PERSISTENCE_ERROR' : 'CONFLICT',
          `Immutable receipt '${receipt.id}' exists with different canonical content.`,
          allowExistingEquivalent ? 500 : 409,
        );
      }
    }

    const prospective = existing.filter((entry) => entry.id !== receipt.id);
    prospective.push(receipt);
    validateReceiptGraph(prospective, 'CONFLICT');
  }

  private async readAuditIfExists(id: string): Promise<Audit | null> {
    try {
      const content = await readFile(join(this.auditRoot, `${id}.json`), 'utf8');
      return parseStoredAudit(JSON.parse(content));
    } catch (error) {
      if (isMissingFile(error)) return null;
      if (error instanceof ProbatError) throw error;
      throw new ProbatError('PERSISTENCE_ERROR', `Audit '${id}' could not be read.`, 500, {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function parseStoredAudit(value: unknown): Audit {
  const audit = parseAuditCompatibility(value);
  const claims = audit.claims.map((claim) => {
    const hasLegacyProof =
      claim.evidenceVersion === 'legacy-unbound' &&
      (claim.verdict === 'verified' || claim.verdict === 'disproved' || Boolean(claim.latestReceiptId));
    return hasLegacyProof ? { ...claim, freshness: 'stale' as const } : claim;
  });
  return {
    ...audit,
    proofIntegrity:
      audit.proofIntegrity === 'typed-v2' &&
      claims
        .filter((claim) => claim.testability === 'testable')
        .every((claim) => claim.evidenceVersion === 'typed-v2')
        ? 'typed-v2'
        : 'legacy-present',
    claims,
  };
}

function isCurrentBoundProof(claim: Audit['claims'][number], verdict: 'verified' | 'disproved'): boolean {
  return (
    claim.verdict === verdict &&
    claim.freshness === 'current' &&
    claim.evidenceVersion === 'typed-v2' &&
    Boolean(claim.latestReceiptId)
  );
}

function assertExpectedRevision(
  auditId: string,
  current: Audit | null,
  expectedRevision: number | null,
): void {
  if (expectedRevision === null) {
    if (current) {
      throw new ProbatError('CONFLICT', `Audit '${auditId}' already exists.`, 409);
    }
    return;
  }
  if (!current || current.recordRevision !== expectedRevision) {
    throw new ProbatError(
      'CONFLICT',
      `Audit '${auditId}' changed concurrently; expected record revision ${expectedRevision}.`,
      409,
    );
  }
}

function assertHistoricalEvidenceUnchanged(current: Audit, requested: Audit): void {
  const runsPrefix = requested.runs.slice(0, current.runs.length);
  const receiptIdsPrefix = requested.receiptIds.slice(0, current.receiptIds.length);
  if (
    requested.runs.length < current.runs.length ||
    requested.receiptIds.length < current.receiptIds.length ||
    stableJson(runsPrefix) !== stableJson(current.runs) ||
    stableJson(receiptIdsPrefix) !== stableJson(current.receiptIds)
  ) {
    throw new ProbatError(
      'CONFLICT',
      'Historical runs and receipt references are append-only and cannot be changed or removed.',
      409,
    );
  }
}

function assertRecoveryTransaction(transaction: VerificationTransaction): void {
  if (
    transaction.baseAudit.id !== transaction.nextAudit.id ||
    transaction.nextAudit.recordRevision !== transaction.baseAudit.recordRevision + 1
  ) {
    throw new ProbatError(
      'CONFLICT',
      'Recovery journals must bind one audit revision to its exact predecessor.',
      409,
    );
  }
  assertVerificationAppend(
    transaction.baseAudit,
    transaction.nextAudit,
    transaction.receipt,
    transaction.version === 3,
  );
}

function assertVerificationAppend(
  current: Audit,
  requested: Audit,
  receipt: Receipt,
  allowLegacyV4 = false,
): void {
  assertHistoricalEvidenceUnchanged(current, requested);
  const appendedRun = requested.runs.at(-1);
  const currentClaim = current.claims.find((claim) => claim.id === receipt.claimId);
  const requestedClaim = requested.claims.find((claim) => claim.id === receipt.claimId);
  if (
    requested.runs.length !== current.runs.length + 1 ||
    requested.receiptIds.length !== current.receiptIds.length + 1 ||
    requested.id !== current.id ||
    requested.receiptIds.at(-1) !== receipt.id ||
    !appendedRun ||
    appendedRun.id !== receipt.kaneRunId ||
    appendedRun.auditId !== current.id ||
    appendedRun.claimId !== receipt.claimId ||
    receipt.auditId !== current.id ||
    !currentClaim ||
    !requestedClaim ||
    receipt.supersedesReceiptId !== currentClaim.latestReceiptId ||
    requestedClaim.latestReceiptId !== receipt.id ||
    ((receipt.version === 5 || receipt.version === 6 || receipt.version === 7) &&
      receipt.correctsReceiptId !== null &&
      !current.receiptIds.includes(receipt.correctsReceiptId))
  ) {
    throw new ProbatError(
      'CONFLICT',
      'Verification commits must append exactly one coherent run and immutable receipt supersession link.',
      409,
    );
  }
  assertVerificationStateTransition(current, requested, receipt, currentClaim, requestedClaim);
  assertReceiptMatchesRun(receipt, appendedRun, current, currentClaim, allowLegacyV4);
}

function assertVerificationStateTransition(
  current: Audit,
  requested: Audit,
  receipt: Receipt,
  currentClaim: Audit['claims'][number],
  requestedClaim: Audit['claims'][number],
): void {
  const stableAuditIdentity = (audit: Audit) => ({
    version: audit.version,
    id: audit.id,
    projectSlug: audit.projectSlug,
    proofIntegrity: audit.proofIntegrity,
    source: audit.source,
    target: audit.target,
    createdAt: audit.createdAt,
  });
  if (
    stableJson(stableAuditIdentity(current)) !== stableJson(stableAuditIdentity(requested)) ||
    requested.claims.length !== current.claims.length ||
    currentClaim.id !== requestedClaim.id ||
    requestedClaim.verdict !== receipt.verdict ||
    requestedClaim.freshness !== 'current'
  ) {
    throw new ProbatError(
      'CONFLICT',
      'Verification commits cannot rewrite audit identity, source, target, or unrelated claim state.',
      409,
    );
  }

  for (let index = 0; index < current.claims.length; index += 1) {
    const before = current.claims[index];
    const after = requested.claims[index];
    if (!before || !after || before.id !== after.id) {
      throw new ProbatError(
        'CONFLICT',
        'Verification commits must preserve claim ordering and identity.',
        409,
      );
    }
    if (before.id !== receipt.claimId) {
      if (stableJson(before) !== stableJson(after)) {
        throw new ProbatError(
          'CONFLICT',
          'Verification commits cannot modify unrelated claims.',
          409,
        );
      }
      continue;
    }
    const stableClaim = (claim: Audit['claims'][number]) => {
      const {
        verdict: _verdict,
        freshness: _freshness,
        latestReceiptId: _latestReceiptId,
        updatedAt: _updatedAt,
        ...stable
      } = claim;
      return stable;
    };
    if (stableJson(stableClaim(before)) !== stableJson(stableClaim(after))) {
      throw new ProbatError(
        'CONFLICT',
        'Verification commits cannot rewrite proof-defining claim fields.',
        409,
      );
    }
  }
}

function assertReceiptMatchesRun(
  receipt: Receipt,
  run: Audit['runs'][number] | undefined,
  audit: Audit,
  claim: Audit['claims'][number],
  allowLegacyV4: boolean,
): void {
  if (receipt.version === 4 && allowLegacyV4) {
    if (
      !run ||
      receipt.kaneRunId !== run.id ||
      receipt.verdict !== run.verdict ||
      receipt.exitCode !== run.exitCode ||
      receipt.terminalStatus !== run.terminalStatus ||
      receipt.claimSatisfied !== run.claimSatisfied
    ) {
      throw new ProbatError(
        'CONFLICT',
        'Receipt v4 terminal evidence must exactly match the appended Kane run.',
        409,
      );
    }
    return;
  }
  if (receipt.version !== 5 && receipt.version !== 6 && receipt.version !== 7) {
    throw new ProbatError(
      'CONFLICT',
      'New verification commits require a v6 or v7 receipt; historical recovery journals may carry v4 or v5.',
      409,
    );
  }
  if (
    !run ||
    receipt.kaneRunId !== run.id ||
    receipt.verdict !== run.verdict ||
    receipt.exitCode !== run.exitCode ||
    receipt.terminalStatus !== run.terminalStatus ||
    receipt.claimSatisfied !== run.claimSatisfied ||
    receipt.evidencePolicyVersion !== run.evidencePolicyVersion ||
    receipt.testHash !== run.testHash ||
    receipt.testHashBefore !== run.testHashBefore ||
    receipt.testHashAfter !== run.testHashAfter ||
    receipt.testBytesUnchanged !== run.testBytesUnchanged ||
    stableJson(receipt.protocol) !== stableJson(run.protocol) ||
    receipt.auditId !== audit.id ||
    receipt.claimId !== claim.id ||
    receipt.claimQuote !== claim.quote ||
    stableJson(receipt.citation) !== stableJson(claim.citation) ||
    receipt.sourceHash !== run.sourceHash ||
    receipt.sourceHash !== audit.source.contentHash ||
    receipt.targetFingerprint !== run.targetFingerprint ||
    receipt.targetFingerprint !== audit.target.fingerprint ||
    receipt.targetObservationHash !== run.targetObservationHash ||
    receipt.targetObservationHash !== targetObservationHash(audit.target.observation) ||
    ((receipt.version === 6 || receipt.version === 7) &&
      (run.targetBindingKind !== receipt.targetBindingKind ||
        run.targetRevision !== receipt.targetRevision ||
        audit.target.revision !== receipt.targetRevision ||
        run.targetManifestHash !== receipt.targetManifestHash ||
        run.targetEntrypointUrl !== receipt.targetEntrypointUrl ||
        run.targetEntrypointHash !== receipt.targetEntrypointHash ||
        audit.target.observation?.kind !== 'deployment-manifest-v2' ||
        receipt.targetManifestHash !== audit.target.observation.manifestHash ||
        receipt.targetEntrypointUrl !== audit.target.observation.entrypointUrl ||
        receipt.targetEntrypointHash !== audit.target.observation.entrypointHash)) ||
    receipt.assertionHash !== run.assertionHash ||
    receipt.assertionHash !== claim.assertionHash ||
    receipt.assertionPlanHash !== run.assertionPlanHash ||
    receipt.assertionPlanHash !== claim.assertionPlanHash ||
    receipt.testPath !== run.testPath ||
    receipt.testPath !== claim.testPath ||
    receipt.testFormatVersion !== run.testFormatVersion ||
    receipt.testFormatVersion !== claim.testFormatVersion ||
    receipt.targetUrl !== audit.target.url ||
    receipt.kaneTestUrl !== run.testUrl ||
    receipt.issuedAt !== run.completedAt ||
    receipt.summary !== run.summary
  ) {
    throw new ProbatError(
      'CONFLICT',
      `Receipt v${receipt.version} policy, protocol, hashes, and proof bindings must exactly match the appended Kane run.`,
      409,
    );
  }
}

function sanitizeAudit(audit: Audit): unknown {
  return {
    ...audit,
    source: sanitizeSource(audit.source),
    target: {
      ...audit.target,
      url: safePublicUrl(audit.target.url),
      observation: audit.target.observation
        ? {
            ...audit.target.observation,
            endpoint: safePublicUrl(audit.target.observation.endpoint),
            ...(audit.target.observation.kind === 'deployment-manifest-v2'
              ? {
                  targetOrigin: safePublicUrl(audit.target.observation.targetOrigin),
                  entrypointUrl: safePublicUrl(audit.target.observation.entrypointUrl),
                }
              : {}),
          }
        : null,
    },
    claims: audit.claims.map((claim) => ({
      ...claim,
      testPath: claim.testPath === null ? null : publicLocator(claim.testPath),
      citation: {
        ...claim.citation,
        locator:
          claim.citation.locator === audit.source.locator
            ? publicLocator(claim.citation.locator)
            : '[REDACTED]',
      },
    })),
    runs: audit.runs.map((run) => ({
      id: run.id,
      auditId: run.auditId,
      claimId: run.claimId,
      verdict: run.verdict,
      exitCode: run.exitCode,
      terminalStatus: run.terminalStatus,
      claimSatisfied: run.claimSatisfied ?? null,
      durationSeconds: run.durationSeconds,
      credits: run.credits,
      testUrl: safePublicUrl(run.testUrl),
      testPath: publicLocator(run.testPath),
      testHash: run.testHash,
      testHashBefore: run.testHashBefore,
      testHashAfter: run.testHashAfter,
      testBytesUnchanged: run.testBytesUnchanged,
      evidencePolicyVersion: run.evidencePolicyVersion,
      protocol: sanitizeProtocol(run.protocol),
      testFormatVersion: run.testFormatVersion,
      assertionHash: run.assertionHash,
      assertionPlanHash: run.assertionPlanHash,
      evidenceVersion: run.evidenceVersion,
      sourceHash: run.sourceHash,
      targetFingerprint: run.targetFingerprint,
      targetRevision: run.targetRevision,
      targetObservationHash: run.targetObservationHash,
      targetBindingKind: run.targetBindingKind,
      targetManifestHash: run.targetManifestHash,
      targetEntrypointUrl: safePublicUrl(run.targetEntrypointUrl),
      targetEntrypointHash: run.targetEntrypointHash,
      invalidOutputLines: run.invalidOutputLines,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
  };
}

function sanitizeReceipt(receipt: ReceiptView): unknown {
  const publishable: Record<string, unknown> = { ...receipt };
  delete publishable.summary;
  delete publishable.correctionReason;
  const structuredEvidence =
    receipt.version === 4 ||
    receipt.version === 5 ||
    receipt.version === 6 ||
    receipt.version === 7
      ? {
          exitCode: receipt.exitCode,
          terminalStatus: receipt.terminalStatus,
          claimSatisfied: receipt.claimSatisfied,
        }
      : { exitCode: null, terminalStatus: null, claimSatisfied: null };
  return {
    ...publishable,
    ...structuredEvidence,
    protocol:
      receipt.version === 5 || receipt.version === 6 || receipt.version === 7
        ? sanitizeProtocol(receipt.protocol)
        : undefined,
    targetEntrypointUrl:
      receipt.version === 6 || receipt.version === 7
        ? safePublicUrl(receipt.targetEntrypointUrl)
        : undefined,
    testPath: publicLocator(receipt.testPath),
    citation: { ...receipt.citation, locator: publicLocator(receipt.citation.locator) },
    targetUrl: safePublicUrl(receipt.targetUrl),
    kaneTestUrl: safePublicUrl(receipt.kaneTestUrl),
  };
}

type ReceiptGraphErrorCode = 'CONFLICT' | 'PERSISTENCE_ERROR';

function validateReceiptGraph(
  receipts: Receipt[],
  errorCode: ReceiptGraphErrorCode = 'PERSISTENCE_ERROR',
): void {
  const fail = (message: string): never => {
    throw new ProbatError(
      errorCode,
      `Invalid canonical receipt graph: ${message}`,
      errorCode === 'CONFLICT' ? 409 : 500,
    );
  };
  const byId = new Map<string, Receipt>();
  for (const receipt of receipts) {
    if (byId.has(receipt.id)) fail(`duplicate receipt ID '${receipt.id}'.`);
    byId.set(receipt.id, receipt);
  }

  for (const receipt of receipts) {
    const predecessorId = receipt.supersedesReceiptId;
    if (predecessorId === null) continue;
    if (predecessorId === receipt.id) {
      fail(`receipt '${receipt.id}' cannot supersede itself.`);
    }
    const predecessor =
      byId.get(predecessorId) ??
      fail(`receipt '${receipt.id}' references missing predecessor '${predecessorId}'.`);
    if (
      predecessor.auditId !== receipt.auditId ||
      predecessor.claimId !== receipt.claimId
    ) {
      fail(
        `receipt '${receipt.id}' predecessor '${predecessorId}' belongs to a different audit or claim.`,
      );
    }
    if (Date.parse(receipt.issuedAt) < Date.parse(predecessor.issuedAt)) {
      fail(`receipt '${receipt.id}' predates predecessor '${predecessorId}'.`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (receiptId: string): void => {
    if (visiting.has(receiptId)) fail(`supersession cycle includes receipt '${receiptId}'.`);
    if (visited.has(receiptId)) return;
    visiting.add(receiptId);
    const predecessorId = byId.get(receiptId)?.supersedesReceiptId;
    if (predecessorId !== null && predecessorId !== undefined) visit(predecessorId);
    visiting.delete(receiptId);
    visited.add(receiptId);
  };
  for (const receipt of receipts) visit(receipt.id);

  for (const receipt of receipts) {
    if (
      (receipt.version !== 5 && receipt.version !== 6 && receipt.version !== 7) ||
      receipt.supersessionReason !== 'correction'
    ) continue;
    const correctedId =
      receipt.correctsReceiptId ??
      fail(`correction receipt '${receipt.id}' has no corrected receipt target.`);
    const corrected =
      byId.get(correctedId) ??
      fail(`correction receipt '${receipt.id}' targets missing receipt '${correctedId}'.`);
    if (
      corrected.auditId !== receipt.auditId ||
      corrected.claimId !== receipt.claimId
    ) {
      fail(
        `correction receipt '${receipt.id}' target '${correctedId}' belongs to a different audit or claim.`,
      );
    }
    let ancestorId = receipt.supersedesReceiptId;
    let found = false;
    while (ancestorId !== null) {
      if (ancestorId === correctedId) {
        found = true;
        break;
      }
      ancestorId = byId.get(ancestorId)?.supersedesReceiptId ?? null;
    }
    if (!found) {
      fail(
        `correction receipt '${receipt.id}' target '${correctedId}' is not in its predecessor ancestry.`,
      );
    }
  }
}

export function deriveReceiptViews(receipts: Receipt[]): ReceiptView[] {
  validateReceiptGraph(receipts);
  const successorIds = new Map<string, Set<string>>();
  const correctedReceiptIds = new Set<string>();
  for (const receipt of receipts) {
    if (receipt.supersedesReceiptId) {
      const successors = successorIds.get(receipt.supersedesReceiptId) ?? new Set<string>();
      successors.add(receipt.id);
      successorIds.set(receipt.supersedesReceiptId, successors);
    }
    if (
      (receipt.version === 5 || receipt.version === 6 || receipt.version === 7) &&
      receipt.supersessionReason === 'correction' &&
      receipt.correctsReceiptId
    ) {
      correctedReceiptIds.add(receipt.correctsReceiptId);
    }
  }
  return receipts.map((receipt) => {
    const successors = [...(successorIds.get(receipt.id) ?? [])].sort();
    return {
      ...receipt,
      policyAssessment: {
        assessmentVersion: 1,
        validity: correctedReceiptIds.has(receipt.id)
          ? 'corrected'
          : receipt.version === 6 || receipt.version === 7
            ? 'current'
            : 'legacy',
        basis:
          receipt.version === 5 || receipt.version === 6 || receipt.version === 7
            ? 'receipt-declared'
            : 'receipt-version',
        declaredPolicyVersion:
          receipt.version === 5 || receipt.version === 6 || receipt.version === 7
            ? receipt.evidencePolicyVersion
            : null,
      },
      lineageStatus: successors.length === 0 ? 'current' : 'superseded',
      supersededByReceiptIds: successors,
    } satisfies ReceiptView;
  });
}

function sanitizeProtocol(protocol: Audit['runs'][number]['protocol']): unknown {
  if (!protocol) return null;
  return {
    valid: protocol.valid,
    mode: protocol.mode,
    error: protocol.error,
    runEndCount: protocol.runEndCount,
    testMdDoneCount: protocol.testMdDoneCount,
    correlationKey: protocol.correlationKey,
    correlationValueRecorded: protocol.correlationValue !== undefined,
  };
}

function sanitizeSource(source: Audit['source']): Audit['source'] {
  return {
    ...source,
    locator: publicLocator(source.locator),
  };
}

function publicLocator(value: string): string {
  const safeUrl = safePublicUrl(value);
  if (safeUrl) return safeUrl;
  if (
    value.length > 2_048 ||
    /[\u0000-\u001F\u007F]/.test(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^[\\/]/.test(value) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
  ) {
    return '[REDACTED]';
  }
  const normalized = value.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const forbidden = new Set(['.git', '.testmuai', '.context', 'data', 'private', 'node_modules']);
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === '.' ||
        segment === '..' ||
        forbidden.has(segment.toLowerCase()),
    )
  ) {
    return '[REDACTED]';
  }
  return normalized;
}

function safePublicUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const localHttp =
      url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
    if (url.protocol !== 'https:' && !localHttp) return null;
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

async function immutableJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (isAlreadyExists(error)) {
      throw new ProbatError('CONFLICT', `Immutable record '${path}' already exists.`, 409);
    }
    throw error;
  }
}

async function ensureImmutableJson(path: string, value: unknown): Promise<void> {
  try {
    const existing = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (stableJson(existing) !== stableJson(value)) {
      throw new ProbatError(
        'CONFLICT',
        `Immutable record '${path}' exists with different content.`,
        409,
      );
    }
  } catch (error) {
    if (isMissingFile(error)) {
      await immutableJsonWrite(path, value);
      return;
    }
    throw error;
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const backup = `${path}.${randomUUID()}.bak`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!isReplaceError(error)) {
      await rm(temporary, { force: true });
      throw error;
    }
    let hadExisting = true;
    try {
      await rename(path, backup);
    } catch (backupError) {
      if (isMissingFile(backupError)) hadExisting = false;
      else {
        await rm(temporary, { force: true });
        throw backupError;
      }
    }
    try {
      await rename(temporary, path);
      if (hadExisting) await rm(backup, { force: true });
    } catch (replacementError) {
      if (hadExisting) {
        try {
          await rename(backup, path);
        } catch {
          // The backup remains recoverable next to the destination.
        }
      }
      await rm(temporary, { force: true });
      throw replacementError;
    }
  }
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST');
}

function isReplaceError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error.code === 'EEXIST' || error.code === 'EPERM' || error.code === 'EACCES'),
  );
}
