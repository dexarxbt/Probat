import { z } from 'zod';
import {
  DeploymentManifestV2Schema,
  deploymentManifestFingerprint,
  isSafeManifestEntrypointPath,
  type DeploymentManifestObservation,
  type TargetObservation,
} from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { sha256, stableJson } from '../lib/hash.js';

const MAX_REVISION_BYTES = 1_024;
const MAX_MANIFEST_BYTES = 16 * 1_024;
const MAX_ENTRYPOINT_BYTES = 2 * 1_024 * 1_024;
const OBSERVATION_TIMEOUT_MS = 5_000;
const REVISION_PATH = '/.well-known/probat-revision';
const MANIFEST_PATH = '/.well-known/probat-manifest.json';
const JSON_CONTENT_TYPE = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const ENTRYPOINT_CONTENT_TYPE = /^(?:text\/html|application\/xhtml\+xml)(?:\s*;\s*charset=utf-8)?$/i;

export interface ObservedTarget {
  fingerprint: string;
  observation: TargetObservation;
}

export class TargetObserver {
  async observe(targetUrl: string, declaredRevision: string): Promise<ObservedTarget> {
    const target = parseCredentialFreeTarget(targetUrl);
    const endpoint = new URL(MANIFEST_PATH, target.origin);
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);

    try {
      const manifestResponse = await fetch(endpoint, {
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: { accept: 'application/json', 'user-agent': 'probat/0.1' },
      });
      requireSuccessfulResponse(manifestResponse, 'Deployment manifest');
      requireContentType(manifestResponse, JSON_CONTENT_TYPE, 'application/json', 'Deployment manifest');
      const manifestBytes = await readBoundedBody(
        manifestResponse,
        MAX_MANIFEST_BYTES,
        'Deployment manifest',
      );
      const manifest = parseStrictManifest(manifestBytes);
      if (manifest.revision !== declaredRevision) {
        throw new ProbatError(
          'INVALID_STATE',
          'The deployment manifest revision does not match the declared revision.',
          409,
        );
      }

      const entrypointUrl = resolveEntrypoint(target.origin, manifest.entrypoint);
      const entrypointResponse = await fetch(entrypointUrl, {
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: {
          accept: 'text/html, application/xhtml+xml',
          'user-agent': 'probat/0.1',
        },
      });
      requireSuccessfulResponse(entrypointResponse, 'Manifest entrypoint');
      requireContentType(
        entrypointResponse,
        ENTRYPOINT_CONTENT_TYPE,
        'text/html or application/xhtml+xml',
        'Manifest entrypoint',
      );
      const entrypointBytes = await readBoundedBody(
        entrypointResponse,
        MAX_ENTRYPOINT_BYTES,
        'Manifest entrypoint',
      );
      const observation: DeploymentManifestObservation = {
        kind: 'deployment-manifest-v2',
        endpoint: endpoint.toString(),
        targetOrigin: `${target.origin}/`,
        declaredRevision,
        observedRevision: manifest.revision,
        manifestHash: sha256(manifestBytes),
        entrypointUrl: entrypointUrl.toString(),
        entrypointHash: sha256(entrypointBytes),
        observedAt: new Date().toISOString(),
      };
      return {
        observation,
        fingerprint: deploymentManifestFingerprint({
          targetOrigin: target.origin,
          revision: observation.observedRevision,
          manifestHash: observation.manifestHash,
          entrypointUrl: observation.entrypointUrl,
          entrypointHash: observation.entrypointHash,
        }),
      };
    } catch (error) {
      throw observationError(error, 'Deployment manifest or entrypoint observation failed.');
    }
  }

  async observeLegacyRevision(
    targetUrl: string,
    declaredRevision: string,
  ): Promise<ObservedTarget> {
    const target = parseCredentialFreeTarget(targetUrl);
    const endpoint = new URL(REVISION_PATH, target.origin);
    const signal = AbortSignal.timeout(OBSERVATION_TIMEOUT_MS);

    try {
      const response = await fetch(endpoint, {
        credentials: 'omit',
        redirect: 'error',
        signal,
        headers: { accept: 'text/plain', 'user-agent': 'probat/0.1' },
      });
      requireSuccessfulResponse(response, 'Target revision marker');
      const bytes = await readBoundedBody(response, MAX_REVISION_BYTES, 'Target revision marker');
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
      throw observationError(error, `Target revision could not be observed at ${endpoint.toString()}.`);
    }
  }
}

function parseCredentialFreeTarget(targetUrl: string): URL {
  const target = new URL(targetUrl);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new ProbatError('INVALID_INPUT', 'Target URL must use HTTP or HTTPS.', 400);
  }
  if (target.username || target.password) {
    throw new ProbatError('INVALID_INPUT', 'Target URL credentials are not allowed.', 400);
  }
  return target;
}

function parseStrictManifest(bytes: Buffer): z.infer<typeof DeploymentManifestV2Schema> {
  let parsed: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ProbatError('INVALID_STATE', 'Deployment manifest must be valid UTF-8 JSON.', 409);
  }
  const result = DeploymentManifestV2Schema.safeParse(parsed);
  if (!result.success) {
    throw new ProbatError(
      'INVALID_STATE',
      'Deployment manifest must strictly contain version 2, revision, and entrypoint.',
      409,
    );
  }
  return result.data;
}

function resolveEntrypoint(origin: string, path: string): URL {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#')
  ) {
    throw new ProbatError(
      'INVALID_STATE',
      'Manifest entrypoint must be a root-relative same-origin path without query or hash.',
      409,
    );
  }
  if (!isSafeManifestEntrypointPath(path)) {
    throw new ProbatError(
      'INVALID_STATE',
      'Manifest entrypoint path traversal, encoded query/hash, or ambiguous escaping is not allowed.',
      409,
    );
  }
  const resolved = new URL(path, origin);
  if (resolved.origin !== origin || resolved.search || resolved.hash) {
    throw new ProbatError(
      'INVALID_STATE',
      'Manifest entrypoint must resolve on the target origin without query or hash.',
      409,
    );
  }
  return resolved;
}

function requireSuccessfulResponse(response: Response, label: string): void {
  if (!response.ok) {
    throw new ProbatError(
      'INVALID_STATE',
      `${label} returned HTTP ${response.status}; redirects and non-success statuses are not accepted.`,
      409,
    );
  }
}

function requireContentType(
  response: Response,
  pattern: RegExp,
  expected: string,
  label: string,
): void {
  const contentType = response.headers.get('content-type') ?? '';
  if (!pattern.test(contentType)) {
    throw new ProbatError(
      'INVALID_STATE',
      `${label} must use content type ${expected}.`,
      409,
    );
  }
}

async function readBoundedBody(response: Response, limit: number, label: string): Promise<Buffer> {
  const lengthHeader = response.headers.get('content-length');
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > limit) {
      await response.body?.cancel();
      throw new ProbatError('INVALID_STATE', `${label} exceeds the ${limit}-byte limit.`, 409);
    }
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new ProbatError('INVALID_STATE', `${label} exceeds the ${limit}-byte limit.`, 409);
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

function observationError(error: unknown, fallback: string): ProbatError {
  if (error instanceof ProbatError) return error;
  if (
    error instanceof Error &&
    (error.name === 'AbortError' || error.name === 'TimeoutError')
  ) {
    return new ProbatError('INVALID_STATE', 'Target observation timed out.', 409);
  }
  return new ProbatError('INVALID_STATE', fallback, 409, {
    cause: error instanceof Error ? error.message : String(error),
  });
}
