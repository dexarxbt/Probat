import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { runProcess } from './process.js';
import { sha256 } from './hash.js';

const MAX_UNTRACKED_FINGERPRINT_BYTES = 25_000_000;

export async function gitFingerprint(filePath: string): Promise<string | null> {
  const cwd = dirname(filePath);
  try {
    const rootResult = await runProcess('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeoutMs: 10_000,
    });
    if (rootResult.exitCode !== 0) return null;
    const root = rootResult.stdout.trim();

    const [headResult, unstagedResult, stagedResult, statusResult, untrackedResult] =
      await Promise.all([
        runProcess('git', ['rev-parse', 'HEAD'], { cwd: root, timeoutMs: 10_000 }),
        runProcess('git', ['diff', '--no-ext-diff', '--binary'], {
          cwd: root,
          timeoutMs: 20_000,
        }),
        runProcess('git', ['diff', '--cached', '--no-ext-diff', '--binary'], {
          cwd: root,
          timeoutMs: 20_000,
        }),
        runProcess('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
          cwd: root,
          timeoutMs: 10_000,
        }),
        runProcess('git', ['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd: root,
          timeoutMs: 10_000,
        }),
      ]);

    const untrackedHashes: string[] = [];
    let totalBytes = 0;
    for (const relativePath of untrackedResult.stdout.split('\0').filter(Boolean).sort()) {
      try {
        const content = await readFile(join(root, relativePath));
        totalBytes += content.byteLength;
        if (totalBytes > MAX_UNTRACKED_FINGERPRINT_BYTES) {
          untrackedHashes.push('UNTRACKED_CONTENT_LIMIT_EXCEEDED');
          break;
        }
        untrackedHashes.push(`${relativePath}:${sha256(content)}`);
      } catch {
        untrackedHashes.push(`${relativePath}:UNREADABLE`);
      }
    }

    const head = headResult.exitCode === 0 ? headResult.stdout.trim() : 'unborn';
    return sha256(
      [
        head,
        statusResult.stdout,
        unstagedResult.stdout,
        stagedResult.stdout,
        ...untrackedHashes,
      ].join('\n'),
    );
  } catch {
    return null;
  }
}

export function targetFingerprint(targetUrl: string, targetRevision: string | null): string {
  return sha256(JSON.stringify({ targetUrl, targetRevision }));
}
