import { createHash, randomUUID } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  statSync
} from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { ErrorCode, SortError } from './errors.js';
import { parseSortOptions } from './config.js';
import { Store, type InputFileRow, type JobRow } from './db.js';
import { runExternalSort } from './sorter.js';
import type { JobStatus, SortOptions, SortStats } from './types.js';

export interface ProjectPaths {
  root: string;
  inputs: string;
  results: string;
  tmp: string;
  db: string;
}

export interface JobView {
  id: string;
  fileId: string;
  status: JobStatus;
  options: SortOptions;
  resultPath: string | null;
  error: { code: string; message: string; line: number | null } | null;
  stats: SortStats | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReportPayload {
  job: JobView;
  input: InputFileRow;
  result?: {
    path: string;
    sizeBytes: number;
  };
}

/**
 * 排序服务。所有文件都保存在“本项目数据目录”内，
 * 停止服务 / 清理临时段不会触及目录之外的任何文件。
 */
export class SortService {
  private store: Store;
  private running = new Set<string>();

  constructor(public readonly paths: ProjectPaths) {
    this.store = new Store(paths.db);
  }

  static async create(dataDir: string): Promise<SortService> {
    const root = resolve(dataDir);
    const paths: ProjectPaths = {
      root,
      inputs: join(root, 'inputs'),
      results: join(root, 'results'),
      tmp: join(root, 'tmp'),
      db: join(root, 'app.sqlite')
    };
    for (const dir of [paths.inputs, paths.results, paths.tmp]) {
      await mkdir(dir, { recursive: true });
    }
    const service = new SortService(paths);
    await service.cleanupStaleTemp();
    service.store.markStaleJobsFailed(new Date().toISOString());
    return service;
  }

