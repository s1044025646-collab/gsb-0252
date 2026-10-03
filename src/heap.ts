/**
 * 通用二叉最小堆。比较器返回负数表示 a 优先。
 */
export class MinHeap<T> {
  private items: T[] = [];

  constructor(private readonly less: (a: T, b: T) => number) {}

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!) >= 0) break;
      [items[i], items[parent]] = [items[parent]!, items[i]!];
      i = parent;
    }
  }

  peek(): T | undefined {
    return this.items[0];
  }

  pop(): T | undefined {
    const items = this.items;
    if (items.length <= 1) return items.pop();
    const top = items[0];
    items[0] = items.pop()!;
    let i = 0;
    const n = items.length;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let smallest = i;
      if (left < n && this.less(items[left]!, items[smallest]!) < 0) smallest = left;
      if (right < n && this.less(items[right]!, items[smallest]!) < 0) smallest = right;
      if (smallest === i) break;
      [items[i], items[smallest]] = [items[smallest]!, items[i]!];
      i = smallest;
    }
    return top;
  }
}
