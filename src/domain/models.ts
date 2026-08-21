import { z } from 'zod';
import { sha256, stableJson } from '../lib/hash.js';

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, 'Expected a lowercase SHA-256 digest.');

export const HttpUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  }, 'URL must use HTTP or HTTPS.')
  .refine((value) => {
    const url = new URL(value);
    return !url.username && !url.password;
  }, 'URL credentials are not allowed.');

export const VerdictSchema = z.enum([
  'pending',
  'verified',
  'disproved',
  'blocked',
  'unverifiable',
  'error',
]);
export type Verdict = z.infer<typeof VerdictSchema>;

export const FreshnessSchema = z.enum(['current', 'stale']);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const ReviewStatusSchema = z.enum(['proposed', 'approved', 'rejected']);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const CitationSchema = z.object({
  locator: z.string().min(1),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  heading: z.string().nullable(),
});
export type Citation = z.infer<typeof CitationSchema>;

export const SourceSchema = z.object({
  kind: z.enum(['local', 'remote']),
  locator: z.string().min(1),
  displayName: z.string().min(1),
  contentHash: Sha256Schema,
  gitFingerprint: Sha256Schema.nullable(),
  fetchedAt: z.string().datetime(),
});
export type Source = z.infer<typeof SourceSchema>;

export const DeploymentManifestV2Schema = z
  .object({
    version: z.literal(2),
    revision: z.string().min(1).max(200),
    entrypoint: z.string().min(1).max(2_048),
  })
  .strict();
export type DeploymentManifestV2 = z.infer<typeof DeploymentManifestV2Schema>;

export const RevisionMarkerObservationSchema = z.object({
  kind: z.literal('revision-marker-v1'),
  endpoint: HttpUrlSchema,
  declaredRevision: z.string().min(1),
  observedRevision: z.string().min(1),
  responseHash: Sha256Schema,
  observedAt: z.string().datetime(),
});

export const DeploymentManifestObservationSchema = z.object({
  kind: z.literal('deployment-manifest-v2'),
  endpoint: HttpUrlSchema,
  targetOrigin: HttpUrlSchema,
  declaredRevision: z.string().min(1).max(200),
  observedRevision: z.string().min(1).max(200),
  manifestHash: Sha256Schema,
  entrypointUrl: HttpUrlSchema,
  entrypointHash: Sha256Schema,
  observedAt: z.string().datetime(),
});

export const TargetObservationSchema = z.discriminatedUnion('kind', [
  RevisionMarkerObservationSchema,
  DeploymentManifestObservationSchema,
]);
export type TargetObservation = z.infer<typeof TargetObservationSchema>;
export type DeploymentManifestObservation = z.infer<
  typeof DeploymentManifestObservationSchema
>;

const DEPLOYMENT_MANIFEST_PATH = '/.well-known/probat-manifest.json';

export interface ManifestFingerprintInput {
  targetOrigin: string;
  revision: string;
  manifestHash: string;
  entrypointUrl: string;
  entrypointHash: string;
}

export function deploymentManifestFingerprint(input: ManifestFingerprintInput): string {
  return sha256(
    stableJson({
      kind: 'observed-manifest-v3',
      targetOrigin: new URL(input.targetOrigin).origin,
      revision: input.revision,
      manifestHash: input.manifestHash,
      entrypointUrl: input.entrypointUrl,
      entrypointHash: input.entrypointHash,
    }),
  );
}

export function isSafeManifestEntrypointPath(path: string): boolean {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) return false;
  let decoded = path;
  for (let count = 0; count < 5; count += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (
        next.startsWith('//') ||
        next.includes('\\') ||
        next.includes('?') ||
        next.includes('#') ||
        next.split('/').some((segment) => segment === '.' || segment === '..')
      ) return false;
      if (next === decoded) return true;
      decoded = next;
    } catch {
      return false;
    }
  }
  return false;
}

