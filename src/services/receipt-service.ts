import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type {
  Audit,
  Claim,
  KaneRun,
  ReceiptV6,
  ReceiptV7,
} from '../domain/models.js';
import { ReceiptV6Schema, ReceiptV7Schema } from '../domain/models.js';
import { indicatesAutomationFailure } from '../adapters/kane-adapter.js';
import { ProbatError } from '../domain/errors.js';
import { sha256, stableJson } from '../lib/hash.js';
import { compileBrowserAssertion } from './claim-extractor.js';
import { testFormatVersionForAssertion } from './test-generator.js';

const ReceiptIssuanceIntentSchema = z.discriminatedUnion('supersessionReason', [
  z.object({ supersessionReason: z.literal('first') }).strict(),
  z.object({ supersessionReason: z.literal('retry') }).strict(),
  z.object({ supersessionReason: z.literal('freshness-renewal') }).strict(),
  z
    .object({
      supersessionReason: z.literal('correction'),
      correctsReceiptId: z.string().trim().min(1),
      correctionReason: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

export type ReceiptIssuanceIntent = z.infer<typeof ReceiptIssuanceIntentSchema>;

export class ReceiptService {
  issue(
    audit: Audit,
    claim: Claim,
    run: KaneRun,
    rawIntent: ReceiptIssuanceIntent,
  ): ReceiptV6 | ReceiptV7 {
    const intent = ReceiptIssuanceIntentSchema.parse(rawIntent);
    const hasPredecessor = claim.latestReceiptId !== null;
    if (
      (intent.supersessionReason === 'first' && hasPredecessor) ||
      (intent.supersessionReason !== 'first' && !hasPredecessor)
    ) {
      throw new ProbatError(
        'INVALID_STATE',
        intent.supersessionReason === 'first'
          ? 'First receipt issuance requires a claim with no predecessor.'
          : 'Non-first receipt issuance requires the claim latest receipt as predecessor.',
        409,
      );
    }

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
    const mappedTestFormatVersion = compiledAssertion
      ? testFormatVersionForAssertion(compiledAssertion)
      : null;
    const targetObservation = audit.target.observation;
    const observationHash =
      targetObservation?.kind === 'deployment-manifest-v2'
        ? targetObservation.manifestHash
        : null;
    if (
      audit.target.fingerprintKind !== 'observed-manifest-v3' ||
      targetObservation?.kind !== 'deployment-manifest-v2' ||
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
      run.targetRevision !== audit.target.revision ||
      run.targetObservationHash !== observationHash ||
      run.targetBindingKind !== targetObservation.kind ||
      run.targetManifestHash !== targetObservation.manifestHash ||
      run.targetEntrypointUrl !== targetObservation.entrypointUrl ||
      run.targetEntrypointHash !== targetObservation.entrypointHash ||
      run.testPath !== claim.testPath ||
      run.testHash !== claim.testHash ||
      run.testFormatVersion !== mappedTestFormatVersion ||
      run.evidencePolicyVersion !== 2 ||
      run.testHashBefore !== run.testHash ||
      run.testHashAfter !== run.testHash ||
      run.testBytesUnchanged !== true ||
      !run.protocol ||
      !run.protocol.valid ||
      run.protocol.mode === 'invalid' ||
      run.protocol.error !== null ||
      run.protocol.runEndCount !== 1 ||
      run.protocol.testMdDoneCount !== 1 ||
      claim.testFormatVersion !== mappedTestFormatVersion ||
      claim.freshness !== 'current'
    ) {
      throw new ProbatError(
        'INVALID_STATE',
        'Receipt issuance was blocked because assertion, source, observed target, immutable test, and run bindings do not match.',
        409,
      );
    }

    const receipt = {
      version: mappedTestFormatVersion === 2 ? 6 : 7,
      evidenceStatus: 'typed-v2',
      evidencePolicyVersion: 2,
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
      targetBindingKind: targetObservation.kind,
      targetRevision: audit.target.revision,
      targetManifestHash: targetObservation.manifestHash,
      targetEntrypointUrl: targetObservation.entrypointUrl,
      targetEntrypointHash: targetObservation.entrypointHash,
      testPath: run.testPath,
      testHash: run.testHash,
      testHashBefore: run.testHashBefore,
      testHashAfter: run.testHashAfter,
      testBytesUnchanged: run.testBytesUnchanged,
      testFormatVersion: mappedTestFormatVersion,
      protocol: run.protocol,
      kaneRunId: run.id,
      kaneTestUrl: run.testUrl,
      summary: run.summary,
      issuedAt: run.completedAt,
      supersedesReceiptId: claim.latestReceiptId,
      supersessionReason: intent.supersessionReason,
      correctsReceiptId:
        intent.supersessionReason === 'correction' ? intent.correctsReceiptId : null,
      correctionReason:
        intent.supersessionReason === 'correction' ? intent.correctionReason : null,
    };
    return mappedTestFormatVersion === 2
      ? ReceiptV6Schema.parse(receipt)
      : ReceiptV7Schema.parse(receipt);
  }
}
