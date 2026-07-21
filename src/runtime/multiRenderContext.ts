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

export interface OrderedMultiContextOptions {
  /** 各 context の frame 描画関数（絶対 frame を受け canvas を返す）。length = N。 */
  producers: ((frame: number) => Promise<HTMLCanvasElement>)[];
  totalFrames: number;
  /** 絶対 frame = startFrame + frameIndex。 */
  startFrame: number;
  /** timestamp 昇順で1件ずつ呼ばれる consumer（encode / zip）。frameIndex は 0..totalFrames-1 昇順。 */
  onFrame: (frameIndex: number, canvas: HTMLCanvasElement) => Promise<void>;
  /** render 進捗通知（描画完了ごと。順不同）。 */
  onRendered?: (frameIndex: number) => void;
  /** 有界 reorder window（既定 2*N）。next-to-emit からこの距離以上先の frame は描画を待たせる。 */
  maxReorderAhead?: number;
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
export async function runOrderedMultiContext(
  opts: OrderedMultiContextOptions,
): Promise<OrderedMultiContextResult> {
  const { producers, totalFrames, startFrame, onFrame, onRendered, checkAbort } = opts;
  const N = producers.length;
  const maxReorderAhead = Math.max(opts.maxReorderAhead ?? 2 * N, N + 1);

  const results = new Map<number, HTMLCanvasElement>();
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

  const runProducer = async (c: number): Promise<void> => {
    for (let fi = c; fi < totalFrames; fi += N) {
      if (fatal !== null) return;
      checkAbort();
      // 有界 reorder window: next-to-emit から遠すぎる frame は consumer を待つ。
      // 条件チェックと gate の await の間に他コードは走らない（single-thread）ため wakeup 取りこぼしなし。
      while (fi - nextEmit >= maxReorderAhead && fatal === null) {
        await gate.promise;
      }
      if (fatal !== null) return;
      const canvas = await producers[c]!(startFrame + fi);
      results.set(fi, canvas);
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
      const canvas = results.get(fi)!;
      results.delete(fi);
      await onFrame(fi, canvas);
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
