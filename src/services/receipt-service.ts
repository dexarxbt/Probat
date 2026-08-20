import { randomUUID } from 'node:crypto';
import type { Audit, Claim, KaneRun, Receipt } from '../domain/models.js';
import { indicatesAutomationFailure } from '../adapters/kane-adapter.js';
import { ProbatError } from '../domain/errors.js';
import { sha256, stableJson } from '../lib/hash.js';
import { compileBrowserAssertion } from './claim-extractor.js';

export class ReceiptService {
  issue(audit: Audit, claim: Claim, run: KaneRun): Receipt {
    const automationFailure = indicatesAutomationFailure(run.summary, run.reason);
    const coherentVerifiedRun =
      !automationFailure &&
      run.verdict === 'verified' &&
      run.exitCode === 0 &&
      run.terminalStatus === 'passed' &&
      run.claimSatisfied === true;
    const coherentDisprovedRun =
      !automationFailure &&
      run.verdict === 'disproved' &&
      run.exitCode === 1 &&
      run.terminalStatus === 'failed' &&
      run.claimSatisfied === false;
    if (!coherentVerifiedRun && !coherentDisprovedRun) {
      throw new ProbatError(
        'INVALID_STATE',
        'Proof Receipts require a coherent process exit, terminal status, and explicit structured claim result.',
        409,
      );
    }
    const terminalEvidence = coherentVerifiedRun
      ? {
          verdict: 'verified' as const,
          exitCode: 0 as const,
          terminalStatus: 'passed' as const,
          claimSatisfied: true as const,
        }
      : {
          verdict: 'disproved' as const,
          exitCode: 1 as const,
          terminalStatus: 'failed' as const,
          claimSatisfied: false as const,
        };
    const assertionHash = sha256(claim.quote);
    const compiledAssertion = compileBrowserAssertion(claim.quote);
    const assertionPlanHash = compiledAssertion ? sha256(stableJson(compiledAssertion)) : null;
    const observationHash = audit.target.observation?.responseHash ?? null;
    if (
      audit.target.fingerprintKind !== 'observed-revision-v2' ||
      !observationHash ||
      claim.auditId !== audit.id ||
      run.auditId !== audit.id ||
      run.claimId !== claim.id ||
      claim.assertionHash !== assertionHash ||
      !compiledAssertion ||
      !assertionPlanHash ||
      stableJson(claim.assertion) !== stableJson(compiledAssertion) ||
      claim.assertionPlanHash !== assertionPlanHash ||
      claim.evidenceVersion !== 'typed-v2' ||
      run.assertionHash !== assertionHash ||
      run.assertionPlanHash !== assertionPlanHash ||
      run.evidenceVersion !== 'typed-v2' ||
      run.sourceHash !== audit.source.contentHash ||
      run.targetFingerprint !== audit.target.fingerprint ||
      run.targetObservationHash !== observationHash ||
      run.testPath !== claim.testPath ||
      run.testHash !== claim.testHash ||
      run.testFormatVersion !== 2 ||
      claim.testFormatVersion !== 2 ||
      claim.freshness !== 'current'
    ) {
      throw new ProbatError(
        'INVALID_STATE',
        'Receipt issuance was blocked because assertion, source, observed target, immutable test, and run bindings do not match.',
        409,
      );
    }

    return {
      version: 4,
      evidenceStatus: 'typed-v2',
      id: `rcpt_${randomUUID()}`,
      auditId: audit.id,
      claimId: claim.id,
      claimQuote: claim.quote,
      assertionHash,
      assertionPlanHash,
      citation: claim.citation,
      ...terminalEvidence,
      sourceHash: run.sourceHash,
      targetUrl: audit.target.url,
      targetFingerprint: run.targetFingerprint,
      targetObservationHash: observationHash,
      testPath: run.testPath,
      testHash: run.testHash,
      testFormatVersion: 2,
      kaneRunId: run.id,
      kaneTestUrl: run.testUrl,
      summary: run.summary,
      issuedAt: run.completedAt,
      supersedesReceiptId: claim.latestReceiptId,
    };
  }
}
