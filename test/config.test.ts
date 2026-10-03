import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSortOptions, LIMITS } from '../src/config.js';
import { ErrorCode } from '../src/errors.js';

describe('参数校验', () => {
  it('默认值', () => {
    const options = parseSortOptions({ keys: [{ field: 'a', type: 'number' }] });
    assert.equal(options.bufferSize, LIMITS.defaultBufferSize);
    assert.equal(options.fanIn, LIMITS.defaultFanIn);
    assert.equal(options.maxLineBytes, LIMITS.defaultMaxLineBytes);
    assert.equal(options.keys[0]!.dir, 'asc');
    assert.equal(options.keys[0]!.nulls, 'first');
  });

  it('字符串形式数字也被接受（CLI）', () => {
    const options = parseSortOptions(
      JSON.stringify({ keys: [{ field: 'a', type: 'string' }], bufferSize: '50', fanIn: '4' })
    );
    assert.equal(options.bufferSize, 50);
    assert.equal(options.fanIn, 4);
  });

  it('拒绝空 keys、未知类型、非法方向、重复字段', () => {
    assert.throws(() => parseSortOptions({ keys: [] }), (e: { code: string }) => e.code === ErrorCode.INVALID_ARGS);
    assert.throws(
      () => parseSortOptions({ keys: [{ field: 'a', type: 'bool' }] }),
      (e: { code: string }) => e.code === ErrorCode.INVALID_ARGS
    );
    assert.throws(
      () => parseSortOptions({ keys: [{ field: 'a', type: 'number', dir: 'up' }] }),
      (e: { code: string }) => e.code === ErrorCode.INVALID_ARGS
    );
    assert.throws(
      () => parseSortOptions({
        keys: [
          { field: 'a', type: 'number' },
          { field: 'a', type: 'string' }
        ]
      }),
      (e: { code: string }) => e.code === ErrorCode.INVALID_ARGS
    );
  });

  it('拒绝越界的 bufferSize/fanIn', () => {
    assert.throws(() => parseSortOptions({ keys: [{ field: 'a', type: 'number' }], bufferSize: 0 }));
    assert.throws(() => parseSortOptions({ keys: [{ field: 'a', type: 'number' }], fanIn: 1 }));
    assert.throws(() => parseSortOptions({ keys: [{ field: 'a', type: 'number' }], fanIn: 999999 }));
  });
});
