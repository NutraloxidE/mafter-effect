// §11.4 — カット境界の `<video>` 要素再利用プール（key 単位の空き要素コンテナ・DOM 非依存）。
// 同一動画を分割して連結したタイムラインで、境界レイヤー（object id）が入れ替わる際に
// 離脱要素を破棄→新規生成（=再ロード/再デコード）する代わりに、同一 asset の decode 済み要素を
// 再利用してデコードギャップ（映像の空フレーム・内蔵音声の再初期化）を防ぐ。
//
// このモジュールは純粋な keyed stack（Map<key, T[]>）だけを持ち、DOM には触れない。
// 実 <video> の mute/pause/detach/teardown は呼び出し側（DomRenderer）が行う。
// videoWarmupCache.ts（primed 状態）と同じ「純ロジック／DOM」分離。

export class KeyedElementPool<T> {
  private free = new Map<string, T[]>();

  /** 離脱した要素を key（assetId）配下の空きスタックへ退避する。 */
  stash(key: string, el: T): void {
    const list = this.free.get(key);
    if (list) list.push(el);
    else this.free.set(key, [el]);
  }

  /**
   * key（assetId）の空き要素を 1 つ取り出す。無ければ null（呼び出し側が新規生成へフォールバック）。
   * 同一 asset の複数レイヤーが同時表示でも、空きが尽きれば null を返す＝要素の重複利用はしない。
   */
  acquire(key: string): T | null {
    const list = this.free.get(key);
    if (!list || list.length === 0) return null;
    const el = list.pop()!;
    if (list.length === 0) this.free.delete(key);
    return el;
  }

  /** key に空き要素があるか（先読み warm-up の重複投入防止）。 */
  has(key: string): boolean {
    const list = this.free.get(key);
    return !!list && list.length > 0;
  }

  /** 特定要素を key のスタックから除去（先読み warm-up の破棄用）。 */
  remove(key: string, el: T): boolean {
    const list = this.free.get(key);
    if (!list) return false;
    const idx = list.indexOf(el);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.free.delete(key);
    return true;
  }

  /** 退避中の全要素を破壊せず列挙する（再利用されず残った要素の遅延静音などに使う）。 */
  peekAll(): T[] {
    const all: T[] = [];
    for (const list of this.free.values()) all.push(...list);
    return all;
  }

  /** 退避中の全要素を返してプールを空にする（dispose 時の teardown 用）。 */
  drain(): T[] {
    const all: T[] = [];
    for (const list of this.free.values()) all.push(...list);
    this.free.clear();
    return all;
  }

  /** 退避中の総数（テスト・診断用）。 */
  size(): number {
    let n = 0;
    for (const list of this.free.values()) n += list.length;
    return n;
  }
}
