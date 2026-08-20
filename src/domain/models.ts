import { z } from 'zod';

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

export const TargetObservationSchema = z.object({
  kind: z.literal('revision-marker-v1'),
  endpoint: HttpUrlSchema,
  declaredRevision: z.string().min(1),
  observedRevision: z.string().min(1),
  responseHash: Sha256Schema,
  observedAt: z.string().datetime(),
});
export type TargetObservation = z.infer<typeof TargetObservationSchema>;

export const TargetSchema = z.object({
  url: HttpUrlSchema,
  revision: z.string().nullable(),
  fingerprint: Sha256Schema,
  fingerprintKind: z.enum(['declared-v1', 'observed-revision-v2']).default('declared-v1'),
  observation: TargetObservationSchema.nullable().default(null),
});
export type Target = z.infer<typeof TargetSchema>;

export const BrowserAssertionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('title_contains'), expected: z.string().min(1).max(200) }),
  z.object({ kind: z.literal('link_text_present'), expected: z.string().min(1).max(200) }),
]);
export type BrowserAssertion = z.infer<typeof BrowserAssertionSchema>;

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
  testFormatVersion: z.literal(2).nullable().default(null),
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
  testFormatVersion: z.literal(2).nullable().default(null),
  assertionHash: Sha256Schema.nullable().default(null),
  assertionPlanHash: Sha256Schema.nullable().default(null),
  evidenceVersion: z.enum(['legacy-unbound', 'typed-v2']).default('legacy-unbound'),
  sourceHash: Sha256Schema,
  targetFingerprint: Sha256Schema,
  targetObservationHash: Sha256Schema.nullable().default(null),
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

export const ReceiptSchema = z.discriminatedUnion('version', [
  LegacyReceiptSchema,
  LegacyReceiptV2Schema,
  ReceiptV3Schema,
  ReceiptV4Schema,
]);
export type Receipt = z.infer<typeof ReceiptSchema>;

export const AuditSchema = z.object({
  version: z.literal(1),
  recordRevision: z.number().int().nonnegative().default(0),
  proofIntegrity: z.enum(['legacy-present', 'typed-v2']).default('legacy-present'),
  id: z.string().min(1),
  projectSlug: z.string().min(1),
  status: z.enum(['draft', 'ready', 'running', 'completed', 'blocked']),
  source: SourceSchema,
  target: TargetSchema,
  claims: z.array(ClaimSchema),
  runs: z.array(KaneRunSchema),
  receiptIds: z.array(z.string()),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Audit = z.infer<typeof AuditSchema>;

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