export const TargetSchema = z
  .object({
    url: HttpUrlSchema,
    revision: z.string().nullable(),
    fingerprint: Sha256Schema,
    fingerprintKind: z
      .enum(['declared-v1', 'observed-revision-v2', 'observed-manifest-v3'])
      .default('declared-v1'),
    observation: TargetObservationSchema.nullable().default(null),
  })
  .superRefine((target, context) => {
    if (target.fingerprintKind !== 'observed-manifest-v3') return;
    const observation = target.observation;
    if (
      !observation ||
      observation.kind !== 'deployment-manifest-v2' ||
      target.revision !== observation.declaredRevision ||
      observation.declaredRevision !== observation.observedRevision
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest-bound targets require a coherent deployment-manifest-v2 observation.',
        path: ['observation'],
      });
      return;
    }
    const targetOrigin = new URL(target.url).origin;
    const endpoint = new URL(observation.endpoint);
    const observedOrigin = new URL(observation.targetOrigin);
    const entrypoint = new URL(observation.entrypointUrl);
    const expectedFingerprint = deploymentManifestFingerprint({
      targetOrigin,
      revision: observation.observedRevision,
      manifestHash: observation.manifestHash,
      entrypointUrl: entrypoint.toString(),
      entrypointHash: observation.entrypointHash,
    });
    if (
      observation.targetOrigin !== `${targetOrigin}/` ||
      observedOrigin.toString() !== `${targetOrigin}/` ||
      endpoint.toString() !== new URL(DEPLOYMENT_MANIFEST_PATH, targetOrigin).toString() ||
      entrypoint.origin !== targetOrigin ||
      new URL(target.url).toString() !== entrypoint.toString() ||
      entrypoint.toString() !== observation.entrypointUrl ||
      entrypoint.search !== '' ||
      entrypoint.hash !== '' ||
      !isSafeManifestEntrypointPath(entrypoint.pathname) ||
      target.fingerprint !== expectedFingerprint
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Manifest observation URLs and v3 fingerprint must canonically bind the target tuple.',
        path: ['observation'],
      });
    }
  });
export type Target = z.infer<typeof TargetSchema>;

export function targetObservationHash(observation: TargetObservation | null): string | null {
  if (!observation) return null;
  return observation.kind === 'deployment-manifest-v2'
    ? observation.manifestHash
    : observation.responseHash;
}

export function hasObservableTargetBinding(
  target: Pick<Target, 'revision' | 'fingerprintKind' | 'observation'>,
): boolean {
  if (!target.revision || !target.observation) return false;
  return (
    (target.fingerprintKind === 'observed-revision-v2' &&
      target.observation.kind === 'revision-marker-v1') ||
    (target.fingerprintKind === 'observed-manifest-v3' &&
      target.observation.kind === 'deployment-manifest-v2')
  );
}

export function hasCurrentTargetBinding(
  target: Pick<Target, 'revision' | 'fingerprintKind' | 'observation'>,
): boolean {
  return (
    target.revision !== null &&
    target.fingerprintKind === 'observed-manifest-v3' &&
    target.observation?.kind === 'deployment-manifest-v2'
  );
}

const BrowserAssertionOperandSchema = z.string().refine((value) => {
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= 200 && !/[\r\n]/.test(value);
}, 'Browser assertion operands must contain 1 to 200 characters after trimming and no line breaks.');

export const BrowserAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title_contains'), expected: BrowserAssertionOperandSchema }).strict(),
  z.object({ kind: z.literal('link_text_present'), expected: BrowserAssertionOperandSchema }).strict(),
  z.object({ kind: z.literal('heading_text_present'), expected: BrowserAssertionOperandSchema }).strict(),
  z.object({ kind: z.literal('visible_text_present'), expected: BrowserAssertionOperandSchema }).strict(),
  z.object({ kind: z.literal('button_text_present'), expected: BrowserAssertionOperandSchema }).strict(),
  z.object({ kind: z.literal('url_path_equals'), expected: BrowserAssertionOperandSchema }).strict(),
]);
export type BrowserAssertion = z.infer<typeof BrowserAssertionSchema>;

export const TestFormatVersionSchema = z.union([z.literal(2), z.literal(3)]);
export type TestFormatVersion = z.infer<typeof TestFormatVersionSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  auditId: z.string().min(1),
  quote: z.string().min(1),
  assertionHash: Sha256Schema.nullable().default(null),
  assertion: BrowserAssertionSchema.nullable().default(null),
  assertionPlanHash: Sha256Schema.nullable().default(null),
  evidenceVersion: z.enum(['legacy-unbound', 'typed-v2']).default('legacy-unbound'),
  normalized: z.string().min(1),
  citation: CitationSchema,
  testability: z.enum(['testable', 'unverifiable']),
  testabilityReason: z.string().min(1),
  reviewStatus: ReviewStatusSchema,
  verdict: VerdictSchema,
  freshness: FreshnessSchema,
  testPath: z.string().nullable(),
  testHash: z.string().nullable(),
  testFormatVersion: TestFormatVersionSchema.nullable().default(null),
  latestReceiptId: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ProgressEventSchema = z.object({
  step: z.number().int().positive(),
  status: z.string(),
  remark: z.string(),
});
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

