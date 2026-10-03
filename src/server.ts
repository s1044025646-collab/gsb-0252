import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Store } from "./db";
import { JobManager, defaultPaths, validateConfig } from "./jobManager";
import { SortError } from "./errors";

function send(res: http.ServerResponse, status: number, body: unknown) {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function sendError(res: http.ServerResponse, e: unknown) {
  if (e instanceof SortError) {
    const status =
      e.code === "JOB_NOT_FOUND" || e.code === "INPUT_NOT_FOUND"
        ? 404
        : e.code === "JOB_NOT_FINISHED"
          ? 409
          : 400;
    send(res, status, { error: e.toJSON() });
  } else {
    send(res, 500, { error: { code: "INTERNAL_ERROR", message: String(e) } });
  }
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SortError("INVALID_CONFIG", "请求体必须是合法 JSON");
  }
}

export function createServer(projectRoot: string) {
  const paths = defaultPaths(projectRoot);
  const store = new Store(path.join(paths.dataDir, "sort.db"));
  const jobs = new JobManager(store, paths);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const m = req.method ?? "GET";
      const parts = url.pathname.split("/").filter(Boolean);

      if (m === "POST" && url.pathname === "/inputs") {
        const body = (await readBody(req)) as { path?: string };
        if (typeof body.path !== "string") {
          throw new SortError("INVALID_CONFIG", "需要 { path: string }");
        }
        send(res, 201, await jobs.registerInput(body.path));
        return;
      }
      if (m === "GET" && url.pathname === "/inputs") {
        send(res, 200, store.listInputs());
        return;
      }
      if (m === "POST" && url.pathname === "/jobs") {
        const body = (await readBody(req)) as { inputId?: number } & Record<string, unknown>;
        if (typeof body.inputId !== "number") {
          throw new SortError("INVALID_CONFIG", "需要 { inputId: number, keys: [...] }");
        }
        const config = validateConfig(body);
        send(res, 201, jobs.getReport((await jobs.submitJob(body.inputId, config)).id));
        return;
      }
      if (m === "GET" && url.pathname === "/jobs") {
        send(res, 200, store.listJobs().map((j) => jobs.getReport(j.id)));
        return;
      }
      if (m === "GET" && parts[0] === "jobs" && parts.length === 2) {
        send(res, 200, jobs.getReport(parts[1]));
        return;
      }
      if (m === "GET" && parts[0] === "jobs" && parts[2] === "report") {
        send(res, 200, jobs.getReport(parts[1]));
        return;
      }
      if (m === "GET" && parts[0] === "jobs" && parts[2] === "result") {
        const p = jobs.getResultPath(parts[1]);
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8" });
        fs.createReadStream(p).pipe(res);
        return;
      }
      send(res, 404, { error: { code: "NOT_FOUND", message: "未知路由" } });
    } catch (e) {
      sendError(res, e);
    }
  });
  return { server, store };
}

if (require.main === module) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const port = portArg ? Number(portArg.split("=")[1]) : envPort ?? 0; // 默认选空闲端口
  const { server } = createServer(process.cwd());
  server.listen(port, () => {
    const addr = server.address();
    console.log(`NDJSON 排序服务已启动: http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : port}`);
  });
}
