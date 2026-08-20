import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ProgressEvent, Verdict } from '../domain/models.js';
import { runProcess, type ProcessResult } from '../lib/process.js';

export interface KaneTerminalEvent {
  status: string;
  summary: string;
  reason: string;
  durationSeconds: number | null;
  credits: number | null;
  testUrl: string | null;
  claimSatisfied: boolean | null;
  sessionDir: string | null;
  runDir: string | null;
}

export interface KaneExecution {
  id: string;
  verdict: Verdict;
  exitCode: number | null;
  terminal: KaneTerminalEvent | null;
  progress: ProgressEvent[];
  invalidOutputLines: number;
  stderrSummary: string;
  startedAt: string;
  completedAt: string;
}

export interface RunKaneTestInput {
  testPath: string;
  targetUrl: string;
  cwd: string;
  headless?: boolean;
  author?: boolean;
  retry?: boolean;
  push?: boolean;
  timeoutSeconds?: number;
}

export interface KaneDoctorResult {
  installed: boolean;
  authenticated: boolean;
  runnerReady: boolean;
  version: string | null;
  identitySummary: string;
  issues: string[];
}

export function kaneChildEnvironment(
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return platform === 'win32'
    ? { ...baseEnv, KANE_CLI_SYSTEM_NODE: '1' }
    : baseEnv;
}

export function kaneProcessTimeoutMs(timeoutSeconds: number): number {
  return (timeoutSeconds * 2 + 120) * 1_000;
}

export class KaneAdapter {
  private readonly executable: string;
  private readonly baseArgs: string[];
  private readonly runnerPath: string | null;
  private readonly childEnv: NodeJS.ProcessEnv;

  constructor() {
    this.childEnv = kaneChildEnvironment();
    const explicitPath = process.env.KANE_CLI_PATH;
    const windowsPackageRoot = process.env.APPDATA
      ? join(process.env.APPDATA, 'npm', 'node_modules', '@testmuai', 'kane-cli')
      : null;
    const windowsModule = windowsPackageRoot
      ? join(windowsPackageRoot, 'bin', 'kane-cli.cjs')
      : null;
    this.runnerPath = windowsPackageRoot
      ? join(
          windowsPackageRoot,
          'node_modules',
          '@testmuai',
          'kane-cli-win-x64',
          'bin',
          'v16-runner.exe',
        )
      : null;
    if (explicitPath) {
      this.executable = explicitPath;
      this.baseArgs = [];
    } else if (process.platform === 'win32' && windowsModule && existsSync(windowsModule)) {
      this.executable = process.execPath;
      this.baseArgs = [windowsModule];
    } else {
      this.executable = 'kane-cli';
      this.baseArgs = [];
    }
  }

  async doctor(cwd: string): Promise<KaneDoctorResult> {
    const issues: string[] = [];
    let version: string | null = null;
    let installed = false;
    let authenticated = false;
    let runnerReady = process.platform !== 'win32';
    let identitySummary = '';

    try {
      const versionResult = await runProcess(this.executable, [...this.baseArgs, '--version'], {
        cwd,
        env: this.childEnv,
        timeoutMs: 15_000,
      });
      installed = versionResult.exitCode === 0;
      version = installed ? stripTerminalNoise(versionResult.stdout || versionResult.stderr).trim() : null;
      if (!installed) issues.push('Kane CLI did not return a version successfully.');
    } catch {
      issues.push('Kane CLI is not installed or is not available on PATH.');
      return {
        installed: false,
        authenticated: false,
        runnerReady: false,
        version: null,
        identitySummary,
        issues,
      };
    }

    const identityResult = await runProcess(this.executable, [...this.baseArgs, 'whoami'], {
      cwd,
      env: this.childEnv,
      timeoutMs: 20_000,
    });
    identitySummary = redactSensitive(stripTerminalNoise(`${identityResult.stdout}\n${identityResult.stderr}`)).trim();
    authenticated = identityResult.exitCode === 0 && /authenticated/i.test(identitySummary);
    if (!authenticated) issues.push('Kane CLI is not authenticated. Run `kane-cli login`.');

    if (process.platform === 'win32') {
      if (!this.runnerPath || !existsSync(this.runnerPath)) {
        issues.push('Kane\'s Windows browser runner is missing from the npm installation.');
      } else {
        const runnerResult = await runProcess(this.runnerPath, ['--help'], {
          cwd,
          env: this.childEnv,
          timeoutMs: 15_000,
        });
        const runnerMessage = stripTerminalNoise(
          `${runnerResult.stdout}\n${runnerResult.stderr}`,
        ).trim();
        runnerReady =
          runnerResult.exitCode === 0 ||
          /pure execution backend|use kane-cli for interactive mode/i.test(runnerMessage);
        if (!runnerReady) {
          issues.push(
            /Application Control policy has blocked/i.test(runnerMessage)
              ? 'Windows Application Control is blocking Kane\'s signed v16-runner.exe. Ask the device administrator to allow the official TestMu AI runner; do not bypass the policy.'
              : `Kane's browser runner preflight failed${runnerMessage ? `: ${runnerMessage}` : '.'}`,
          );
        }
      }
    }

    return { installed, authenticated, runnerReady, version, identitySummary, issues };
  }