  /**
   * 启动时清理本项目 tmp 目录里上次异常退出遗留的临时段。
   * 只删除 dataDir/tmp 内的任务目录，不动 inputs/results/数据库。
   */
  private async cleanupStaleTemp(): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.paths.tmp);
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = join(this.paths.tmp, entry);
      try {
        const info = await stat(target);
        if (info.isDirectory()) await rm(target, { recursive: true, force: true });
      } catch {
        // 单个目录清理失败不阻断启动。
      }
    }
  }

  close(): void {
    this.store.close();
  }

  /**
   * 登记项目内输入文件：流式复制到数据目录，计算大小与 SHA256。
   * 不在此处做 NDJSON 内容校验（坏行在排序时按源行号报错）。
   */
  async registerFile(originalPathInput: string): Promise<InputFileRow> {
    const originalPath = resolve(
      isAbsolute(originalPathInput) ? originalPathInput : join(process.cwd(), originalPathInput)
    );
    if (!existsSync(originalPath)) {
      throw new SortError(ErrorCode.FILE_NOT_FOUND, `输入文件不存在: ${originalPath}`);
    }
    const fileStat = statSync(originalPath);
    if (!fileStat.isFile()) {
      throw new SortError(ErrorCode.NOT_A_FILE, `输入路径不是普通文件: ${originalPath}`);
    }

    const id = randomUUID();
    const storedPath = join(this.paths.inputs, `${id}.ndjson`);
    const hash = createHash('sha256');

    await new Promise<void>((resolvePromise, rejectPromise) => {
      const source = createReadStream(originalPath);
      const target = createWriteStream(storedPath);
      source.on('data', (chunk) => hash.update(chunk));
      source.on('error', rejectPromise);
      target.on('error', rejectPromise);
      target.on('finish', resolvePromise);
      source.pipe(target);
    });

    const row: InputFileRow = {
      id,
      originalPath,
      storedPath,
      sizeBytes: fileStat.size,
      sha256: hash.digest('hex'),
      createdAt: new Date().toISOString()
    };
    this.store.insertFile(row);
    return row;
  }

  listFiles(): InputFileRow[] {
    return this.store.listFiles();
  }

  getFile(fileId: string): InputFileRow {
    const file = this.store.getFile(fileId);
    if (!file) throw new SortError(ErrorCode.NOT_FOUND, `输入文件未登记: ${fileId}`);
    return file;
  }

  /** 提交排序任务：校验配置、写入 queued 状态，后台异步执行。 */
  submitJob(fileId: string, rawOptions: unknown): JobView {
    const file = this.getFile(fileId);
    void file;
    const options = parseSortOptions(rawOptions);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.store.createJob(id, fileId, options, now);
    // 后台执行，不阻塞 API 返回；状态通过 status 查询。
    void this.executeJob(id);
    return this.getJob(id);
  }

  private async executeJob(jobId: string): Promise<void> {
    const job = this.store.getJob(jobId);
    if (!job) return;
    this.running.add(jobId);
    this.store.updateStatus(jobId, 'running', new Date().toISOString());
    const file = this.store.getFile(job.fileId);
    const options = JSON.parse(job.optionsJson) as SortOptions;

    try {
      if (!file) throw new SortError(ErrorCode.NOT_FOUND, '登记的输入文件已丢失');
      const resultPath = join(this.paths.results, `${jobId}.ndjson`);
      const tempDir = join(this.paths.tmp, jobId);
      const stats = await runExternalSort(file.storedPath, resultPath, tempDir, options, {
        onStatus: () => undefined
      });
      this.store.completeJob(jobId, resultPath, stats, new Date().toISOString());
    } catch (err) {
      const error =
        err instanceof SortError ? err : new SortError(ErrorCode.INTERNAL, String(err));
      this.store.failJob(
        jobId,
        error.code,
        error.message,
        error.line ?? null,
        new Date().toISOString()
      );
    } finally {
      this.running.delete(jobId);
    }
  }

  getJob(jobId: string): JobView {
    const row = this.store.getJob(jobId);
    if (!row) throw new SortError(ErrorCode.NOT_FOUND, `任务不存在: ${jobId}`);
    return this.toView(row);
  }

  listJobs(status?: JobStatus): JobView[] {
    return this.store.listJobs(status).map((row) => this.toView(row));
  }

  private toView(row: JobRow): JobView {
    return {
      id: row.id,
      fileId: row.fileId,
      status: row.status,
      options: JSON.parse(row.optionsJson) as SortOptions,
      resultPath: row.resultPath,
      error: row.errorCode
        ? { code: row.errorCode, message: row.errorMessage ?? '', line: row.errorLine }
        : null,
      stats: row.statsJson ? (JSON.parse(row.statsJson) as SortStats) : null,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  /** 取结果：仅在任务完成且结果文件存在时返回其绝对路径（由上层流式发送）。 */
  getResultPath(jobId: string): string {
    const view = this.getJob(jobId);
    if (view.status !== 'done' || !view.resultPath) {
      throw new SortError(ErrorCode.JOB_NOT_DONE, `任务 ${jobId} 尚未成功完成，没有结果可取`);
    }
    if (!existsSync(view.resultPath)) {
      throw new SortError(ErrorCode.RESULT_MISSING, `结果文件缺失: ${view.resultPath}`);
    }
    return view.resultPath;
  }

  /** 导出报告（结构化 JSON 对象，可写文件或直接打印）。 */
  buildReport(jobId: string): ReportPayload {
    const view = this.getJob(jobId);
    const input = this.getFile(view.fileId);
    const report: ReportPayload = { job: view, input };
    if (view.status === 'done' && view.resultPath && existsSync(view.resultPath)) {
      report.result = {
        path: view.resultPath,
        sizeBytes: statSync(view.resultPath).size
      };
    }
    return report;
  }

  /** 打开结果文件的只读流（供 HTTP/CLI 使用）。 */
  openResult(jobId: string) {
    const path = this.getResultPath(jobId);
    return { path, stream: createReadStream(path) };
  }

  /** 等待任务结束（CLI/测试场景）。 */
  async waitForJob(jobId: string, pollMs = 20): Promise<JobView> {
    for (;;) {
      const view = this.getJob(jobId);
      if (view.status === 'done' || view.status === 'failed') return view;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  /** 仅用于受控环境的同步执行（CLI/演示/测试）：提交并等待结束。 */
  async runJobAndWait(fileId: string, rawOptions: unknown): Promise<JobView> {
    const view = this.submitJob(fileId, rawOptions);
    return this.waitForJob(view.id);
  }
}
