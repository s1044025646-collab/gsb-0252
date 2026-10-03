export type ErrorCode =
  | "BAD_JSON"
  | "NOT_OBJECT"
  | "TYPE_MISMATCH"
  | "LINE_TOO_LONG"
  | "INVALID_CONFIG"
  | "INPUT_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "JOB_NOT_FINISHED"
  | "IO_ERROR"
  | "INTERNAL_ERROR";

export class SortError extends Error {
  readonly code: ErrorCode;
  readonly line?: number;
  constructor(code: ErrorCode, message: string, line?: number) {
    super(message);
    this.code = code;
    this.line = line;
  }
  toJSON() {
    return { code: this.code, message: this.message, line: this.line ?? null };
  }
}