export const KaneProtocolMetadataSchema = z
  .object({
    valid: z.boolean(),
    mode: z.enum(['keyed', 'ordered-unkeyed', 'invalid']),
    error: z.string().min(1).max(2_000).nullable(),
    runEndCount: z.number().int().nonnegative(),
    testMdDoneCount: z.number().int().nonnegative(),
    correlationKey: z
      .enum(['execution_id', 'run_id', 'session_id', 'commit_id', 'test_id'])
      .optional(),
    correlationValue: z.union([z.string().min(1).max(500), z.number().finite()]).optional(),
  })
  .strict()
  .superRefine((protocol, context) => {
    const validTerminalPair =
      protocol.valid &&
      protocol.mode !== 'invalid' &&
      protocol.error === null &&
      protocol.runEndCount === 1 &&
      protocol.testMdDoneCount === 1;
    const invalidProtocol =
      !protocol.valid && protocol.mode === 'invalid' && protocol.error !== null;
    if (!validTerminalPair && !invalidProtocol) {
      context.addIssue({
        code: 'custom',
        message: 'Kane protocol metadata must describe either one valid terminal pair or an explicit invalid protocol.',
        path: ['valid'],
      });
    }
    const hasKey = protocol.correlationKey !== undefined;
    const hasValue = protocol.correlationValue !== undefined;
    if (
      (protocol.mode === 'keyed' && (!hasKey || !hasValue)) ||
      (protocol.mode !== 'keyed' && (hasKey || hasValue))
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Keyed Kane protocol metadata requires one correlation key and value; other modes forbid them.',
        path: ['mode'],
      });
    }
  });
export type KaneProtocolMetadata = z.infer<typeof KaneProtocolMetadataSchema>;

export const KaneRunSchema = z.object({
  id: z.string().min(1),
  auditId: z.string().min(1),
  claimId: z.string().min(1),
  verdict: VerdictSchema,
  exitCode: z.number().int().nullable(),
  terminalStatus: z.string().nullable(),
  claimSatisfied: z.boolean().nullable().optional(),
  summary: z.string(),
  reason: z.string(),
  durationSeconds: z.number().nonnegative().nullable(),
  credits: z.number().nonnegative().nullable(),
  testUrl: z.string().url().nullable(),
  testPath: z.string().min(1),
  testHash: Sha256Schema,
  testHashBefore: Sha256Schema.nullable().default(null),
  testHashAfter: Sha256Schema.nullable().default(null),
  testBytesUnchanged: z.boolean().nullable().default(null),
  evidencePolicyVersion: z.union([z.literal(1), z.literal(2)]).nullable().default(null),
  protocol: KaneProtocolMetadataSchema.nullable().default(null),
  testFormatVersion: TestFormatVersionSchema.nullable().default(null),
  assertionHash: Sha256Schema.nullable().default(null),
  assertionPlanHash: Sha256Schema.nullable().default(null),
  evidenceVersion: z.enum(['legacy-unbound', 'typed-v2']).default('legacy-unbound'),
  sourceHash: Sha256Schema,
  targetFingerprint: Sha256Schema,
  targetRevision: z.string().min(1).max(200).nullable().default(null),
  targetObservationHash: Sha256Schema.nullable().default(null),
  targetBindingKind: z
    .enum(['revision-marker-v1', 'deployment-manifest-v2'])
    .nullable()
    .default(null),
  targetManifestHash: Sha256Schema.nullable().default(null),
  targetEntrypointUrl: HttpUrlSchema.nullable().default(null),
  targetEntrypointHash: Sha256Schema.nullable().default(null),
  progress: z.array(ProgressEventSchema),
  invalidOutputLines: z.number().int().nonnegative(),
  localSessionDir: z.string().nullable(),
  localRunDir: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
});
export type KaneRun = z.infer<typeof KaneRunSchema>;

const ReceiptBaseSchema = z.object({
  id: z.string().min(1),
  auditId: z.string().min(1),
  claimId: z.string().min(1),
  claimQuote: z.string().min(1),
  citation: CitationSchema,
  verdict: z.enum(['verified', 'disproved']),
  sourceHash: Sha256Schema,
  targetUrl: HttpUrlSchema,
  targetFingerprint: Sha256Schema,
  testPath: z.string().min(1),
  testHash: Sha256Schema,
  kaneRunId: z.string().min(1),
  kaneTestUrl: HttpUrlSchema.nullable(),
  summary: z.string(),
  issuedAt: z.string().datetime(),
  supersedesReceiptId: z.string().nullable(),
});

