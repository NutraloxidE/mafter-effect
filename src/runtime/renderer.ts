import type { CompositionMeta, Frame } from "../core/schema";
import type { ResolvedScene } from "./resolved";

// §8 レンダラ抽象。resolve() の純粋出力 ResolvedScene のみ受け取る (INV-3)。
// MVP は DomRenderer 1 本（別ファイル, DOM 依存）。canvas2d/webgl/webgpu は将来同インターフェースで追加。
export interface Renderer {
  readonly kind: "dom" | "canvas2d" | "webgl" | "webgpu";
  mount(container: HTMLElement, comp: CompositionMeta): void;
  renderFrame(scene: ResolvedScene, frame: Frame): void;
  resize(w: number, h: number): void;
  dispose(): void;
}
