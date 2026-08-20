import type { TargetObservation } from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { sha256, stableJson } from '../lib/hash.js';

const MAX_REVISION_BYTES = 1_024;
const OBSERVATION_TIMEOUT_MS = 5_000;
const REVISION_PATH = '/.well-known/probat-revision';

export interface ObservedTarget {
  fingerprint: string;
  observation: TargetObservation;
}

export class TargetObserver {
  async observe(targetUrl: string, declaredRevision: string): Promise<ObservedTarget> {
    const target = new URL(targetUrl);
    if (target.username || target.password) {
      throw new ProbatError('INVALID_INPUT', 'Target URL credentials are not allowed.', 400);
    }
    const endpoint = new URL(REVISION_PATH, target.origin);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OBSERVATION_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        redirect: 'error',
        signal: controller.signal,
        headers: { accept: 'text/plain', 'user-agent': 'probat/0.1' },
      });
      if (!response.ok) {
        throw new ProbatError(
          'INVALID_STATE',
          `Target revision marker returned HTTP ${response.status}. Serve the declared revision as plain text at ${endpoint.toString()}.`,
          409,
        );
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_REVISION_BYTES) {
        throw new ProbatError('INVALID_STATE', 'Target revision marker exceeds 1 KB.', 409);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength > MAX_REVISION_BYTES) {
        throw new ProbatError('INVALID_STATE', 'Target revision marker exceeds 1 KB.', 409);
      }
      const observedRevision = bytes.toString('utf8').trim();
      if (observedRevision !== declaredRevision) {
        throw new ProbatError(
          'INVALID_STATE',
          'The target revision marker does not match the declared revision.',
          409,
        );
      }
      const observation: TargetObservation = {
        kind: 'revision-marker-v1',
        endpoint: endpoint.toString(),
        declaredRevision,
        observedRevision,
        responseHash: sha256(bytes),
        observedAt: new Date().toISOString(),
      };
      return {
        observation,
        fingerprint: sha256(
          stableJson({
            kind: observation.kind,
            endpoint: observation.endpoint,
            declaredRevision,
            observedRevision,
            responseHash: observation.responseHash,
          }),
        ),
      };
    } catch (error) {
      if (error instanceof ProbatError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProbatError('INVALID_STATE', 'Target revision observation timed out.', 409);
      }
      throw new ProbatError(
        'INVALID_STATE',
        `Target revision could not be observed at ${endpoint.toString()}.`,
        409,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