export const LegacyReceiptSchema = ReceiptBaseSchema.extend({
  version: z.literal(1),
  evidenceStatus: z.literal('legacy-unbound').default('legacy-unbound'),
});

export const LegacyReceiptV2Schema = ReceiptBaseSchema.extend({
  version: z.literal(2),
  assertionHash: Sha256Schema,
  testFormatVersion: z.literal(2),
  targetObservationHash: Sha256Schema,
  evidenceStatus: z.literal('legacy-unbound').default('legacy-unbound'),
});

export const ReceiptV3Schema = ReceiptBaseSchema.extend({
  version: z.literal(3),
  assertionHash: Sha256Schema,
  assertionPlanHash: Sha256Schema,
  testFormatVersion: z.literal(2),
  targetObservationHash: Sha256Schema,
  evidenceStatus: z.literal('typed-v2'),
});

export const ReceiptV4Schema = ReceiptBaseSchema.extend({
  version: z.literal(4),
  assertionHash: Sha256Schema,
  assertionPlanHash: Sha256Schema,
  testFormatVersion: z.literal(2),
  targetObservationHash: Sha256Schema,
  exitCode: z.union([z.literal(0), z.literal(1)]),
  terminalStatus: z.enum(['passed', 'failed']),
  claimSatisfied: z.boolean(),
  evidenceStatus: z.literal('typed-v2'),
}).superRefine((receipt, context) => {
  const verified =
    receipt.verdict === 'verified' &&
    receipt.exitCode === 0 &&
    receipt.terminalStatus === 'passed' &&
    receipt.claimSatisfied === true;
  const disproved =
    receipt.verdict === 'disproved' &&
    receipt.exitCode === 1 &&
    receipt.terminalStatus === 'failed' &&
    receipt.claimSatisfied === false;
  if (!verified && !disproved) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v4 verdict and terminal evidence must form a coherent tuple.',
      path: ['verdict'],
    });
  }
});

export const SupersessionReasonSchema = z.enum([
  'first',
  'retry',
  'freshness-renewal',
  'correction',
]);

export const ReceiptV5Schema = ReceiptBaseSchema.extend({
  version: z.literal(5),
  assertionHash: Sha256Schema,
  assertionPlanHash: Sha256Schema,
  testFormatVersion: z.literal(2),
  targetObservationHash: Sha256Schema,
  exitCode: z.union([z.literal(0), z.literal(1)]),
  terminalStatus: z.enum(['passed', 'failed']),
  claimSatisfied: z.boolean(),
  evidenceStatus: z.literal('typed-v2'),
  evidencePolicyVersion: z.literal(1),
  testHashBefore: Sha256Schema,
  testHashAfter: Sha256Schema,
  testBytesUnchanged: z.literal(true),
  protocol: KaneProtocolMetadataSchema,
  supersessionReason: SupersessionReasonSchema,
  correctsReceiptId: z.string().min(1).nullable(),
  correctionReason: z.string().min(1).max(2_000).nullable(),
}).superRefine((receipt, context) => {
  const verified =
    receipt.verdict === 'verified' &&
    receipt.exitCode === 0 &&
    receipt.terminalStatus === 'passed' &&
    receipt.claimSatisfied === true;
  const disproved =
    receipt.verdict === 'disproved' &&
    receipt.exitCode === 1 &&
    receipt.terminalStatus === 'failed' &&
    receipt.claimSatisfied === false;
  if (!verified && !disproved) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v5 verdict and terminal evidence must form a coherent tuple.',
      path: ['verdict'],
    });
  }
  if (!receipt.protocol.valid || receipt.protocol.mode === 'invalid') {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v5 requires valid strict Kane terminal protocol metadata.',
      path: ['protocol'],
    });
  }
  if (
    receipt.testHashBefore !== receipt.testHash ||
    receipt.testHashAfter !== receipt.testHash
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v5 requires identical canonical, pre-execution, and post-execution test hashes.',
      path: ['testHashAfter'],
    });
  }

  if (receipt.supersessionReason === 'first') {
    if (
      receipt.supersedesReceiptId !== null ||
      receipt.correctsReceiptId !== null ||
      receipt.correctionReason !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A first receipt cannot supersede or correct another receipt.',
        path: ['supersessionReason'],
      });
    }
  } else if (receipt.supersessionReason === 'correction') {
    if (
      receipt.supersedesReceiptId === null ||
      receipt.correctsReceiptId === null ||
      receipt.correctionReason === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A correction must identify its predecessor and corrected receipt and explain the correction.',
        path: ['supersessionReason'],
      });
    }
  } else if (
    receipt.supersedesReceiptId === null ||
    receipt.correctsReceiptId !== null ||
    receipt.correctionReason !== null
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Retry and freshness-renewal receipts require a predecessor and cannot declare correction fields.',
      path: ['supersessionReason'],
    });
  }
});

