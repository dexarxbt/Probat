import { createServer, type Server, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const DEMO_TARGET_HOST = '127.0.0.1';
export const DEMO_TARGET_PORT = 4321;
export const DEMO_TARGET_REVISION = 'probat-demo-v1';

const DEMO_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Example Domain</title>
</head>
<body>
  <main>
    <h1>Example Domain</h1>
    <p>This deterministic page is the local Probat verification target.</p>
    <a href="/more-information">More information</a>
  </main>
</body>
</html>
`;

export function createDemoTarget(): Server {
  return createServer((request, response) => {
    const method = request.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'Method Not Allowed', method === 'HEAD');
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    } catch {
      send(response, 400, 'text/plain; charset=utf-8', 'Bad Request', method === 'HEAD');
      return;
    }

    if (pathname === '/.well-known/probat-revision') {
      send(
        response,
        200,
        'text/plain; charset=utf-8',
        DEMO_TARGET_REVISION,
        method === 'HEAD',
      );
      return;
    }
    if (pathname === '/health') {
      send(response, 200, 'application/json; charset=utf-8', '{"status":"ok"}\n', method === 'HEAD');
      return;
    }
    if (pathname === '/' || pathname === '/more-information') {
      send(response, 200, 'text/html; charset=utf-8', DEMO_HTML, method === 'HEAD');
      return;
    }
    send(response, 404, 'text/plain; charset=utf-8', 'Not Found', method === 'HEAD');
  });
}

export async function listenDemoTarget(
  port = DEMO_TARGET_PORT,
  host = DEMO_TARGET_HOST,
): Promise<{ server: Server; url: string }> {
  if (host !== DEMO_TARGET_HOST && host !== 'localhost') {
    throw new Error('The demo target may bind only to 127.0.0.1 or localhost.');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('DEMO_TARGET_PORT must be an integer from 1 to 65535.');
  }
  const server = createDemoTarget();
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return { server, url: `http://${host}:${port}` };
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  headOnly: boolean,
): void {
  const bytes = Buffer.from(body, 'utf8');
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(bytes.byteLength),
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    'content-type': contentType,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  });
  response.end(headOnly ? undefined : bytes);
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEMO_TARGET_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error('DEMO_TARGET_PORT must be an integer from 1 to 65535.');
  }
  return parsed;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && pathToFileURL(resolve(entry)).href === import.meta.url);
}

if (isMainModule()) {
  const port = parsePort(process.env.DEMO_TARGET_PORT);
  listenDemoTarget(port)
    .then(({ server, url }) => {
      process.stdout.write(`Probat demo target listening on ${url}\n`);
      process.stdout.write(`Revision marker: ${url}/.well-known/probat-revision = ${DEMO_TARGET_REVISION}\n`);
      const shutdown = (): void => {
        server.close(() => process.exit(0));
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
