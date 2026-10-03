import fs from "node:fs";
import readline from "node:readline";
import { SortError } from "./errors";

/**
 * 逐行读取 NDJSON 文件(流式,不整文件入内存)。
 * 支持末尾无换行;限制单行字节数,超限抛 LINE_TOO_LONG 并带源行号。
 */
export async function* readLines(
  filePath: string,
  maxLineBytes: number
): AsyncGenerator<{ line: string; lineNo: number }> {
  const stream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNo = 0;
  try {
    for await (const raw of rl) {
      lineNo++;
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (Buffer.byteLength(line, "utf8") > maxLineBytes) {
        throw new SortError(
          "LINE_TOO_LONG",
          `第 ${lineNo} 行超过单行大小上限 ${maxLineBytes} 字节`,
          lineNo
        );
      }
      yield { line, lineNo };
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}