export const ReceiptV6Schema = ReceiptBaseSchema.extend({
  version: z.literal(6),
  assertionHash: Sha256Schema,
  assertionPlanHash: Sha256Schema,
  testFormatVersion: z.literal(2),
  targetObservationHash: Sha256Schema,
  targetBindingKind: z.literal('deployment-manifest-v2'),
  targetRevision: z.string().min(1).max(200),
  targetManifestHash: Sha256Schema,
  targetEntrypointUrl: HttpUrlSchema,
  targetEntrypointHash: Sha256Schema,
  exitCode: z.union([z.literal(0), z.literal(1)]),
  terminalStatus: z.enum(['passed', 'failed']),
  claimSatisfied: z.boolean(),
  evidenceStatus: z.literal('typed-v2'),
  evidencePolicyVersion: z.literal(2),
  testHashBefore: Sha256Schema,
  testHashAfter: Sha256Schema,
  testBytesUnchanged: z.literal(true),
  protocol: KaneProtocolMetadataSchema,
  supersessionReason: SupersessionReasonSchema,
  correctsReceiptId: z.string().min(1).nullable(),
  correctionReason: z.string().min(1).max(2_000).nullable(),
}).superRefine((receipt, context) => {
  const verified =
    receipt.verdict === 'verified' &&
    receipt.exitCode === 0 &&
    receipt.terminalStatus === 'passed' &&
    receipt.claimSatisfied === true;
  const disproved =
    receipt.verdict === 'disproved' &&
    receipt.exitCode === 1 &&
    receipt.terminalStatus === 'failed' &&
    receipt.claimSatisfied === false;
  if (!verified && !disproved) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v6 verdict and terminal evidence must form a coherent tuple.',
      path: ['verdict'],
    });
  }
  if (!receipt.protocol.valid || receipt.protocol.mode === 'invalid') {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v6 requires valid strict Kane terminal protocol metadata.',
      path: ['protocol'],
    });
  }
  if (
    receipt.testHashBefore !== receipt.testHash ||
    receipt.testHashAfter !== receipt.testHash
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v6 requires identical canonical, pre-execution, and post-execution test hashes.',
      path: ['testHashAfter'],
    });
  }
  if (receipt.targetObservationHash !== receipt.targetManifestHash) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v6 target observation hash must be the deployment manifest response hash.',
      path: ['targetObservationHash'],
    });
  }
  const receiptTargetOrigin = new URL(receipt.targetUrl).origin;
  const receiptEntrypoint = new URL(receipt.targetEntrypointUrl);
  if (
    new URL(receipt.targetUrl).toString() !== receiptEntrypoint.toString() ||
    receiptEntrypoint.origin !== receiptTargetOrigin ||
    receiptEntrypoint.toString() !== receipt.targetEntrypointUrl ||
    receiptEntrypoint.search !== '' ||
    receiptEntrypoint.hash !== '' ||
    !isSafeManifestEntrypointPath(receiptEntrypoint.pathname) ||
    receipt.targetFingerprint !==
      deploymentManifestFingerprint({
        targetOrigin: receiptTargetOrigin,
        revision: receipt.targetRevision,
        manifestHash: receipt.targetManifestHash,
        entrypointUrl: receipt.targetEntrypointUrl,
        entrypointHash: receipt.targetEntrypointHash,
      })
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v6 requires a canonical manifest-bound v3 target fingerprint.',
      path: ['targetFingerprint'],
    });
  }

  if (receipt.supersessionReason === 'first') {
    if (
      receipt.supersedesReceiptId !== null ||
      receipt.correctsReceiptId !== null ||
      receipt.correctionReason !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A first receipt cannot supersede or correct another receipt.',
        path: ['supersessionReason'],
      });
    }
  } else if (receipt.supersessionReason === 'correction') {
    if (
      receipt.supersedesReceiptId === null ||
      receipt.correctsReceiptId === null ||
      receipt.correctionReason === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A correction must identify its predecessor and corrected receipt and explain the correction.',
        path: ['supersessionReason'],
      });
    }
  } else if (
    receipt.supersedesReceiptId === null ||
    receipt.correctsReceiptId !== null ||
    receipt.correctionReason !== null
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Retry and freshness-renewal receipts require a predecessor and cannot declare correction fields.',
      path: ['supersessionReason'],
    });
  }
});

