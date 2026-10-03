/** 确定种子的演示数据生成器(mulberry32 PRNG) */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SURNAMES = ["张", "王", "李", "赵", "陈", "刘", "杨", "黄"];
const GIVEN = ["伟", "芳", "娜", "敏", "静", "磊", "洋", "雪", "晨", "宇"];
const TAGS = ["alpha", "beta", "gamma", "delta"];

export interface GenOptions {
  lines: number;
  seed: number;
  /** 制造大量重复键以演示稳定性 */
  hotKeyModulo: number;
  /** 每 badEvery 行插入一行坏 JSON(0 表示不插入) */
  badEvery?: number;
}

export function* generateNdjson(opts: GenOptions): Generator<string> {
  const rnd = mulberry32(opts.seed);
  for (let i = 1; i <= opts.lines; i++) {
    if (opts.badEvery && i % opts.badEvery === 0) {
      yield `{"id":${i},"broken":`; // 坏 JSON
      continue;
    }
    const group = Math.floor(rnd() * opts.hotKeyModulo);
    const name = SURNAMES[Math.floor(rnd() * SURNAMES.length)] + GIVEN[Math.floor(rnd() * GIVEN.length)];
    const score = rnd() < 0.15 ? null : Math.floor(rnd() * 1000) / 10;
    const tag = rnd() < 0.1 ? undefined : TAGS[Math.floor(rnd() * TAGS.length)];
    const rec: Record<string, unknown> = { id: i, group, name, score };
    if (tag !== undefined) rec.tag = tag;
    yield JSON.stringify(rec);
  }
}
