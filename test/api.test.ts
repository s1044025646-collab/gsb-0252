import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { SortService } from '../src/service.js';
import { startServer, type RunningServer } from '../src/server.js';
import { ErrorCode } from '../src/errors.js';

let dataDir: string;
let sourceFile: string;
let service: SortService;
let server: RunningServer;
let baseUrl: string;

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; json: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'content-type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined
  });
  const json = (await response.json()) as T;
  return { status: response.status, json };
}

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'ndjson-api-'));
  sourceFile = join(dataDir, 'source.ndjson');
  await writeFile(sourceFile, '{"v":3,"s":"丙"}\n{"v":1,"s":"甲"}\n{"v":2,"s":"乙"}\n', 'utf8');
  service = await SortService.create(join(dataDir, 'project'));
  server = await startServer(service);
  baseUrl = `http://127.0.0.1:${server.port}`;
});

after(async () => {
  await server.close();
  service.close();
  await rm(dataDir, { recursive: true, force: true });
});

describe('HTTP API 全流程', () => {
  it('健康检查', async () => {
    const { status, json } = await request<{ ok: boolean }>('/health');
    assert.equal(status, 200);
    assert.equal(json.ok, true);
  });

  it('登记 -> 排序 -> 查询 -> 取结果 -> 报告', async () => {
    const registered = await request<{ id: string }>('/files', { method: 'POST', body: { path: sourceFile } });
    assert.equal(registered.status, 201);
    const fileId = registered.json.id;

    const sorted = await request<{ id: string; status: string }>(`/files/${fileId}/sort`, {
      method: 'POST',
      body: {
        keys: [{ field: 'v', type: 'number', dir: 'asc', nulls: 'last' }],
        bufferSize: 2,
        fanIn: 2
      }
    });
    assert.equal(sorted.status, 202);
    const jobId = sorted.json.id;

    // 轮询直到结束
    let final: { status: number; json: { status: string; stats: { inputRows: number } | null } };
    for (let i = 0; i < 100; i++) {
      final = await request(`/jobs/${jobId}`);
      if (final.json.status === 'done' || final.json.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(final!.json.status, 'done');
    assert.equal(final!.json.stats!.inputRows, 3);

    const result = await fetch(`${baseUrl}/jobs/${jobId}/result`);
    const text = await result.text();
    const values = text.trim().split('\n').map((line) => (JSON.parse(line) as { v: number }).v);
    assert.deepEqual(values, [1, 2, 3]);

    const report = await request<{ job: { id: string }; input: { sha256: string } }>(`/jobs/${jobId}/report`);
    assert.equal(report.status, 200);
    assert.equal(report.json.job.id, jobId);
    assert.match(report.json.input.sha256, /^[0-9a-f]{64}$/);
  });

  it('不存在资源返回 404 与错误码', async () => {
    const { status, json } = await request<{ error: { code: string } }>('/jobs/nope');
    assert.equal(status, 404);
    assert.equal(json.error.code, ErrorCode.NOT_FOUND);
  });

  it('坏行任务失败并返回源行号', async () => {
    const badPath = join(dataDir, 'bad.ndjson');
    await writeFile(badPath, '{"v":1}\nWRONG\n', 'utf8');
    const registered = await request<{ id: string }>('/files', { method: 'POST', body: { path: badPath } });
    const job = await request<{ id: string }>(`/files/${registered.json.id}/sort`, {
      method: 'POST',
      body: { keys: [{ field: 'v', type: 'number' }], bufferSize: 2, fanIn: 2 }
    });
    const view = await service.waitForJob(job.json.id);
    assert.equal(view.status, 'failed');
    assert.equal(view.error!.code, ErrorCode.BAD_JSON);
    assert.equal(view.error!.line, 2);
  });
});

describe('SQLite 持久化', () => {
  it('重新打开数据目录后仍可查询已完成任务', async () => {
    const reopened = await SortService.create(service.paths.root);
    const jobs = reopened.listJobs('done');
    assert.ok(jobs.length >= 1);
    const done = jobs[0]!;
    assert.equal(done.status, 'done');
    assert.ok(done.resultPath);
    assert.equal(reopened.buildReport(done.id).input.sha256.length, 64);
    reopened.close();
  });
});
