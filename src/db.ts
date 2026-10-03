import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { JobStatus, SortOptions, SortStats } from './types.js';

export interface InputFileRow {
  id: string;
  originalPath: string;
  storedPath: string;
  sizeBytes: number;
  sha256: string;
  createdAt: string;
}

export interface JobRow {
  id: string;
  fileId: string;
  status: JobStatus;
  optionsJson: string;
  resultPath: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorLine: number | null;
  statsJson: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * SQLite 持久化层。仅用于保存配置、状态、输入摘要与结果路径，
 * 不参与任何排序（不使用 ORDER BY 完成主要排序）。
 */
export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS input_files (
        id TEXT PRIMARY KEY,
        original_path TEXT NOT NULL,
        stored_path TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        file_id TEXT NOT NULL REFERENCES input_files(id),
        status TEXT NOT NULL,
        options_json TEXT NOT NULL,
        result_path TEXT,
        error_code TEXT,
        error_message TEXT,
        error_line INTEGER,
        stats_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
      CREATE INDEX IF NOT EXISTS idx_jobs_file ON jobs(file_id);
    `);
  }

  insertFile(row: InputFileRow): void {
    this.db
      .prepare(
        `INSERT INTO input_files (id, original_path, stored_path, size_bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.id, row.originalPath, row.storedPath, row.sizeBytes, row.sha256, row.createdAt);
  }

  getFile(id: string): InputFileRow | null {
    const row = this.db.prepare('SELECT * FROM input_files WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapFile(row) : null;
  }

  listFiles(): InputFileRow[] {
    const rows = this.db
      .prepare('SELECT * FROM input_files ORDER BY created_at ASC, id ASC')
      .all() as Record<string, unknown>[];
    return rows.map((row) => this.mapFile(row));
  }

  private mapFile(row: Record<string, unknown>): InputFileRow {
    return {
      id: row.id as string,
      originalPath: row.original_path as string,
      storedPath: row.stored_path as string,
      sizeBytes: row.size_bytes as number,
      sha256: row.sha256 as string,
      createdAt: row.created_at as string
    };
  }

  createJob(id: string, fileId: string, options: SortOptions, now: string): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, file_id, status, options_json, created_at, updated_at)
         VALUES (?, ?, 'queued', ?, ?, ?)`
      )
      .run(id, fileId, JSON.stringify(options), now, now);
  }

  updateStatus(id: string, status: JobStatus, now: string): void {
    this.db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
  }

  /** 启动时把上次进程强杀遗留的未完成任务标记为失败。 */
  markStaleJobsFailed(now: string): number {
    const result = this.db
      .prepare(
        `UPDATE jobs
         SET status = 'failed',
             error_code = 'E_INTERNAL',
             error_message = '服务重启：该任务在未完成时被中断，未发布结果',
             updated_at = ?
         WHERE status IN ('queued', 'running')`
      )
      .run(now);
    return Number(result.changes ?? 0);
  }

  completeJob(id: string, resultPath: string, stats: SortStats, now: string): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'done', result_path = ?, stats_json = ?, updated_at = ? WHERE id = ?`
      )
      .run(resultPath, JSON.stringify(stats), now, id);
  }

  failJob(
    id: string,
    code: string,
    message: string,
    line: number | null,
    now: string
  ): void {
    this.db
      .prepare(
        `UPDATE jobs SET status = 'failed', error_code = ?, error_message = ?, error_line = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(code, message, line, now, id);
  }

  getJob(id: string): JobRow | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapJob(row) : null;
  }

  listJobs(status?: JobStatus): JobRow[] {
    const rows = status
      ? (this.db
          .prepare('SELECT * FROM jobs WHERE status = ? ORDER BY created_at ASC, id ASC')
          .all(status) as Record<string, unknown>[])
      : (this.db.prepare('SELECT * FROM jobs ORDER BY created_at ASC, id ASC').all() as Record<
          string,
          unknown
        >[]);
    return rows.map((row) => this.mapJob(row));
  }

  private mapJob(row: Record<string, unknown>): JobRow {
    return {
      id: row.id as string,
      fileId: row.file_id as string,
      status: row.status as JobStatus,
      optionsJson: row.options_json as string,
      resultPath: (row.result_path as string | null) ?? null,
      errorCode: (row.error_code as string | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      errorLine: (row.error_line as number | null) ?? null,
      statsJson: (row.stats_json as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string
    };
  }

  close(): void {
    this.db.close();
  }
}
