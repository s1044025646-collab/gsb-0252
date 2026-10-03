import { SortError } from "./errors";
import { KeyValue } from "./compare";
import { SortKey } from "./types";

/** 解析一行为 JSON 对象并提取排序键;坏行抛错并带源行号,绝不跳过 */
export function parseRecord(
  line: string,
  lineNo: number,
  keys: SortKey[]
): KeyValue[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new SortError("BAD_JSON", `第 ${lineNo} 行不是合法 JSON`, lineNo);
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    throw new SortError("NOT_OBJECT", `第 ${lineNo} 行不是 JSON 对象`, lineNo);
  }
  const rec = obj as Record<string, unknown>;
  return keys.map((k) => extractKey(rec, k, lineNo));
}

function extractKey(rec: Record<string, unknown>, key: SortKey, lineNo: number): KeyValue {
  const v = rec[key.field];
  if (v === undefined || v === null) return null; // 缺字段与 null 统一为空值
  if (key.type === "number") {
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new SortError(
        "TYPE_MISMATCH",
        `第 ${lineNo} 行字段 "${key.field}" 不是有限 JSON 数值`,
        lineNo
      );
    }
    return v;
  }
  if (typeof v !== "string") {
    throw new SortError(
      "TYPE_MISMATCH",
      `第 ${lineNo} 行字段 "${key.field}" 不是字符串`,
      lineNo
    );
  }
  return v;
}