export const ReceiptV7Schema = ReceiptBaseSchema.extend({
  version: z.literal(7),
  assertionHash: Sha256Schema,
  assertionPlanHash: Sha256Schema,
  testFormatVersion: z.literal(3),
  targetObservationHash: Sha256Schema,
  targetBindingKind: z.literal('deployment-manifest-v2'),
  targetRevision: z.string().min(1).max(200),
  targetManifestHash: Sha256Schema,
  targetEntrypointUrl: HttpUrlSchema,
  targetEntrypointHash: Sha256Schema,
  exitCode: z.union([z.literal(0), z.literal(1)]),
  terminalStatus: z.enum(['passed', 'failed']),
  claimSatisfied: z.boolean(),
  evidenceStatus: z.literal('typed-v2'),
  evidencePolicyVersion: z.literal(2),
  testHashBefore: Sha256Schema,
  testHashAfter: Sha256Schema,
  testBytesUnchanged: z.literal(true),
  protocol: KaneProtocolMetadataSchema,
  supersessionReason: SupersessionReasonSchema,
  correctsReceiptId: z.string().min(1).nullable(),
  correctionReason: z.string().min(1).max(2_000).nullable(),
}).superRefine((receipt, context) => {
  const verified =
    receipt.verdict === 'verified' &&
    receipt.exitCode === 0 &&
    receipt.terminalStatus === 'passed' &&
    receipt.claimSatisfied === true;
  const disproved =
    receipt.verdict === 'disproved' &&
    receipt.exitCode === 1 &&
    receipt.terminalStatus === 'failed' &&
    receipt.claimSatisfied === false;
  if (!verified && !disproved) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v7 verdict and terminal evidence must form a coherent tuple.',
      path: ['verdict'],
    });
  }
  if (!receipt.protocol.valid || receipt.protocol.mode === 'invalid') {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v7 requires valid strict Kane terminal protocol metadata.',
      path: ['protocol'],
    });
  }
  if (
    receipt.testHashBefore !== receipt.testHash ||
    receipt.testHashAfter !== receipt.testHash
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v7 requires identical canonical, pre-execution, and post-execution test hashes.',
      path: ['testHashAfter'],
    });
  }
  if (receipt.targetObservationHash !== receipt.targetManifestHash) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v7 target observation hash must be the deployment manifest response hash.',
      path: ['targetObservationHash'],
    });
  }
  const receiptTargetOrigin = new URL(receipt.targetUrl).origin;
  const receiptEntrypoint = new URL(receipt.targetEntrypointUrl);
  if (
    new URL(receipt.targetUrl).toString() !== receiptEntrypoint.toString() ||
    receiptEntrypoint.origin !== receiptTargetOrigin ||
    receiptEntrypoint.toString() !== receipt.targetEntrypointUrl ||
    receiptEntrypoint.search !== '' ||
    receiptEntrypoint.hash !== '' ||
    !isSafeManifestEntrypointPath(receiptEntrypoint.pathname) ||
    receipt.targetFingerprint !==
      deploymentManifestFingerprint({
        targetOrigin: receiptTargetOrigin,
        revision: receipt.targetRevision,
        manifestHash: receipt.targetManifestHash,
        entrypointUrl: receipt.targetEntrypointUrl,
        entrypointHash: receipt.targetEntrypointHash,
      })
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Receipt v7 requires a canonical manifest-bound v3 target fingerprint.',
      path: ['targetFingerprint'],
    });
  }

  if (receipt.supersessionReason === 'first') {
    if (
      receipt.supersedesReceiptId !== null ||
      receipt.correctsReceiptId !== null ||
      receipt.correctionReason !== null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A first receipt cannot supersede or correct another receipt.',
        path: ['supersessionReason'],
      });
    }
  } else if (receipt.supersessionReason === 'correction') {
    if (
      receipt.supersedesReceiptId === null ||
      receipt.correctsReceiptId === null ||
      receipt.correctionReason === null
    ) {
      context.addIssue({
        code: 'custom',
        message: 'A correction must identify its predecessor and corrected receipt and explain the correction.',
        path: ['supersessionReason'],
      });
    }
  } else if (
    receipt.supersedesReceiptId === null ||
    receipt.correctsReceiptId !== null ||
    receipt.correctionReason !== null
  ) {
    context.addIssue({
      code: 'custom',
      message: 'Retry and freshness-renewal receipts require a predecessor and cannot declare correction fields.',
      path: ['supersessionReason'],
    });
  }
});

