import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { SortService } from './service.js';
import { SortError } from './errors.js';
import type { JobStatus } from './types.js';

interface RouteContext {
  service: SortService;
  params: Record<string, string>;
  body: unknown;
}

type Handler = (ctx: RouteContext, req: IncomingMessage, res: ServerResponse) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const paramNames: string[] = [];
  const patternText = path
    .replace(/<([^>]+)>/g, (_match, name: string) => {
      paramNames.push(name);
      return '([^/]+)';
    })
    .replace(/\//g, '\\/');
  return { method, pattern: new RegExp(`^${patternText}$`), paramNames, handler };
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text)
  });
  res.end(text);
}

function readJsonBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<unknown> {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejectPromise(new SortError('E_INVALID_ARGS', `请求体超过 ${maxBytes} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise({});
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        rejectPromise(new SortError('E_INVALID_ARGS', '请求体不是合法 JSON'));
      }
    });
    req.on('error', rejectPromise);
  });
}

const routes: Route[] = [
  route('GET', '/health', (_ctx, _req, res) => {
    sendJson(res, 200, { ok: true });
  }),
  route('POST', '/files', (ctx, _req, res) => {
    const body = (ctx.body ?? {}) as { path?: unknown };
    if (typeof body.path !== 'string' || body.path.length === 0) {
      throw new SortError('E_INVALID_ARGS', 'body.path 必须是非空字符串（待登记文件的本地路径）');
    }
    return Promise.resolve(ctx.service.registerFile(body.path)).then((file) =>
      sendJson(res, 201, file)
    );
  }),
  route('GET', '/files', (ctx, _req, res) => {
    sendJson(res, 200, ctx.service.listFiles());
  }),
  route('GET', '/files/<id>', (ctx, _req, res) => {
    sendJson(res, 200, ctx.service.getFile(ctx.params.id!));
  }),
  route('POST', '/files/<id>/sort', (ctx, _req, res) => {
    const view = ctx.service.submitJob(ctx.params.id!, ctx.body);
    sendJson(res, 202, view);
  }),
  route('GET', '/jobs', (ctx, req, res) => {
    const status = new URL(req.url!, 'http://localhost').searchParams.get('status');
    if (status && !['queued', 'running', 'done', 'failed'].includes(status)) {
      throw new SortError('E_INVALID_ARGS', 'status 必须是 queued/running/done/failed 之一');
    }
    sendJson(res, 200, ctx.service.listJobs(status as JobStatus | null ?? undefined));
  }),
  route('GET', '/jobs/<id>', (ctx, _req, res) => {
    sendJson(res, 200, ctx.service.getJob(ctx.params.id!));
  }),
  route('GET', '/jobs/<id>/result', (ctx, _req, res) => {
    const path = ctx.service.getResultPath(ctx.params.id!);
    const stat = statSync(path);
    res.writeHead(200, {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'content-length': stat.size
    });
    createReadStream(path).pipe(res);
  }),
  route('GET', '/jobs/<id>/report', (ctx, _req, res) => {
    sendJson(res, 200, ctx.service.buildReport(ctx.params.id!));
  })
];

export interface RunningServer {
  port: number;
  close: () => Promise<void>;
}

export async function startServer(service: SortService, preferredPort?: number): Promise<RunningServer> {
  const server = createServer((req, res) => {
    void handleRequest(req, res, service);
  });

  const port = await listenOnFreePort(server, preferredPort);
  return {
    port,
    close: () =>
      new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((err) => (err ? rejectPromise(err) : resolvePromise()));
      })
  };
}

/** 优先使用指定端口；未指定或被占用时让操作系统分配空闲端口。 */
function listenOnFreePort(server: Server, preferredPort?: number): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (preferredPort !== undefined && err.code === 'EADDRINUSE') {
        server.removeListener('error', onError);
        server.listen(0, '127.0.0.1');
        return;
      }
      rejectPromise(err);
    };
    server.on('error', onError);
    server.listen(preferredPort ?? 0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolvePromise(address.port);
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, service: SortService): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let body: unknown = {};
    if (req.method === 'POST') {
      body = await readJsonBody(req);
    }
    for (const candidate of routes) {
      if (candidate.method !== req.method) continue;
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      const params: Record<string, string> = {};
      candidate.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]!);
      });
      await candidate.handler({ service, params, body }, req, res);
      return;
    }
    sendJson(res, 404, { error: { code: 'E_NOT_FOUND', message: `无此路由: ${req.method} ${url.pathname}` } });
  } catch (err) {
    const error =
      err instanceof SortError
        ? err
        : new SortError('E_INTERNAL', err instanceof Error ? err.message : String(err));
    const statusCode = error.code === 'E_NOT_FOUND' || error.code === 'E_FILE_NOT_FOUND' ? 404
      : error.code === 'E_JOB_NOT_DONE' ? 409
      : 400;
    if (!res.headersSent) {
      sendJson(res, statusCode, { error: { code: error.code, message: error.message, line: error.line ?? null } });
    } else {
      res.destroy();
    }
  }
}
