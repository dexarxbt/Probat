#!/usr/bin/env node
import { ZodError } from 'zod';
import { buildServer } from './api/server.js';
import { ProbatError, errorMessage } from './domain/errors.js';
import { PortSchema, VerifyOptionsSchema } from './domain/models.js';
import { createContainer } from './services/container.js';

interface ParsedArgs {
  command: string;
  options: Map<string, string | boolean>;
  positionals: string[];
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const container = createContainer();
  await container.auditService.initialize();

  switch (args.command) {
    case 'doctor': {
      const result = await container.auditService.doctor();
      printJson(result);
      process.exitCode = result.installed && result.authenticated && result.runnerReady ? 0 : 2;
      return;
    }
    case 'ingest':
    case 'audit': {
      const audit = await container.auditService.createAudit({
        project: requiredOption(args, 'project'),
        readme: requiredOption(args, 'readme'),
        targetUrl: requiredOption(args, 'target'),
        targetRevision: optionalString(args, 'revision') ?? null,
      });
      printJson(audit);
      return;
    }
    case 'list': {
      printJson({ audits: await container.auditService.listAudits() });
      return;
    }
    case 'show': {
      printJson(await container.auditService.getAudit(requiredOption(args, 'audit')));
      return;
    }
    case 'review': {
      const decision = requiredOption(args, 'decision');
      if (!['approve', 'reject', 'unverifiable'].includes(decision)) {
        throw new ProbatError(
          'INVALID_INPUT',
          '--decision must be approve, reject, or unverifiable.',
          400,
        );
      }
      if (args.options.has('expected')) {
        throw new ProbatError(
          'INVALID_INPUT',
          '--expected is not supported because verification must use the exact immutable README quotation.',
          400,
        );
      }
      const audit = await container.auditService.reviewClaim(
        requiredOption(args, 'audit'),
        requiredOption(args, 'claim'),
        {
          decision: decision as 'approve' | 'reject' | 'unverifiable',
          ...(optionalString(args, 'reason') ? { reason: optionalString(args, 'reason') } : {}),
        },
      );
      printJson(audit);
      return;
    }
    case 'verify': {
      const auditId = requiredOption(args, 'audit');
      const claimId = optionalString(args, 'claim');
      const timeoutSeconds = optionalNumber(args, 'timeout');
      const options = VerifyOptionsSchema.parse({
        headless: booleanOption(args, 'headless'),
        author: booleanOption(args, 'author'),
        retry: booleanOption(args, 'retry'),
        push: booleanOption(args, 'push'),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
      });
      if (claimId) {
        const result = await container.auditService.verifyClaim(auditId, claimId, options);
        printJson(result);
        process.exitCode = verificationExitCode([result.run.verdict]);
      } else {
        const results = await container.auditService.verifyAudit(auditId, options);
        printJson({ results });
        process.exitCode = verificationExitCode(results.map((result) => result.run.verdict));
      }
      return;
    }
    case 'freshness': {
      printJson(await container.auditService.refreshFreshness(requiredOption(args, 'audit')));
      return;
    }
    case 'receipt': {
      printJson(await container.auditService.getReceipt(requiredOption(args, 'id')));
      return;
    }
    case 'serve': {
      const host = optionalString(args, 'host') ?? '127.0.0.1';
      const port = PortSchema.parse(optionalNumber(args, 'port') ?? 4310);
      if (host !== '127.0.0.1' && host !== 'localhost') {
        throw new ProbatError(
          'INVALID_INPUT',
          'Probat is local-only and may bind only to 127.0.0.1 or localhost.',
          400,
        );
      }
      const app = buildServer(container);
      await app.listen({ host, port });
      process.stdout.write(`Probat UI listening on http://${host}:${port}/ui/\n`);
      process.stdout.write(`Probat API available at http://${host}:${port}/api\n`);
      return;
    }
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new ProbatError(
        'INVALID_INPUT',
        `Unknown command '${args.command}'. Run 'npm run probat -- help'.`,
        400,
      );
  }
}

function parseArgs(values: string[]): ParsedArgs {
  const command = values[0] ?? 'help';
  const options = new Map<string, string | boolean>();
  const positionals: string[] = [];
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!value) continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const equals = value.indexOf('=');
    if (equals > 2) {
      options.set(value.slice(2, equals), value.slice(equals + 1));
      continue;
    }
    const key = value.slice(2);
    const next = values[index + 1];
    if (next && !next.startsWith('--')) {
      options.set(key, next);
      index += 1;
    } else {
      options.set(key, true);
    }
  }
  return { command, options, positionals };
}

function requiredOption(args: ParsedArgs, name: string): string {
  const value = args.options.get(name);
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProbatError('INVALID_INPUT', `Missing required option --${name}.`, 400);
  }
  return value.trim();
}

function optionalString(args: ParsedArgs, name: string): string | undefined {
  const value = args.options.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function booleanOption(args: ParsedArgs, name: string): boolean {
  const value = args.options.get(name);
  if (value === true) return true;
  return typeof value === 'string' && ['true', '1', 'yes'].includes(value.toLowerCase());
}

function optionalNumber(args: ParsedArgs, name: string): number | undefined {
  const value = optionalString(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    throw new ProbatError('INVALID_INPUT', `--${name} must be a positive integer.`, 400);
  }
  return parsed;
}

function verificationExitCode(verdicts: string[]): number {
  if (verdicts.some((verdict) => verdict === 'blocked' || verdict === 'error')) return 2;
  if (verdicts.some((verdict) => verdict === 'disproved')) return 1;
  return 0;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printHelp(): void {
  process.stdout.write(`Probat — README claims backed by Kane proof receipts.
Targets with --revision must serve a strict same-origin deployment manifest at /.well-known/probat-manifest.json.

Commands:
  doctor
  ingest --project <name> --readme <path|github-url> --target <url> [--revision <id>]
  audit  --project <name> --readme <path|github-url> --target <url> [--revision <id>]
  list
  show --audit <id>
  review --audit <id> --claim <id> --decision <approve|reject|unverifiable>
  verify --audit <id> [--claim <id>] [--headless] [--author] [--retry] [--push] [--timeout <seconds>]
  freshness --audit <id>
  receipt --id <id>
  serve [--host 127.0.0.1] [--port 4310]  # UI at /ui/

Examples:
  npm run demo
  npm run doctor
  npm run probat -- ingest --project proof-demo --readme fixtures/example/README.md --target http://127.0.0.1:4321 --revision probat-demo-v1
  npm run probat -- review --audit <id> --claim <id> --decision approve
  npm run probat -- verify --audit <id> --claim <id> --headless
  npm run dev
`);
}

main().catch((error: unknown) => {
  if (error instanceof ZodError) {
    process.stderr.write(`INVALID_INPUT: ${error.issues.map((issue) => issue.message).join('; ')}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof ProbatError) {
    process.stderr.write(`${error.code}: ${error.message}\n`);
    process.exitCode = error.statusCode >= 500 ? 2 : 1;
    return;
  }
  process.stderr.write(`INTERNAL_ERROR: ${errorMessage(error)}\n`);
  process.exitCode = 2;
});
