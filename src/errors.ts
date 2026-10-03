/**
 * 统一错误码与错误类型。
 */
export const ErrorCode = {
  INVALID_ARGS: 'E_INVALID_ARGS',
  FILE_NOT_FOUND: 'E_FILE_NOT_FOUND',
  NOT_A_FILE: 'E_NOT_A_FILE',
  BAD_JSON: 'E_BAD_JSON',
  NOT_OBJECT: 'E_NOT_OBJECT',
  TYPE_MISMATCH: 'E_TYPE_MISMATCH',
  LINE_TOO_LONG: 'E_LINE_TOO_LONG',
  NOT_FOUND: 'E_NOT_FOUND',
  JOB_NOT_DONE: 'E_JOB_NOT_DONE',
  RESULT_MISSING: 'E_RESULT_MISSING',
  CONFLICT: 'E_CONFLICT',
  IO_ERROR: 'E_IO_ERROR',
  INTERNAL: 'E_INTERNAL'
} as const;

export class SortError extends Error {
  code: string;
  line?: number;

  constructor(code: string, message: string, line?: number) {
    super(message);
    this.name = 'SortError';
    this.code = code;
    this.line = line;
  }
}