  async runTest(input: RunKaneTestInput): Promise<KaneExecution> {
    const timeoutSeconds = input.timeoutSeconds ?? 120;
    const args = [
      'testmd',
      'run',
      input.testPath,
      '--agent',
      '--url',
      input.targetUrl,
      '--timeout',
      String(timeoutSeconds),
    ];
    if (input.headless) args.push('--headless');
    if (input.author) args.push('--author');
    if (input.retry) args.push('--retry');
    if (input.push) args.push('--push');

    const startedAt = new Date().toISOString();
    let result: ProcessResult;
    try {
      result = await runProcess(this.executable, [...this.baseArgs, ...args], {
        cwd: input.cwd,
        env: this.childEnv,
        timeoutMs: kaneProcessTimeoutMs(timeoutSeconds),
        maxOutputBytes: 10_000_000,
      });
    } catch (error) {
      return {
        id: `run_${randomUUID()}`,
        verdict: 'blocked',
        exitCode: null,
        terminal: null,
        progress: [],
        invalidOutputLines: 0,
        stderrSummary: redactSensitive(
          `Kane CLI could not be started: ${error instanceof Error ? error.message : String(error)}`,
        ).slice(0, 2_000),
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    const parsed = parseKaneOutput(result.stdout);
    const verdict = classifyKaneResult(
      result,
      parsed.terminal,
      parsed.invalidOutputLines,
    );
    return {
      id: `run_${randomUUID()}`,
      verdict,
      exitCode: result.exitCode,
      terminal: parsed.terminal,
      progress: parsed.progress,
      invalidOutputLines: parsed.invalidOutputLines,
      stderrSummary: summarizeStderr(result.stderr),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

export function parseKaneOutput(stdout: string): {
  terminal: KaneTerminalEvent | null;
  progress: ProgressEvent[];
  invalidOutputLines: number;
} {
  const progress: ProgressEvent[] = [];
  let latestRunEnd: KaneTerminalEvent | null = null;
  let terminal: KaneTerminalEvent | null = null;
  let invalidOutputLines = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = stripTerminalNoise(rawLine).trim();
    if (!line) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      invalidOutputLines += 1;
      continue;
    }
    if (!isRecord(value)) {
      invalidOutputLines += 1;
      continue;
    }
    if (value.type === 'run_end') {
      latestRunEnd = {
        status: stringValue(value.status, 'unknown'),
        summary: stringValue(value.summary, ''),
        reason: stringValue(value.reason, ''),
        durationSeconds: numberValue(value.duration),
        credits: numberValue(value.credits_consumed) ?? numberValue(value.credits),
        testUrl: nullableUrl(value.test_url),
        claimSatisfied: claimSatisfiedValue(value),
        sessionDir: nullableString(value.session_dir),
        runDir: nullableString(value.run_dir),
      };
      continue;
    }
    if (value.type === 'test_md_done' && latestRunEnd) {
      terminal = {
        ...latestRunEnd,
        status: stringValue(value.overall_status, 'unknown'),
        durationSeconds: numberValue(value.duration_s) ?? latestRunEnd.durationSeconds,
        testUrl: nullableUrl(value.share_url) ?? latestRunEnd.testUrl,
      };
      continue;
    }
    if (typeof value.step === 'number' && typeof value.status === 'string') {
      progress.push({
        step: Math.max(1, Math.trunc(value.step)),
        status: value.status,
        remark: stringValue(value.remark, ''),
      });
    }
  }

  return { terminal, progress, invalidOutputLines };
}

export function classifyKaneResult(
  result: ProcessResult,
  terminal: KaneTerminalEvent | null,
  invalidOutputLines = 0,
): Verdict {
  if (result.timedOut || result.exitCode === 3 || invalidOutputLines > 0) return 'blocked';
  if (!terminal || indicatesAutomationFailure(terminal.summary, terminal.reason)) return 'blocked';
  if (
    result.exitCode === 0 &&
    terminal.status === 'passed' &&
    terminal.claimSatisfied === true
  ) {
    return 'verified';
  }
  if (
    result.exitCode === 1 &&
    terminal.status === 'failed' &&
    terminal.claimSatisfied === false
  ) {
    return 'disproved';
  }
  if (result.exitCode === 2) return 'blocked';
  return 'blocked';
}

export function indicatesAutomationFailure(summary: string, reason: string): boolean {
  const report = `${summary}\n${reason}`;
  return (
    /\b(?:automation_bug|agent_misstep)\b/i.test(report) ||
    /\bautomation\b[^\n]{0,200}\b(?:did not|failed|failure|incorrect|wrong|unset)\b/i.test(report) ||
    /\bagent[_ -]?(?:misstep|error)\b/i.test(report)
  );
}

function summarizeStderr(value: string): string {
  const clean = redactSensitive(stripTerminalNoise(value))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-8)
    .join('\n');
  return clean.slice(0, 2_000);
}

function redactSensitive(value: string): string {
  return value
    .replace(/(access[-_ ]?key|token|password|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]');
}

function stripTerminalNoise(value: string): string {
  return value.replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanResult(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function claimSatisfiedValue(value: unknown): boolean | null {
  if (!isRecord(value)) return null;

  const candidates: unknown[] = [];
  const finalState = isRecord(value.final_state) ? value.final_state : null;
  if (finalState && 'claim_satisfied' in finalState) {
    candidates.push(finalState.claim_satisfied);
  }

  const context = isRecord(value.context) ? value.context : null;
  const memory = context && isRecord(context.memory) ? context.memory : null;
  const memoryClaim = memory && isRecord(memory.claim_satisfied)
    ? memory.claim_satisfied
    : null;
  if (memoryClaim && 'extracted_value' in memoryClaim) {
    candidates.push(memoryClaim.extracted_value);
  }

  const variables = context && isRecord(context.variables) ? context.variables : null;
  const contextClaim = variables && isRecord(variables.claim_satisfied)
    ? variables.claim_satisfied
    : null;
  if (contextClaim && 'value' in contextClaim) {
    candidates.push(contextClaim.value);
  }

  const variablesOut = isRecord(value.variables_out) ? value.variables_out : null;
  const outputClaim = variablesOut && isRecord(variablesOut.claim_satisfied)
    ? variablesOut.claim_satisfied
    : null;
  if (outputClaim && 'value' in outputClaim) {
    candidates.push(outputClaim.value);
  }

  if (candidates.length === 0) return null;
  const parsed = candidates.map(booleanResult);
  const first = parsed[0];
  if (first === null || first === undefined) return null;
  return parsed.every((candidate) => candidate === first) ? first : null;
}

function nullableUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value).toString();
  } catch {
    return null;
  }
}
