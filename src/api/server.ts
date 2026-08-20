import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  CreateAuditInputSchema,
  ReviewClaimInputSchema,
  VerifyOptionsSchema,
} from '../domain/models.js';
import { ProbatError, toProbatError } from '../domain/errors.js';
import type { ProbatContainer } from '../services/container.js';
import { registerUiRoutes, UI_CONTENT_SECURITY_POLICY } from '../ui/routes.js';

const AuditParamsSchema = z.object({ auditId: z.string().min(1) });
const ClaimParamsSchema = z.object({ auditId: z.string().min(1), claimId: z.string().min(1) });
const ReceiptParamsSchema = z.object({ receiptId: z.string().min(1) });
const VerifyBodySchema = VerifyOptionsSchema.extend({
  claimId: z.string().min(1).optional(),
});
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const LOOPBACK_AUTHORITY = /^(?:127\.0\.0\.1|localhost)(?::\d{1,5})?$/i;

export function buildServer(container: ProbatContainer): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.PROBAT_LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    bodyLimit: 256 * 1024,
    requestTimeout: 10 * 60 * 1_000,
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'INVALID_INPUT', message: 'The request was invalid.', issues: error.issues },
      });
    }
    const normalized = toProbatError(error);
    const body: Record<string, unknown> = {
      error: { code: normalized.code, message: normalized.message },
    };
    if (process.env.NODE_ENV !== 'production' && normalized.details) {
      body.details = normalized.details;
    }
    return reply.status(normalized.statusCode).send(body);
  });

  app.addHook('onRequest', async (request) => {
    if (request.headers.authorization) {
      throw new ProbatError(
        'INVALID_INPUT',
        'Probat is a local API and does not accept authorization credentials.',
        400,
      );
    }
    const authority = request.headers.host;
    if (!authority || !LOOPBACK_AUTHORITY.test(authority)) {
      throw new ProbatError(
        'INVALID_INPUT',
        'Probat accepts requests only through a loopback Host header.',
        400,
      );
    }
    const origin = request.headers.origin;
    if (origin && MUTATING_METHODS.has(request.method) && !isSameLoopbackOrigin(origin, authority)) {
      throw new ProbatError(
        'INVALID_INPUT',
        'Cross-origin browser mutations are not allowed by the local Probat API.',
        400,
      );
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cross-origin-opener-policy', 'same-origin')
      .header('x-frame-options', 'DENY');
    if (request.url === '/ui' || request.url.startsWith('/ui/')) {
      reply.header('content-security-policy', UI_CONTENT_SECURITY_POLICY);
    }
    return payload;
  });

  registerUiRoutes(app);

  app.get('/', async () => ({
    name: 'Probat API',
    version: '1.0.0',
    description: 'README claims backed by Kane proof receipts.',
    endpoints: '/api',
    interface: '/ui/',
  }));

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  app.get('/api', async () => ({
    interface: 'GET /ui/',
    resources: {
      doctor: 'GET /api/doctor',
      audits: 'GET|POST /api/audits',
      audit: 'GET /api/audits/:auditId',
      reviewClaim: 'PATCH /api/audits/:auditId/claims/:claimId',
      verify: 'POST /api/audits/:auditId/verify',
      freshness: 'POST /api/audits/:auditId/freshness',
      receipt: 'GET /api/receipts/:receiptId',
    },
  }));

  app.get('/api/doctor', async () => container.auditService.doctor());
  app.get('/api/audits', async () => ({ audits: await container.auditService.listAudits() }));

  app.post('/api/audits', async (request, reply) => {
    const input = CreateAuditInputSchema.parse(request.body);
    const audit = await container.auditService.createAudit(input);
    return reply.status(201).send(audit);
  });

  app.get('/api/audits/:auditId', async (request) => {
    const { auditId } = AuditParamsSchema.parse(request.params);
    return container.auditService.getAudit(auditId);
  });

  app.patch('/api/audits/:auditId/claims/:claimId', async (request) => {
    const { auditId, claimId } = ClaimParamsSchema.parse(request.params);
    const input = ReviewClaimInputSchema.parse(request.body);
    return container.auditService.reviewClaim(auditId, claimId, input);
  });

  app.post('/api/audits/:auditId/verify', async (request) => {
    const { auditId } = AuditParamsSchema.parse(request.params);
    const input = VerifyBodySchema.parse(request.body ?? {});
    if (input.claimId) {
      return container.auditService.verifyClaim(auditId, input.claimId, input);
    }
    return { results: await container.auditService.verifyAudit(auditId, input) };
  });

  app.post('/api/audits/:auditId/freshness', async (request) => {
    const { auditId } = AuditParamsSchema.parse(request.params);
    return container.auditService.refreshFreshness(auditId);
  });

  app.get('/api/receipts/:receiptId', async (request) => {
    const { receiptId } = ReceiptParamsSchema.parse(request.params);
    return container.auditService.getReceipt(receiptId);
  });

  return app;
}

function isSameLoopbackOrigin(origin: string, authority: string): boolean {
  try {
    const parsed = new URL(origin);
    const expected = new URL(`http://${authority}`);
    return (
      parsed.protocol === 'http:' &&
      parsed.origin.toLowerCase() === expected.origin.toLowerCase() &&
      LOOPBACK_AUTHORITY.test(parsed.host)
    );
  } catch {
    return false;
  }
}
