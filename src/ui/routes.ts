import type { FastifyInstance, FastifyReply } from 'fastify';
import { UI_CLIENT } from './client.js';
import { UI_ICON, renderUiHtml } from './html.js';
import { UI_CSS } from './styles.js';

export const UI_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'self'",
  "img-src 'self' data:",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join('; ');

export function registerUiRoutes(
  app: FastifyInstance,
  defaultTargetUrl = 'http://127.0.0.1:4321',
): void {
  app.get('/ui', async (_request, reply) => reply.redirect('/ui/'));
  app.get('/ui/', async (_request, reply) =>
    sendAsset(reply, 'text/html; charset=utf-8', renderUiHtml(defaultTargetUrl)),
  );
  app.get('/ui/app.css', async (_request, reply) =>
    sendAsset(reply, 'text/css; charset=utf-8', UI_CSS),
  );
  app.get('/ui/app.js', async (_request, reply) =>
    sendAsset(reply, 'text/javascript; charset=utf-8', UI_CLIENT),
  );
  app.get('/ui/icon.svg', async (_request, reply) =>
    sendAsset(reply, 'image/svg+xml; charset=utf-8', UI_ICON),
  );
}

function sendAsset(reply: FastifyReply, contentType: string, body: string): FastifyReply {
  return reply
    .header('cache-control', 'no-store')
    .header('content-type', contentType)
    .send(body);
}
