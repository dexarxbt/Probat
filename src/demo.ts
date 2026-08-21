import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type { Server } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { buildServer } from './api/server.js';
import { PortSchema } from './domain/models.js';
import {
  DEMO_TARGET_HOST,
  DEMO_TARGET_PORT,
  DEMO_TARGET_REVISION,
  listenDemoTarget,
} from './demo-target.js';
import { createContainer } from './services/container.js';

const PROBAT_HOST = '127.0.0.1';
const PROBAT_PORT = 4310;

export interface DemoRuntime {
  app: FastifyInstance;
  targetServer: Server;
  apiUrl: string;
  targetUrl: string;
  close(): Promise<void>;
}

export async function startDemo(
  workspaceRoot = process.cwd(),
  apiPort = PROBAT_PORT,
  targetPort = DEMO_TARGET_PORT,
): Promise<DemoRuntime> {
  const parsedApiPort = PortSchema.parse(apiPort);
  const parsedTargetPort = PortSchema.parse(targetPort);
  const target = await listenDemoTarget(parsedTargetPort, DEMO_TARGET_HOST);
  const container = createContainer(workspaceRoot);
  const app = buildServer(container, { defaultTargetUrl: target.url });

  try {
    await container.auditService.initialize();
    await app.listen({ host: PROBAT_HOST, port: parsedApiPort });
  } catch (error) {
    await closeHttpServer(target.server);
    throw error;
  }

  let closed = false;
  return {
    app,
    targetServer: target.server,
    apiUrl: `http://${PROBAT_HOST}:${parsedApiPort}`,
    targetUrl: target.url,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await Promise.all([app.close(), closeHttpServer(target.server)]);
    },
  };
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error) rejectClose(error);
      else resolveClose();
    });
  });
}

function envPort(name: string, fallback: number): number {
  const raw = process.env[name];
  return PortSchema.parse(raw === undefined || raw.trim() === '' ? fallback : Number(raw));
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isMainModule()) {
  startDemo(
    process.cwd(),
    envPort('PROBAT_PORT', PROBAT_PORT),
    envPort('DEMO_TARGET_PORT', DEMO_TARGET_PORT),
  )
    .then((runtime) => {
      process.stdout.write('\nProbat demonstration is ready.\n');
      process.stdout.write(`  Product UI:     ${runtime.apiUrl}/ui/\n`);
      process.stdout.write(`  Local API:      ${runtime.apiUrl}/api\n`);
      process.stdout.write(`  Browser target: ${runtime.targetUrl}\n`);
      process.stdout.write(
        `  Target manifest: ${runtime.targetUrl}/.well-known/probat-manifest.json (${DEMO_TARGET_REVISION})\n\n`,
      );
      process.stdout.write('Press Ctrl+C once to stop both local servers.\n');

      let shuttingDown = false;
      const shutdown = (): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        runtime.close().then(
          () => {
            process.exitCode = 0;
          },
          (error: unknown) => {
            process.stderr.write(
              `Demo shutdown failed: ${error instanceof Error ? error.message : String(error)}\n`,
            );
            process.exitCode = 1;
          },
        );
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `Demo startup failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    });
}
