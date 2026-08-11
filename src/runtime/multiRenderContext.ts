// §11.2 Phase 6（実験・既定 OFF）— multi-render-context frame concurrency。
//
// browser export のフレーム描画は本来 sequential（1 renderer で resolve → DOM → capture → composite →
// encode を frame ごとに直列）。dominant cost は foreignObject SVG の `img.decode()`（非同期）で、
// 直列では 1 frame の decode 待ち中 main thread は遊ぶ。複数の隔離 render context へ frame を
// ラウンドロビン（`fi % N`）で振り分け、ある context が decode を待つ間に別 context の同期描画を
// 進めることで capture-bound な HTML-heavy comp の wall 短縮を狙う。
//
// 決定論は不変（INV-2 / INV-5）: どの context がどの frame を描いても resolve() は純関数（INV-1）で
// 同一結果になり、frame 結果は timestamp 昇順の bounded reorder queue で整列してから encoder / zip に
// 渡す。context は Canvas2D 合成（frame 間ステートレス・共有 mutable canvas 無し）のみ使う。

import type { Project, TimelineComposition } from "../core/schema";

/** 実験フラグ: 複数レンダリング context でフレームを並行描画する（既定 OFF・非直列化）。 */
export function isMultiRenderContextEnabled(): boolean {
  const g = globalThis as { __mafterMultiRenderContext?: unknown };
  return g.__mafterMultiRenderContext === true;
}

/** context 数（2..4 に clamp、既定 2）。 */
export function multiRenderContextCount(): number {
  const g = globalThis as { __mafterMultiRenderContextCount?: unknown };
  const raw = g.__mafterMultiRenderContextCount;
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.floor(raw) : 2;
  return Math.max(2, Math.min(4, n));
}

/**
 * comp（およびネスト先 comp）に `video` component が含まれるか。
 * 同一 decoder を複数 context で重複させると逆効果になりうるため、video を含む場合は
 * multi-context を無効化して単一 context 経路へフォールバックする（PLAN Phase 6 の除外条件）。
 */