export const ReceiptSchema = z.discriminatedUnion('version', [
  LegacyReceiptSchema,
  LegacyReceiptV2Schema,
  ReceiptV3Schema,
  ReceiptV4Schema,
  ReceiptV5Schema,
  ReceiptV6Schema,
  ReceiptV7Schema,
]);
export type Receipt = z.infer<typeof ReceiptSchema>;
export type ReceiptV5 = z.infer<typeof ReceiptV5Schema>;
export type ReceiptV6 = z.infer<typeof ReceiptV6Schema>;
export type ReceiptV7 = z.infer<typeof ReceiptV7Schema>;

export interface ReceiptPolicyAssessment {
  assessmentVersion: 1;
  validity: 'legacy' | 'current' | 'corrected';
  basis: 'receipt-version' | 'receipt-declared';
  declaredPolicyVersion: number | null;
}

export type ReceiptView = Receipt & {
  policyAssessment: ReceiptPolicyAssessment;
  lineageStatus: 'current' | 'superseded';
  supersededByReceiptIds: string[];
};

export const AuditReviewStatusSchema = z.enum(['pending', 'in-review', 'complete']);
export type AuditReviewStatus = z.infer<typeof AuditReviewStatusSchema>;

export const AuditExecutionStatusSchema = z.enum([
  'not-ready',
  'ready',
  'running',
  'completed',
  'blocked',
]);
export type AuditExecutionStatus = z.infer<typeof AuditExecutionStatusSchema>;

export const AuditStatusSchema = z.enum(['draft', 'ready', 'running', 'completed', 'blocked']);
export type AuditStatus = z.infer<typeof AuditStatusSchema>;

interface AuditStatusInput {
  claims: readonly Pick<
    Claim,
    | 'reviewStatus'
    | 'testability'
    | 'verdict'
    | 'assertionHash'
    | 'assertion'
    | 'assertionPlanHash'
    | 'evidenceVersion'
  >[];
  target: Pick<Target, 'revision' | 'fingerprintKind' | 'observation'>;
}

export function deriveAuditReviewStatus(
  claims: readonly Pick<Claim, 'reviewStatus'>[],
): AuditReviewStatus {
  if (claims.every((claim) => claim.reviewStatus === 'proposed')) return 'pending';
  if (claims.some((claim) => claim.reviewStatus === 'proposed')) return 'in-review';
  return 'complete';
}

export function auditExecutionPrerequisitesReady(input: AuditStatusInput): boolean {
  const eligible = input.claims.filter(
    (claim) => claim.reviewStatus === 'approved' && claim.testability === 'testable',
  );
  return (
    eligible.length > 0 &&
    hasCurrentTargetBinding(input.target) &&
    eligible.every(
      (claim) =>
        claim.assertionHash !== null &&
        claim.assertion !== null &&
        claim.assertionPlanHash !== null &&
        claim.evidenceVersion === 'typed-v2',
    )
  );
}

export function deriveSettledAuditExecutionStatus(
  input: AuditStatusInput,
): Exclude<AuditExecutionStatus, 'running'> {
  const eligible = input.claims.filter(
    (claim) => claim.reviewStatus === 'approved' && claim.testability === 'testable',
  );
  if (eligible.some((claim) => claim.verdict === 'blocked' || claim.verdict === 'error')) {
    return 'blocked';
  }
  if (
    eligible.length > 0 &&
    eligible.every((claim) => claim.verdict === 'verified' || claim.verdict === 'disproved')
  ) {
    return 'completed';
  }
  return auditExecutionPrerequisitesReady(input) ? 'ready' : 'not-ready';
}

export function legacyStatusForExecutionStatus(
  executionStatus: AuditExecutionStatus,
): AuditStatus {
  return executionStatus === 'not-ready' ? 'draft' : executionStatus;
}

export function executionStatusFromLegacyStatus(status: AuditStatus): AuditExecutionStatus {
  return status === 'draft' ? 'not-ready' : status;
}

