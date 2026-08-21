import type { BrowserAssertion, Claim, ReviewClaimInput } from '../domain/models.js';
import { ProbatError } from '../domain/errors.js';
import { sha256, shortHash, stableJson } from '../lib/hash.js';
import type { LoadedReadme } from './readme-source.js';

const BEHAVIOR_PATTERN =
  /\b(supports?|allows?|provides?|persists?|preserves?|prevents?|rejects?|restores?|updates?|exports?|imports?|displays?|shows?|contains?|remains?|works?|requires?|includes?|can|will|does not|never|automatically)\b/i;
const SUBJECTIVE_PATTERN =
  /\b(best|fastest|easiest|beautiful|powerful|world[- ]class|seamless|intuitive|amazing|perfect|developer[- ]friendly)\b/i;
const NON_BROWSER_PATTERN =
  /\b(encrypted at rest|soc ?2|gdpr compliant|uptime|requests per second|zero vulnerabilities|military[- ]grade|bank[- ]grade)\b/i;

export function extractClaims(auditId: string, readme: LoadedReadme): Claim[] {
  const now = new Date().toISOString();
  const claims: Claim[] = [];
  const seen = new Set<string>();
  let heading: string | null = null;
  let inFence = false;

  for (let index = 0; index < readme.lines.length; index += 1) {
    const rawLine = readme.lines[index] ?? '';
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !trimmed) continue;
    if (/^#{1,6}\s+/.test(trimmed)) {
      heading = trimmed.replace(/^#{1,6}\s+/, '').trim();
      continue;
    }

    const isListItem = /^[-*+]\s+/.test(trimmed);
    const quote = trimmed
      .replace(/^[-*+]\s+/, '')
      .replace(/^\d+[.)]\s+/, '')
      .trim();
    if (quote.length < 12 || quote.length > 1_000) continue;
    if (!isListItem && !BEHAVIOR_PATTERN.test(quote)) continue;
    if (!BEHAVIOR_PATTERN.test(quote) && !SUBJECTIVE_PATTERN.test(quote)) continue;

    const normalized = normalizeClaim(quote);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const subjective = SUBJECTIVE_PATTERN.test(quote);
    const nonBrowser = NON_BROWSER_PATTERN.test(quote);
    const assertion = compileBrowserAssertion(quote);
    const testability = subjective || nonBrowser || !assertion ? 'unverifiable' : 'testable';
    const testabilityReason = subjective
      ? 'The statement is subjective and has no objective browser assertion.'
      : nonBrowser
        ? 'The statement requires non-browser evidence or specialist assurance.'
        : !assertion
          ? 'The statement does not match Probat’s constrained browser-assertion grammar.'
          : 'The statement compiles to a constrained browser assertion.';
    const id = `clm_${shortHash(`${auditId}:${index + 1}:${normalized}`)}`;

    claims.push({
      id,
      auditId,
      quote,
      assertionHash: sha256(quote),
      assertion,
      assertionPlanHash: assertion ? sha256(stableJson(assertion)) : null,
      evidenceVersion: assertion ? 'typed-v2' : 'legacy-unbound',
      normalized,
      citation: {
        locator: readme.source.locator,
        lineStart: index + 1,
        lineEnd: index + 1,
        heading,
      },
      testability,
      testabilityReason,
      reviewStatus: testability === 'unverifiable' ? 'approved' : 'proposed',
      verdict: testability === 'unverifiable' ? 'unverifiable' : 'pending',
      freshness: 'current',
      testPath: null,
      testHash: null,
      testFormatVersion: null,
      latestReceiptId: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return claims;
}

export function reviewClaim(claim: Claim, input: ReviewClaimInput): Claim {
  const now = new Date().toISOString();
  const assertionHash = sha256(claim.quote);
  const assertion = compileBrowserAssertion(claim.quote);
  const assertionPlanHash = assertion ? sha256(stableJson(assertion)) : null;
  if (input.decision === 'reject') {
    return {
      ...claim,
      assertionHash,
      assertion,
      assertionPlanHash,
      evidenceVersion: assertion ? 'typed-v2' : 'legacy-unbound',
      reviewStatus: 'rejected',
      verdict: 'pending',
      updatedAt: now,
    };
  }
  if (input.decision === 'unverifiable') {
    return {
      ...claim,
      assertionHash,
      assertion,
      assertionPlanHash,
      evidenceVersion: assertion ? 'typed-v2' : 'legacy-unbound',
      reviewStatus: 'approved',
      testability: 'unverifiable',
      testabilityReason: input.reason ?? 'A reviewer determined this claim is not browser-verifiable.',
      verdict: 'unverifiable',
      updatedAt: now,
    };
  }
  if (!assertion || !assertionPlanHash) {
    throw new ProbatError(
      'INVALID_INPUT',
      'This README quotation does not compile to Probat’s constrained browser-assertion grammar. Mark it unverifiable or edit and re-ingest the README.',
      400,
    );
  }
  return {
    ...claim,
    assertionHash,
    assertion,
    assertionPlanHash,
    evidenceVersion: 'typed-v2',
    reviewStatus: 'approved',
    testability: 'testable',
    testabilityReason: input.reason ?? 'A reviewer approved the exact README quotation as objective browser behavior.',
    verdict: 'pending',
    testPath: null,
    testHash: null,
    testFormatVersion: null,
    updatedAt: now,
  };
}

export function compileBrowserAssertion(quote: string): BrowserAssertion | null {
  const patterns: Array<{
    kind: BrowserAssertion['kind'];
    expressions: RegExp[];
  }> = [
    {
      kind: 'title_contains',
      expressions: [
        /^The page title contains "([^"\r\n]{1,200})"\.$/i,
        /^The page title contains “([^”\r\n]{1,200})”\.$/i,
      ],
    },
    {
      kind: 'link_text_present',
      expressions: [
        /^The page displays a link labeled "([^"\r\n]{1,200})"\.$/i,
        /^The page displays a link labeled “([^”\r\n]{1,200})”\.$/i,
      ],
    },
    {
      kind: 'heading_text_present',
      expressions: [
        /^The page displays a heading labeled "([^"\r\n]{1,200})"\.$/i,
        /^The page displays a heading labeled “([^”\r\n]{1,200})”\.$/i,
      ],
    },
    {
      kind: 'visible_text_present',
      expressions: [
        /^The page displays the text "([^"\r\n]{1,200})"\.$/i,
        /^The page displays the text “([^”\r\n]{1,200})”\.$/i,
      ],
    },
    {
      kind: 'button_text_present',
      expressions: [
        /^The page displays a button labeled "([^"\r\n]{1,200})"\.$/i,
        /^The page displays a button labeled “([^”\r\n]{1,200})”\.$/i,
      ],
    },
    {
      kind: 'url_path_equals',
      expressions: [
        /^The page URL path is "([^"\r\n]{1,200})"\.$/i,
        /^The page URL path is “([^”\r\n]{1,200})”\.$/i,
      ],
    },
  ];
  for (const pattern of patterns) {
    for (const expression of pattern.expressions) {
      const match = expression.exec(quote);
      const expected = match?.[1]?.trim();
      if (
        expected &&
        (pattern.kind !== 'url_path_equals' || isCanonicalRootRelativeUrlPath(expected))
      ) {
        return { kind: pattern.kind, expected };
      }
    }
  }
  return null;
}

function isCanonicalRootRelativeUrlPath(path: string): boolean {
  if (
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('?') ||
    path.includes('#') ||
    /[\u0000-\u001F\u007F]/.test(path) ||
    path.split('/').some((segment) => segment === '.' || segment === '..')
  ) {
    return false;
  }

  let decoded = path;
  for (let count = 0; count < 5; count += 1) {
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return false;
    }
    if (
      next.startsWith('//') ||
      next.includes('\\') ||
      next.includes('?') ||
      next.includes('#') ||
      next.split('/').some((segment) => segment === '.' || segment === '..')
    ) {
      return false;
    }
    if (next === decoded) break;
    decoded = next;
  }

  try {
    const parsed = new URL(path, 'https://probat.invalid/');
    return (
      parsed.origin === 'https://probat.invalid' &&
      parsed.pathname === path &&
      parsed.search === '' &&
      parsed.hash === ''
    );
  } catch {
    return false;
  }
}

function normalizeClaim(value: string): string {
  return value.toLowerCase().replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
}
