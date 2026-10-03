import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runExternalSort } from '../src/sorter.js';
import { parseSortOptions } from '../src/config.js';
import { referenceSort } from '../src/demo.js';
import type { SortOptions } from '../src/types.js';

export async function makeTempProject(prefix = 'ndjson-sort-test-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export async function sortFile(
  projectDir: string,
  inputText: string,
  optionsInput: Record<string, unknown>,
  name = 'out.ndjson'
) {
  const inputPath = join(projectDir, 'input.ndjson');
  const outputPath = join(projectDir, 'results', name);
  const tempDir = join(projectDir, 'tmpwork');
  await mkdir(projectDir, { recursive: true });
  await writeFile(inputPath, inputText, 'utf8');
  const options = parseSortOptions(optionsInput);
  const stats = await runExternalSort(inputPath, outputPath, tempDir, options);
  const outputText = await readFile(outputPath, 'utf8');
  return { outputText, outputPath, stats, inputPath, options };
}

export function linesOf(text: string): string[] {
  // 输出总是以 \n 结尾（空文件除外）。
  if (text.length === 0) return [];
  return text.split('\n').filter((line) => line.length > 0);
}

export function expectReferenceEqual(
  lines: string[],
  rawInput: string,
  optionsInput: Record<string, unknown>
): void {
  const inputLines = rawInput.split('\n').filter((line) => line.length > 0);
  const expected = referenceSort(inputLines, optionsInput);
  if (JSON.stringify(lines) !== JSON.stringify(expected)) {
    throw new Error(
      `外部排序结果与独立内存基准不一致\n实际: ${JSON.stringify(lines)}\n期望: ${JSON.stringify(expected)}`
    );
  }
}

export function tinyOptions(overrides: Partial<SortOptions> = {}): Record<string, unknown> {
  return {
    keys: [{ field: 'v', type: 'number', dir: 'asc', nulls: 'last' }],
    bufferSize: 2,
    fanIn: 2,
    maxLineBytes: 65536,
    ...overrides
  };
}

export async function cleanup(dir: string): Promise<void> {
  await rm(resolve(dir), { recursive: true, force: true });
}
