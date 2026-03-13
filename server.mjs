import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildOverview } from './lib/monitor-data.mjs';
import {
  applyProviderPreset,
  deleteProviderPreset,
  readMarkdownFile,
  toggleLaunchdService,
  upsertProviderPreset,
  updateAgentHeartbeat,
  updateAgentProvider,
  updateCronJob,
  writeMarkdownFile,
} from './lib/monitor-actions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT ?? 3199);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(`${JSON.stringify(payload)}\n`);
}

function sendText(response, statusCode, payload, type = 'text/plain; charset=utf-8') {
  response.writeHead(statusCode, { 'Content-Type': type });
  response.end(payload);
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function serveStatic(response, pathname) {
  const routeMap = {
    '/': '/index.html',
    '/monitor': '/monitor.html',
  };
  const target = routeMap[pathname] ?? pathname;
  const filePath = path.join(PUBLIC_DIR, target.replace(/^\/+/, ''));
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(`${PUBLIC_DIR}${path.sep}`) && resolved !== PUBLIC_DIR) {
    sendText(response, 403, 'Forbidden');
    return;
  }

  try {
    const content = await fs.readFile(resolved);
    const extension = path.extname(resolved).toLowerCase();
    const type =
      extension === '.html'
        ? 'text/html; charset=utf-8'
        : extension === '.css'
          ? 'text/css; charset=utf-8'
          : extension === '.js'
            ? 'application/javascript; charset=utf-8'
            : extension === '.png'
              ? 'image/png'
              : extension === '.jpg' || extension === '.jpeg'
                ? 'image/jpeg'
                : extension === '.svg'
                  ? 'image/svg+xml'
            : 'application/octet-stream';
    sendText(response, 200, content, type);
  } catch {
    sendText(response, 404, 'Not found');
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname;

  try {
    if (request.method === 'GET' && pathname === '/api/overview') {
      sendJson(response, 200, await buildOverview());
      return;
    }

    if (request.method === 'POST' && pathname === '/api/presets') {
      const body = await readBody(request);
      sendJson(response, 200, await upsertProviderPreset(body));
      return;
    }

    const presetMatch = pathname.match(/^\/api\/presets\/([^/]+)$/);
    if (presetMatch && request.method === 'DELETE') {
      const [, presetId] = presetMatch.map(decodeURIComponent);
      sendJson(response, 200, await deleteProviderPreset(presetId));
      return;
    }

    const presetApplyMatch = pathname.match(/^\/api\/presets\/([^/]+)\/apply$/);
    if (presetApplyMatch && request.method === 'POST') {
      const [, presetId] = presetApplyMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await applyProviderPreset(presetId, body));
      return;
    }

    const providerMatch = pathname.match(/^\/api\/agents\/([^/]+)\/providers\/([^/]+)$/);
    if (providerMatch && request.method === 'PATCH') {
      const [, agentId, providerId] = providerMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await updateAgentProvider(agentId, providerId, body));
      return;
    }

    const heartbeatMatch = pathname.match(/^\/api\/agents\/([^/]+)\/heartbeat$/);
    if (heartbeatMatch && request.method === 'PATCH') {
      const [, agentId] = heartbeatMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await updateAgentHeartbeat(agentId, body));
      return;
    }

    const fileMatch = pathname.match(/^\/api\/agents\/([^/]+)\/file$/);
    if (fileMatch && request.method === 'GET') {
      const [, agentId] = fileMatch.map(decodeURIComponent);
      const relativePath = url.searchParams.get('path') ?? '';
      sendJson(response, 200, await readMarkdownFile(agentId, relativePath));
      return;
    }

    if (fileMatch && request.method === 'PUT') {
      const [, agentId] = fileMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await writeMarkdownFile(agentId, body.path, body.content));
      return;
    }

    const cronMatch = pathname.match(/^\/api\/cron\/([^/]+)$/);
    if (cronMatch && request.method === 'PATCH') {
      const [, jobId] = cronMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await updateCronJob(jobId, body));
      return;
    }

    const serviceMatch = pathname.match(/^\/api\/services\/([^/]+)$/);
    if (serviceMatch && request.method === 'PATCH') {
      const [, label] = serviceMatch.map(decodeURIComponent);
      const body = await readBody(request);
      sendJson(response, 200, await toggleLaunchdService(label, Boolean(body.enabled)));
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(response, pathname);
      return;
    }

    sendText(response, 404, 'Not found');
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: String(error?.message ?? error),
    });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`OpenClaw monitor listening on http://127.0.0.1:${PORT}`);
});
