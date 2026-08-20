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
  ReceiptSchema,
  ReceiptV4Schema,
  type Audit,
  type Receipt,
} from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { stableJson } from '../lib/hash.js';

const VerificationTransactionSchema = z.object({
  version: z.literal(3),
  baseAudit: AuditSchema,
  nextAudit: AuditSchema,
  receipt: ReceiptV4Schema,
});
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
    const parsedReceipt = ReceiptV4Schema.parse(receipt);
    await this.initialize();
    const current = await this.readAuditIfExists(requestedAudit.id);
    assertExpectedRevision(requestedAudit.id, current, expectedRevision);
    if (!current) {
      throw new ProbatError('CONFLICT', `Audit '${requestedAudit.id}' no longer exists.`, 409);
    }
    assertVerificationAppend(current, requestedAudit, parsedReceipt);
    const nextAudit = AuditSchema.parse({
      ...requestedAudit,
      recordRevision: expectedRevision + 1,
    });
    const journalPath = join(this.transactionRoot, `${parsedReceipt.id}.json`);
    const transaction: VerificationTransaction = {
      version: 3,
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

  async getReceipt(id: string): Promise<Receipt> {
    await this.initialize();
    try {
      const content = await readFile(join(this.receiptRoot, `${id}.json`), 'utf8');
      return ReceiptSchema.parse(JSON.parse(content));
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
        } catch {
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
    for (const audit of audits) {
      await atomicJsonWrite(
        join(this.publicRoot, 'audits', `${audit.id}.json`),
        sanitizeAudit(audit),
      );
    }
    const receiptFiles = (await readdir(this.receiptRoot)).filter((file) => file.endsWith('.json'));
    for (const file of receiptFiles) {
      const receipt = ReceiptSchema.parse(
        JSON.parse(await readFile(join(this.receiptRoot, file), 'utf8')),
      );
      await atomicJsonWrite(
        join(this.publicRoot, 'receipts', `${receipt.id}.json`),
        sanitizeReceipt(receipt),
      );
    }
    if (audits[0]) await this.exportPublicAudit(audits[0]);
  }

  private async exportPublicReceipt(receipt: Receipt): Promise<void> {
    await mkdir(join(this.publicRoot, 'receipts'), { recursive: true });
    await atomicJsonWrite(
      join(this.publicRoot, 'receipts', `${receipt.id}.json`),
      sanitizeReceipt(receipt),
    );
  }

  private async exportPublicAudit(audit: Audit): Promise<void> {
    await mkdir(join(this.publicRoot, 'audits'), { recursive: true });
    await atomicJsonWrite(
      join(this.publicRoot, 'audits', `${audit.id}.json`),
      sanitizeAudit(audit),
    );

    const audits = await this.listAuditsWithoutExport();
    const byId = new Map(audits.map((entry) => [entry.id, entry]));
    byId.set(audit.id, audit);
    await atomicJsonWrite(join(this.publicRoot, 'index.json'), {
      generatedAt: new Date().toISOString(),
      audits: [...byId.values()]
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .map((entry) => ({
          id: entry.id,
          projectSlug: entry.projectSlug,
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
          blocked: entry.claims.filter((claim) => claim.verdict === 'blocked').length,
          unverifiable: entry.claims.filter((claim) => claim.verdict === 'unverifiable').length,
          updatedAt: entry.updatedAt,
        })),
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
  const audit = AuditSchema.parse(value);
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
  );
}

function assertVerificationAppend(current: Audit, requested: Audit, receipt: Receipt): void {
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
    requestedClaim.latestReceiptId !== receipt.id
  ) {
    throw new ProbatError(
      'CONFLICT',
      'Verification commits must append exactly one coherent run and immutable receipt supersession link.',
      409,
    );
  }
  assertV4ReceiptMatchesRun(receipt, appendedRun);
}

function assertV4ReceiptMatchesRun(
  receipt: Receipt,
  run: Audit['runs'][number] | undefined,
): void {
  if (receipt.version !== 4) {
    throw new ProbatError(
      'CONFLICT',
      'New verification commits and recovery journals require a v4 receipt.',
      409,
    );
  }
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
      testFormatVersion: run.testFormatVersion,
      assertionHash: run.assertionHash,
      assertionPlanHash: run.assertionPlanHash,
      evidenceVersion: run.evidenceVersion,
      sourceHash: run.sourceHash,
      targetFingerprint: run.targetFingerprint,
      targetObservationHash: run.targetObservationHash,
      invalidOutputLines: run.invalidOutputLines,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
  };
}

function sanitizeReceipt(receipt: Receipt): unknown {
  const { summary: _privateSummary, ...publishable } = receipt;
  const structuredEvidence =
    receipt.version === 4
      ? {
          exitCode: receipt.exitCode,
          terminalStatus: receipt.terminalStatus,
          claimSatisfied: receipt.claimSatisfied,
        }
      : { exitCode: null, terminalStatus: null, claimSatisfied: null };
  return {
    ...publishable,
    ...structuredEvidence,
    testPath: publicLocator(receipt.testPath),
    citation: { ...receipt.citation, locator: publicLocator(receipt.citation.locator) },
    targetUrl: safePublicUrl(receipt.targetUrl),
    kaneTestUrl: safePublicUrl(receipt.kaneTestUrl),
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
