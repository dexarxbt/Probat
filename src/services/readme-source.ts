import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve } from 'node:path';
import { ProbatError } from '../domain/errors.js';
import type { Source } from '../domain/models.js';
import { gitFingerprint } from '../lib/fingerprint.js';
import { sha256 } from '../lib/hash.js';

const MAX_SOURCE_BYTES = 1_000_000;
const ALLOWED_REMOTE_HOSTS = new Set(['github.com', 'raw.githubusercontent.com']);

export interface LoadedReadme {
  source: Source;
  content: string;
  lines: string[];
  localPath: string | null;
}

export class ReadmeSourceService {
  constructor(private readonly workspaceRoot: string) {}

  async load(locator: string): Promise<LoadedReadme> {
    if (/^https:\/\//i.test(locator)) return this.loadRemote(locator);
    if (/^[a-z]+:\/\//i.test(locator)) {
      throw new ProbatError(
        'SOURCE_NOT_ALLOWED',
        'Remote README sources must use HTTPS.',
        400,
      );
    }
    return this.loadLocal(locator);
  }

  private async loadLocal(locator: string): Promise<LoadedReadme> {
    const resolvedPath = isAbsolute(locator) ? resolve(locator) : resolve(this.workspaceRoot, locator);
    const location = relative(this.workspaceRoot, resolvedPath);
    if (location.startsWith('..') || isAbsolute(location)) {
      throw new ProbatError(
        'SOURCE_NOT_ALLOWED',
        'Local README files must be inside the Probat workspace.',
        400,
      );
    }
    if (!['.md', '.markdown'].includes(extname(resolvedPath).toLowerCase())) {
      throw new ProbatError('INVALID_INPUT', 'The README source must be a Markdown file.', 400);
    }

    let details;
    let canonicalPath: string;
    try {
      details = await stat(resolvedPath);
      canonicalPath = await realpath(resolvedPath);
    } catch {
      throw new ProbatError('SOURCE_NOT_FOUND', `README '${locator}' was not found.`, 404);
    }
    const canonicalWorkspace = await realpath(this.workspaceRoot);
    const canonicalLocation = relative(canonicalWorkspace, canonicalPath);
    if (canonicalLocation.startsWith('..') || isAbsolute(canonicalLocation)) {
      throw new ProbatError(
        'SOURCE_NOT_ALLOWED',
        'README symlinks must resolve inside the Probat workspace.',
        400,
      );
    }
    if (!details.isFile()) {
      throw new ProbatError('INVALID_INPUT', `README '${locator}' is not a file.`, 400);
    }
    if (details.size > MAX_SOURCE_BYTES) {
      throw new ProbatError('SOURCE_TOO_LARGE', 'README exceeds the 1 MB limit.', 413);
    }

    const content = normalizeNewlines(await readFile(resolvedPath, 'utf8'));
    return {
      source: {
        kind: 'local',
        locator: location.replaceAll('\\', '/'),
        displayName: basename(resolvedPath),
        contentHash: sha256(content),
        gitFingerprint: await gitFingerprint(resolvedPath),
        fetchedAt: new Date().toISOString(),
      },
      content,
      lines: content.split('\n'),
      localPath: resolvedPath,
    };
  }

  private async loadRemote(locator: string): Promise<LoadedReadme> {
    const requested = new URL(locator);
    if (
      requested.protocol !== 'https:' ||
      requested.username ||
      requested.password ||
      requested.search ||
      requested.hash ||
      requested.port
    ) {
      throw new ProbatError(
        'SOURCE_NOT_ALLOWED',
        'Remote README URLs must be credential-free HTTPS URLs without a port, query, or fragment.',
        400,
      );
    }
    if (!ALLOWED_REMOTE_HOSTS.has(requested.hostname.toLowerCase())) {
      throw new ProbatError(
        'SOURCE_NOT_ALLOWED',
        'Remote sources are limited to public GitHub README URLs.',
        400,
      );
    }
    const fetchUrl = toRawGitHubUrl(requested);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const response = await fetch(fetchUrl, {
        redirect: 'error',
        signal: controller.signal,
        headers: { 'user-agent': 'probat/0.1' },
      });
      if (!response.ok) {
        throw new ProbatError(
          'SOURCE_NOT_FOUND',
          `GitHub returned HTTP ${response.status} for the README.`,
          response.status === 404 ? 404 : 502,
        );
      }
      const declaredLength = Number(response.headers.get('content-length') ?? '0');
      if (declaredLength > MAX_SOURCE_BYTES) {
        throw new ProbatError('SOURCE_TOO_LARGE', 'README exceeds the 1 MB limit.', 413);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength > MAX_SOURCE_BYTES) {
        throw new ProbatError('SOURCE_TOO_LARGE', 'README exceeds the 1 MB limit.', 413);
      }
      const content = normalizeNewlines(buffer.toString('utf8'));
      return {
        source: {
          kind: 'remote',
          locator: fetchUrl.toString(),
          displayName: basename(fetchUrl.pathname) || 'README.md',
          contentHash: sha256(content),
          gitFingerprint: null,
          fetchedAt: new Date().toISOString(),
        },
        content,
        lines: content.split('\n'),
        localPath: null,
      };
    } catch (error) {
      if (error instanceof ProbatError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ProbatError('SOURCE_NOT_FOUND', 'README request timed out.', 504);
      }
      throw new ProbatError('SOURCE_NOT_FOUND', 'README could not be downloaded.', 502);
    } finally {
      clearTimeout(timer);
    }
  }
}

function toRawGitHubUrl(url: URL): URL {
  if (url.hostname.toLowerCase() === 'raw.githubusercontent.com') return url;
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2] !== 'blob') {
    throw new ProbatError(
      'INVALID_INPUT',
      'GitHub URLs must point to a Markdown file, for example /owner/repo/blob/main/README.md.',
      400,
    );
  }
  return new URL(
    `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`,
  );
}

function normalizeNewlines(content: string): string {
  return content.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
}