export function compTreeHasVideo(
  project: Project,
  comp: TimelineComposition,
  seen: Set<string> = new Set(),
): boolean {
  if (seen.has(comp.id)) return false;
  seen.add(comp.id);
  for (const obj of comp.objects ?? []) {
    for (const c of obj.components) {
      if (c.type === "video") return true;
      if (c.type === "comp") {
        const childId = (c.props["compId"] as string | undefined) ?? "";
        if (!childId) continue;
        const child = project.compositions.find((x) => x.id === childId);
        if (child && child.kind === "timeline"
          && compTreeHasVideo(project, child as TimelineComposition, seen)) {
          return true;
        }
      }
    }
  }
  return false;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

function makeDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

export interface OrderedMultiContextOptions<TFrame = HTMLCanvasElement> {
  /** 各 context の frame 描画関数（絶対 frame を受け canvas を返す）。length = N。 */
  producers: ((frame: number) => Promise<HTMLCanvasElement>)[];
  totalFrames: number;
  /** 絶対 frame = startFrame + frameIndex。 */
  startFrame: number;
  /**
   * 描画直後に呼ばれ、reorder buffer に保持する形へ変換する。省略時は canvas をそのまま保持。
   * PNG 連番のように「先に符号化できる」経路では blob 化することで 1 枚 2MB の canvas を
   * 350KB 程度に落とせ、窓を大きく取れる（＝遅い producer が emit 位置を塞がなくなる）。
   */
  prepare?: (canvas: HTMLCanvasElement, frameIndex: number) => Promise<TFrame>;
  /** timestamp 昇順で1件ずつ呼ばれる consumer（encode / zip）。frameIndex は 0..totalFrames-1 昇順。 */
  onFrame: (frameIndex: number, frame: TFrame) => Promise<void>;
  /**
   * producer ごとの取得方向。true = 範囲の末尾から取る。
   * 遅い producer（リモート worker）を emit 位置から引き離すためのもので、これがないと
   * 遅い producer が握った先頭フレームで consumer が止まり、速い側も窓に当たって停止する。
   */
  pullFromTail?: boolean[];
  /** render 進捗通知（描画完了ごと。順不同）。 */
  onRendered?: (frameIndex: number) => void;
  /** 有界 reorder window（既定 2*N）。next-to-emit からこの距離以上先の frame は描画を待たせる。 */
  maxReorderAhead?: number;
  /**
   * 1 回の pull で 1 producer が確保する連続フレーム数（既定 8）。
   * 連続で確保すると各 producer が昇順に進むので、早い frame ほど早く emit され consumer が
   * 止まりにくい。1 枚ずつ交互に配ると遅い producer が握った frame で全体が待たされる。
   */
  blockFrames?: number;
  /** abort チェック（throw で中断）。 */
  checkAbort: () => void;
}

export interface OrderedMultiContextResult {
  /** context ごとに描画した frame 数（負荷分散の観測用）。 */
  contextFrameCounts: number[];
  maxReorderAhead: number;
}

/**
 * N 個の producer で frame を並行描画し、timestamp 昇順で `onFrame` に整列供給する。
 * producer c は `fi % N === c` の frame を昇順に担当。reorder queue が maxReorderAhead を超えると
 * その producer は consumer が進むまで backpressure で待つ（メモリ有界）。
 */
export async function runOrderedMultiContext<TFrame = HTMLCanvasElement>(
  opts: OrderedMultiContextOptions<TFrame>,
): Promise<OrderedMultiContextResult> {
  const { producers, totalFrames, startFrame, onFrame, onRendered, checkAbort } = opts;
  const N = producers.length;
  const requestedBlock = Math.max(1, Math.floor(opts.blockFrames ?? 8));
  const maxReorderAhead = Math.max(opts.maxReorderAhead ?? 2 * N, N + 1);
  // 明示された reorder window は縮めない。入らないならブロック側を詰める。
  const blockFrames = Math.max(1, Math.min(requestedBlock, Math.floor(maxReorderAhead / N)));

  const results = new Map<number, TFrame>();
  const prepare = opts.prepare ?? (async (canvas: HTMLCanvasElement) => canvas as unknown as TFrame);
  const ready: Deferred[] = Array.from({ length: totalFrames }, () => makeDeferred());
  const contextFrameCounts = new Array<number>(N).fill(0);

  let nextEmit = 0;
  // consumer が進むたびに resolve される gate（backpressure 解放通知）。
  let gate = makeDeferred();
  let fatal: unknown = null;

  const bump = () => {
    const g = gate;
    gate = makeDeferred();
    g.resolve();
  };
  const fail = (e: unknown) => {
    if (fatal === null) fatal = e ?? new Error("multi-context failed");
    // 待機中の consumer / producer を全て解放する。
    for (const d of ready) d.resolve();
    bump();
  };

  // 連続ブロックの動的 pull + work stealing。静的割り当て（fi % N）は全 producer 同速前提で、
  // 速度差があると遅い担当分で全体が待たされる。ブロックを配り切ったあとは、空いた producer が
  // 詰まっている producer の未着手分を後ろから半分もらうので、末尾のストラグラーも解消される。
  let headPull = 0;
  let tailPull = totalFrames;
  const claims: { next: number; end: number }[] = Array.from({ length: N }, () => ({ next: 0, end: 0 }));

  const claimBlock = (c: number): boolean => {
    if (headPull >= tailPull) return false;
    if (opts.pullFromTail?.[c]) {
      const end = tailPull;
      tailPull = Math.max(headPull, end - blockFrames);
      claims[c] = { next: tailPull, end };
      return true;
    }
    const start = headPull;
    headPull = Math.min(tailPull, start + blockFrames);
    claims[c] = { next: start, end: headPull };
    return true;
  };

  /** 最も未着手が多い producer から後ろ半分を奪う。奪われた側は次の frame を始める前に止まる。 */
  const stealWork = (c: number): boolean => {
    let victim = -1;
    let best = 1;
    for (let i = 0; i < N; i += 1) {
      if (i === c) continue;
      const remaining = claims[i]!.end - claims[i]!.next;
      if (remaining > best) {
        best = remaining;
        victim = i;
      }
    }
    if (victim < 0) return false;
    const take = Math.floor(best / 2);
    if (take < 1) return false;
    const from = claims[victim]!.end - take;
    claims[victim]!.end = from;
    claims[c] = { next: from, end: from + take };
    return true;
  };

  const runProducer = async (c: number): Promise<void> => {
    for (;;) {
      if (fatal !== null) return;
      if (claims[c]!.next >= claims[c]!.end && !claimBlock(c) && !stealWork(c)) return;
      const fi = claims[c]!.next;
      if (fi >= claims[c]!.end) continue;
      claims[c]!.next = fi + 1;
      checkAbort();
      // 有界 reorder window: next-to-emit から遠すぎる frame は consumer を待つ。
      // 条件チェックと gate の await の間に他コードは走らない（single-thread）ため wakeup 取りこぼしなし。
      while (fi - nextEmit >= maxReorderAhead && fatal === null) {
        await gate.promise;
      }
      if (fatal !== null) return;
      const canvas = await producers[c]!(startFrame + fi);
      results.set(fi, await prepare(canvas, fi));
      contextFrameCounts[c] = (contextFrameCounts[c] ?? 0) + 1;
      onRendered?.(fi);
      ready[fi]!.resolve();
    }
  };

  const runConsumer = async (): Promise<void> => {
    for (let fi = 0; fi < totalFrames; fi++) {
      await ready[fi]!.promise;
      if (fatal !== null) throw fatal;
      checkAbort();
      const frame = results.get(fi)!;
      results.delete(fi);
      await onFrame(fi, frame);
      nextEmit = fi + 1;
      bump();
    }
  };

  await Promise.all([
    runConsumer(),
    ...producers.map((_, c) => runProducer(c).catch(fail)),
  ]);
  if (fatal !== null) throw fatal;

  return { contextFrameCounts, maxReorderAhead };
}