const AuditRecordSchema = z.object({
  version: z.literal(1),
  recordRevision: z.number().int().nonnegative().default(0),
  proofIntegrity: z.enum(['legacy-present', 'typed-v2']).default('legacy-present'),
  id: z.string().min(1),
  projectSlug: z.string().min(1),
  source: SourceSchema,
  target: TargetSchema,
  claims: z.array(ClaimSchema),
  runs: z.array(KaneRunSchema),
  receiptIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const AuditSchema = AuditRecordSchema.extend({
  reviewStatus: AuditReviewStatusSchema,
  executionStatus: AuditExecutionStatusSchema,
  status: AuditStatusSchema,
}).superRefine((audit, context) => {
  const expectedReviewStatus = deriveAuditReviewStatus(audit.claims);
  if (audit.reviewStatus !== expectedReviewStatus) {
    context.addIssue({
      code: 'custom',
      message: `Audit reviewStatus must be '${expectedReviewStatus}' for its claim decisions.`,
      path: ['reviewStatus'],
    });
  }

  const expectedExecutionStatus = deriveSettledAuditExecutionStatus(audit);
  if (
    (audit.executionStatus === 'running' && !auditExecutionPrerequisitesReady(audit)) ||
    (audit.executionStatus !== 'running' && audit.executionStatus !== expectedExecutionStatus)
  ) {
    context.addIssue({
      code: 'custom',
      message:
        audit.executionStatus === 'running'
          ? 'Audit executionStatus cannot be running until target and assertion prerequisites are ready.'
          : `Audit executionStatus must be '${expectedExecutionStatus}' for its current claims and prerequisites.`,
      path: ['executionStatus'],
    });
  }

  const expectedLegacyStatus = legacyStatusForExecutionStatus(audit.executionStatus);
  if (audit.status !== expectedLegacyStatus) {
    context.addIssue({
      code: 'custom',
      message: `Deprecated audit status must project executionStatus as '${expectedLegacyStatus}'.`,
      path: ['status'],
    });
  }
});
export type Audit = z.infer<typeof AuditSchema>;

export const LegacyStoredAuditSchema = AuditRecordSchema.extend({
  status: AuditStatusSchema,
}).strict();

const PreviouslyDerivedStoredAuditSchema = AuditRecordSchema.extend({
  reviewStatus: AuditReviewStatusSchema,
  executionStatus: AuditExecutionStatusSchema,
  status: AuditStatusSchema,
}).strict();

export const StoredAuditSchema = z
  .union([AuditSchema, PreviouslyDerivedStoredAuditSchema, LegacyStoredAuditSchema])
  .transform((audit): Audit => {
    const reviewStatus = deriveAuditReviewStatus(audit.claims);
    const requestedExecutionStatus =
      'executionStatus' in audit
        ? audit.executionStatus
        : executionStatusFromLegacyStatus(audit.status);
    const executionStatus =
      requestedExecutionStatus === 'running' && auditExecutionPrerequisitesReady(audit)
        ? 'running'
        : deriveSettledAuditExecutionStatus(audit);
    return AuditSchema.parse({
      ...audit,
      reviewStatus,
      executionStatus,
      status: legacyStatusForExecutionStatus(executionStatus),
    });
  });

export function parseStoredAudit(value: unknown): Audit {
  return StoredAuditSchema.parse(value);
}

export const CreateAuditInputSchema = z.object({
  project: z.string().min(1).max(100),
  readme: z.string().min(1).max(2_048),
  targetUrl: HttpUrlSchema,
  targetRevision: z.string().min(1).max(200).nullable().default(null),
});
export type CreateAuditInput = z.infer<typeof CreateAuditInputSchema>;

export const ReviewClaimInputSchema = z
  .object({
    decision: z.enum(['approve', 'reject', 'unverifiable']),
    reason: z.string().min(1).max(1_000).optional(),
  })
  .strict();
export type ReviewClaimInput = z.infer<typeof ReviewClaimInputSchema>;

export const VerifyOptionsSchema = z.object({
  headless: z.boolean().default(false),
  author: z.boolean().default(false),
  retry: z.boolean().default(false),
  push: z.boolean().default(false),
  timeoutSeconds: z.number().int().min(10).max(600).default(120),
});
export type ValidatedVerifyOptions = z.infer<typeof VerifyOptionsSchema>;

export const PortSchema = z.number().int().min(1).max(65_535);
