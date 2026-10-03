import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { JobStatus, SortConfig, SortStats } from "./types";
import { ErrorCode } from "./errors";

export interface InputRow {
  id: number;
  path: string;
  size: number;
  sha256: string;
  created_at: string;
}

export interface JobRow {
  id: string;
  input_id: number;
  config: string;
  status: JobStatus;
  stats: string | null;
  result_path: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export class Store {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS inputs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        size INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        input_id INTEGER NOT NULL REFERENCES inputs(id),
        config TEXT NOT NULL,
        status TEXT NOT NULL,
        stats TEXT,
        result_path TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  close() {
    this.db.close();
  }
  addInput(p: string, size: number, sha256: string): InputRow {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("INSERT INTO inputs (path, size, sha256, created_at) VALUES (?,?,?,?)")
      .run(p, size, sha256, now);
    return this.getInput(Number(r.lastInsertRowid))!;
  }
  getInput(id: number): InputRow | null {
    return (this.db.prepare("SELECT * FROM inputs WHERE id=?").get(id) as unknown as InputRow) ?? null;
  }
  listInputs(): InputRow[] {
    return this.db.prepare("SELECT * FROM inputs ORDER BY id").all() as unknown as InputRow[];
  }
  createJob(id: string, inputId: number, config: SortConfig): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        "INSERT INTO jobs (id, input_id, config, status, created_at, updated_at) VALUES (?,?,?,?,?,?)"
      )
      .run(id, inputId, JSON.stringify(config), "pending", now, now);
  }
  updateJob(
    id: string,
    patch: {
      status?: JobStatus;
      stats?: SortStats;
      resultPath?: string | null;
      error?: { code: ErrorCode; message: string; line?: number | null } | null;
    }
  ): void {
    const cur = this.getJob(id);
    if (!cur) return;
    this.db
      .prepare(
        "UPDATE jobs SET status=?, stats=?, result_path=?, error=?, updated_at=? WHERE id=?"
      )
      .run(
        patch.status ?? cur.status,
        patch.stats !== undefined ? JSON.stringify(patch.stats) : cur.stats,
        patch.resultPath !== undefined ? patch.resultPath : cur.result_path,
        patch.error !== undefined ? JSON.stringify(patch.error) : cur.error,
        new Date().toISOString(),
        id
      );
  }
  getJob(id: string): JobRow | null {
    return (this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id) as unknown as JobRow) ?? null;
  }
  listJobs(): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs ORDER BY created_at").all() as unknown as JobRow[];
  }
}
