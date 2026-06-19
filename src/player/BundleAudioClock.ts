import type { Frame, Project, TimelineComposition } from "../core/schema";

export interface AudioLayerSpec {
  objectId: string;
  assetPath: string;
  inPoint: Frame;
  outPoint: Frame;
  trimStart: Frame;
  gain: number;
}

/** §11.7 — 音声マスタークロック。HTMLAudioElement で file:// 互換再生。 */
export class BundleAudioClock {
  private readonly elements = new Map<string, HTMLAudioElement>();
  private startWallMs = 0;
  private playing = false;
  private rafId: number | null = null;
  private onFrame: ((frame: number) => void) | null = null;
  private onEnded: (() => void) | null = null;

  constructor(
    private readonly fps: number,
    private readonly rangeStart: Frame,
    private readonly rangeEnd: Frame,
    private readonly urlForPath: (path: string) => string,
    private readonly loop: boolean,
  ) {}

  async prepare(project: Project, comp: TimelineComposition): Promise<boolean> {
    const layers = collectAudioLayers(project, comp);
    if (layers.length === 0) return false;

    for (const layer of layers) {
      const audio = document.createElement("audio");
      audio.src = this.urlForPath(layer.assetPath);
      audio.preload = "auto";
      audio.volume = Math.max(0, Math.min(1, layer.gain));
      this.elements.set(layer.objectId, audio);
      try {
        await audio.play();
        audio.pause();
        audio.currentTime = 0;
      } catch {
        /* autoplay policy — unmute on user gesture if needed */
      }
    }
    return true;
  }

  setFrameCallback(cb: (frame: number) => void): void {
    this.onFrame = cb;
  }

  setEndedCallback(cb: () => void): void {
    this.onEnded = cb;
  }

  play(fromFrame: Frame): void {
    this.playing = true;
    this.startWallMs = performance.now() - (fromFrame - this.rangeStart) * (1000 / this.fps);
    for (const [id, el] of this.elements) {
      void id;
      try {
        el.currentTime = Math.max(0, (fromFrame - this.rangeStart) / this.fps);
        void el.play();
      } catch {
        /* ignore */
      }
    }
    this.tick();
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    for (const el of this.elements.values()) {
      el.pause();
    }
  }

  dispose(): void {
    this.pause();
    for (const el of this.elements.values()) {
      el.src = "";
    }
    this.elements.clear();
  }

  private tick = (): void => {
    if (!this.playing) return;
    const elapsedSec = (performance.now() - this.startWallMs) / 1000;
    const frame = this.rangeStart + Math.floor(elapsedSec * this.fps);
    const lastFrame = this.rangeEnd - 1;
    if (frame >= lastFrame) {
      this.onFrame?.(lastFrame);
      if (this.loop) {
        this.startWallMs = performance.now();
        for (const el of this.elements.values()) {
          try {
            el.currentTime = 0;
            void el.play();
          } catch {
            /* ignore */
          }
        }
        this.rafId = requestAnimationFrame(this.tick);
      } else {
        this.playing = false;
        for (const el of this.elements.values()) el.pause();
        this.onEnded?.();
      }
      return;
    }
    this.onFrame?.(frame);
    this.rafId = requestAnimationFrame(this.tick);
  };
}

function collectAudioLayers(project: Project, comp: TimelineComposition): AudioLayerSpec[] {
  const out: AudioLayerSpec[] = [];
  for (const obj of comp.objects) {
    if (!obj.enabled) continue;
    const audioCmp = obj.components.find((c) => c.type === "audio");
    if (!audioCmp) continue;
    const assetId = audioCmp.props["asset"];
    if (typeof assetId !== "string") continue;
    const asset = project.assets.find((a) => a.id === assetId);
    if (!asset) continue;
    const gain = typeof audioCmp.props["gain"] === "number" ? audioCmp.props["gain"] : 1;
    const trimStart = typeof audioCmp.props["trimStart"] === "number" ? audioCmp.props["trimStart"] : 0;
    out.push({
      objectId: obj.id,
      assetPath: asset.path,
      inPoint: obj.inPoint,
      outPoint: obj.outPoint,
      trimStart,
      gain,
    });
  }
  return out;
}

export function hasAudioLayers(project: Project, comp: TimelineComposition): boolean {
  return collectAudioLayers(project, comp).length > 0;
}
