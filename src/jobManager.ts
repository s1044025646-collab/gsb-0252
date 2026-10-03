import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Store, JobRow } from "./db";
import { SortError } from "./errors";
import { externalSort } from "./sorter";
import { DEFAULTS, SortConfig, SortKey } from "./types";

export interface Paths {
  dataDir: string;
  tmpDir: string;
  outDir: string;
}

export function defaultPaths(projectRoot: string): Paths {
  const dataDir = path.join(projectRoot, "data");
  return {
    dataDir,
    tmpDir: path.join(dataDir, "tmp"),
    outDir: path.join(dataDir, "outputs"),
  };
}

export function validateConfig(raw: unknown): SortConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new SortError("INVALID_CONFIG", "配置必须是对象");
  }
  const c = raw as Record<string, unknown>;
  if (!Array.isArray(c.keys) || c.keys.length === 0) {
    throw new SortError("INVALID_CONFIG", "keys 必须是非空数组");
  }
  const keys: SortKey[] = c.keys.map((k: unknown, i: number) => {
    const kk = k as Record<string, unknown>;
    if (typeof kk !== "object" || kk === null || typeof kk.field !== "string" || kk.field === "") {
      throw new SortError("INVALID_CONFIG", `keys[${i}].field 必须是非空字符串`);
    }
    if (kk.type !== "number" && kk.type !== "string") {
      throw new SortError("INVALID_CONFIG", `keys[${i}].type 必须是 "number" 或 "string"`);
    }
    const direction = kk.direction ?? "asc";
    const nulls = kk.nulls ?? "last";
    if (direction !== "asc" && direction !== "desc") {
      throw new SortError("INVALID_CONFIG", `keys[${i}].direction 必须是 "asc" 或 "desc"`);
    }
    if (nulls !== "first" && nulls !== "last") {
      throw new SortError("INVALID_CONFIG", `keys[${i}].nulls 必须是 "first" 或 "last"`);
    }
    return { field: kk.field, type: kk.type, direction, nulls };
  });
  const intOpt = (v: unknown, dflt: number, min: number, max: number, name: string): number => {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      throw new SortError("INVALID_CONFIG", `${name} 必须是 [${min}, ${max}] 内的整数`);
    }
    return v;
  };
  return {
    keys,
    bufferRecords: intOpt(c.bufferRecords, DEFAULTS.bufferRecords, 1, 10_000_000, "bufferRecords"),
    fanIn: intOpt(c.fanIn, DEFAULTS.fanIn, 2, 1024, "fanIn"),
    maxLineBytes: intOpt(c.maxLineBytes, DEFAULTS.maxLineBytes, 64, 64 * 1024 * 1024, "maxLineBytes"),
  };
}

export class JobManager {
  constructor(private store: Store, private paths: Paths) {
    fs.mkdirSync(paths.tmpDir, { recursive: true });
    fs.mkdirSync(paths.outDir, { recursive: true });
  }

  async registerInput(filePath: string) {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw new SortError("INPUT_NOT_FOUND", `输入文件不存在: ${abs}`);
    }
    const hash = crypto.createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      fs.createReadStream(abs)
        .on("data", (c) => hash.update(c))
        .on("end", resolve)
        .on("error", reject);
    });
    return this.store.addInput(abs, fs.statSync(abs).size, hash.digest("hex"));
  }

  /** 提交并同步执行排序任务(失败不覆盖已有成功结果) */
  async submitJob(inputId: number, config: SortConfig): Promise<JobRow> {
    const input = this.store.getInput(inputId);
    if (!input) throw new SortError("INPUT_NOT_FOUND", `未登记的输入: ${inputId}`);
    const jobId = crypto.randomUUID();
    this.store.createJob(jobId, inputId, config);
    this.store.updateJob(jobId, { status: "running" });

    const tmpOut = path.join(this.paths.tmpDir, `output-${jobId}.ndjson`);
    const finalOut = path.join(this.paths.outDir, `result-${jobId}.ndjson`);
    let tempFiles: string[] = [];
    try {
      const { stats, tempFiles: tf } = await externalSort(
        input.path,
        tmpOut,
        config,
        this.paths.tmpDir,
        jobId
      );
      tempFiles = tf;
      // 全部完成后原子发布:同分区 rename,失败不会留下半成品
      fs.renameSync(tmpOut, finalOut);
      this.store.updateJob(jobId, { status: "done", stats, resultPath: finalOut, error: null });
    } catch (e) {
      await fs.promises.unlink(tmpOut).catch(() => {});
      const err =
        e instanceof SortError
          ? e.toJSON()
          : { code: "INTERNAL_ERROR" as const, message: String(e) };
      this.store.updateJob(jobId, { status: "failed", error: err });
    } finally {
      // 只清理由本次任务创建的临时段(文件名含本任务 jobId)
      for (const f of tempFiles) await fs.promises.unlink(f).catch(() => {});
    }
    return this.store.getJob(jobId)!;
  }

  getJob(id: string): JobRow {
    const j = this.store.getJob(id);
    if (!j) throw new SortError("JOB_NOT_FOUND", `任务不存在: ${id}`);
    return j;
  }

  getResultPath(id: string): string {
    const j = this.getJob(id);
    if (j.status !== "done" || !j.result_path) {
      throw new SortError("JOB_NOT_FINISHED", `任务 ${id} 尚未成功完成(状态: ${j.status})`);
    }
    return j.result_path;
  }

  getReport(id: string) {
    const j = this.getJob(id);
    const input = this.store.getInput(j.input_id);
    return {
      jobId: j.id,
      status: j.status,
      input: input && { id: input.id, path: input.path, size: input.size, sha256: input.sha256 },
      config: JSON.parse(j.config),
      stats: j.stats ? JSON.parse(j.stats) : null,
      error: j.error ? JSON.parse(j.error) : null,
      resultPath: j.result_path,
      note: "bufferRecords 是记录缓冲上限(条数),不是 Node 进程的硬内存上限",
      createdAt: j.created_at,
      updatedAt: j.updated_at,
    };
  }
}
