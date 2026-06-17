import type { CompositionMeta, Frame, HtmlComposition, RGBA, TimelineComposition } from "../core/schema";
import type { FontOutlineCache } from "./fontOutlineCache";
import type { HtmlCompPlayer } from "./htmlComp";
import { globalPluginRegistry } from "./pluginRegistry";
import type { Renderer } from "./renderer";
import type { ResolvedComponent, ResolvedObject, ResolvedScene } from "./resolved";
import { compChildFrame, isCompNestDepthAllowed } from "./compLayer";
import { resolve } from "./resolve";
import { applyTextEl, rgbaCss } from "./textRender";

// §8 DomRenderer — フラット matrix3d レンダラ。
// 各 ResolvedObject を root の兄弟 div として並べる。ネストしない。
// transform-origin:0 0（anchor は行列に内包済み, §6.3）。
// opacity は per-object（CSS opacity は子へ合成される stacking context を作るため、
// 兄弟フラット配置で回避, §5.4-note）。
//
// background は CompositionMeta（mount で受け取る, §8 シグネチャ）から取る。
// ResolvedScene には載せない（INV-3: レンダラは ResolvedScene のみ受け取るが、静的 comp メタは mount 経由）。
//
// 子要素はフレーム毎に innerHTML で破棄せず **reconcile** する（<img> の再読み込み flicker 回避）。
// component の型シグネチャが変わったときだけ作り直す。

const BASE_Z = 10; // z-index はこの値を起点に zOrder*BASE_Z で割り当てる

interface ObjectEntry {
  div: HTMLDivElement;
  childSig: string; // component 型の連結。変化したら子を作り直す
  children: HTMLElement[];
}

export class DomRenderer implements Renderer {
  readonly kind = "dom" as const;

  private root: HTMLDivElement | null = null;
  private entries = new Map<string, ObjectEntry>();
  private currentComp: CompositionMeta | null = null;

  // §7 HTML comp サポート: HtmlCompPlayer を注入（optional）。
  // mount 後に setHtmlPlayer() で差し替え可。
  private htmlPlayer: HtmlCompPlayer | null = null;

  // §26.4 テキスト品質モード
  private textQuality: "draft" | "precise" = "precise";
  private fontCache: FontOutlineCache | null = null;

  setTextQuality(mode: "draft" | "precise"): void {
    this.textQuality = mode;
  }

  setFontCache(cache: FontOutlineCache | null): void {
    this.fontCache = cache;
  }

  setHtmlPlayer(player: HtmlCompPlayer | null): void {
    this.htmlPlayer = player;
  }

  mount(container: HTMLElement, comp: CompositionMeta): void {
    this.dispose();
    const root = document.createElement("div");
    root.style.cssText = [
      "position:relative",
      "overflow:hidden",
      "transform-style:preserve-3d",
      "width:100%",
      "height:100%",
    ].join(";");
    if (comp.background) root.style.background = rgbaCss(comp.background);
    container.appendChild(root);
    this.root = root;
    this.currentComp = comp;
  }

  renderFrame(scene: ResolvedScene, frame: Frame): void {
    if (!this.root) return;

    // camera / perspective (§6.5)
    if (scene.camera) {
      const perspective = scene.height / 2 / Math.tan((scene.camera.fov * Math.PI) / 360);
      this.root.style.perspective = `${perspective}px`;
      this.root.style.perspectiveOrigin = "50% 50%";
      this.root.style.transform = mat4ToCss(scene.camera.viewMatrix);
    } else {
      this.root.style.perspective = "";
      this.root.style.transform = "";
    }

    const seen = new Set<string>();
    for (const obj of scene.objects) {
      seen.add(obj.id);
      let entry = this.entries.get(obj.id);
      if (!entry) {
        const div = document.createElement("div");
        div.style.position = "absolute";
        div.style.top = "0";
        div.style.left = "0";
        div.style.transformOrigin = "0 0";
        div.dataset.objectId = obj.id;
        this.root.appendChild(div);
        entry = { div, childSig: "", children: [] };
        this.entries.set(obj.id, entry);
      }
      this.applyObject(entry, obj, frame);
    }

    // 非表示になったオブジェクトを削除
    for (const [id, entry] of this.entries) {
      if (!seen.has(id)) {
        entry.div.remove();
        this.entries.delete(id);
        this.htmlPlayer?.unmountObject(id);
      }
    }
  }

  resize(w: number, h: number): void {
    if (!this.root) return;
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
  }

  /** §11.2 export 用: マウントした root 要素を返す。 */
  getRoot(): HTMLElement | null {
    return this.root;
  }

  dispose(): void {
    if (this.root) {
      this.root.remove();
      this.root = null;
    }
    this.entries.clear();
    this.currentComp = null;
  }

  private applyObject(entry: ObjectEntry, obj: ResolvedObject, frame: Frame): void {
    entry.div.style.transform = mat4ToCss(obj.worldTransform);
    entry.div.style.opacity = String(obj.opacity);
    entry.div.style.zIndex = String(Math.round(obj.zOrder * BASE_Z));

    const sig = obj.components.map((c) => c.type).join("|");
    if (sig !== entry.childSig) {
      // html comp が含まれていた場合は player のエントリも解放してから作り直す
      if (entry.childSig.split("|").includes("html")) {
        this.htmlPlayer?.unmountObject(obj.id);
      }
      // 構造が変わった: 子を作り直す
      entry.div.innerHTML = "";
      entry.children = obj.components.map((c) => {
        const el = createComponentEl(c.type);
        entry.div.appendChild(el);
        return el;
      });
      entry.childSig = sig;
    }
    // props を in-place で更新（<img> src は変化時のみ → 再読込しない）
    obj.components.forEach((c, i) => {
      const el = entry.children[i];
      if (el) updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache);

      // Plugin component: registry から ComponentDef.render を呼ぶ（組み込み型は未登録でスキップ）
      if (el) {
        const pluginDef = globalPluginRegistry.getComponentDef(c.type);
        if (pluginDef) {
          pluginDef.render({
            el,
            props: c.props as Record<string, unknown>,
            frame,
            width: this.currentComp?.width ?? 0,
            height: this.currentComp?.height ?? 0,
          });
        }
      }

      // §23 comp: 子 timeline comp をコンテナ div にネスト描画
      if (c.type === "comp" && el) {
        const compId = (c.props["compId"] as string | undefined) ?? "";
        const childComp = this.pendingTimelineComps?.get(compId);
        if (childComp) {
          const inPoint = (c.props["_inPoint"] as number) ?? 0;
          const trimStart = (c.props["trimStart"] as number) ?? 0;
          const childFrame = compChildFrame(frame, inPoint, trimStart, childComp.duration);
          this.renderNestedComp(el, childComp, childFrame, 1);
        }
      }

      // html comp: HtmlCompPlayer に mount/render を委譲
      if (c.type === "html" && this.htmlPlayer && el) {
        const compId = (c.props["compId"] as string | undefined) ?? "";
        if (compId) {
          // HtmlComposition を currentComp から探す（timeline comp 内の html component 用）
          // currentComp は TimelineComposition。html comp meta は Project から別途渡される。
          // ここでは player.mountObject / renderObject を呼ぶのみ。
          // inPoint は ResolvedObject には含まれないため props から取る（fallback=0）。
          const inPoint = (c.props["inPoint"] as number | undefined) ?? 0;
          const fps = (this.currentComp?.fps) ?? 30;
          const htmlComp: HtmlComposition | null =
            this.pendingHtmlComps?.get(compId) ?? null;
          if (htmlComp) {
            // host div に comp 寸法を与える（Shadow DOM は 100% で追従する）。
            el.style.width = `${htmlComp.width}px`;
            el.style.height = `${htmlComp.height}px`;
            this.htmlPlayer.mountObject(obj.id, compId, el);
            this.htmlPlayer.renderObject(
              obj.id,
              compId,
              frame,
              inPoint,
              fps,
              htmlComp,
              c.props as Record<string, unknown>,
            );
          }
        }
      }
    });
  }

  // html comp のメタ情報を DomRenderer に注入する（ProximityPanel / store から呼ぶ）。
  private pendingHtmlComps: Map<string, HtmlComposition> | null = null;

  setHtmlComps(comps: Map<string, HtmlComposition>): void {
    this.pendingHtmlComps = comps;
  }

  // §23 timeline comp ネスト用: 現プロジェクトの timeline comp 一覧を注入する。
  private pendingTimelineComps: Map<string, TimelineComposition> | null = null;

  setTimelineComps(comps: Map<string, TimelineComposition>): void {
    this.pendingTimelineComps = comps;
  }

  // §23 ネスト comp をコンテナ div に描画する (Phase 1: 非 reconcile、solid/text/image のみ対応)。
  // html/plugin component を含む子オブジェクトは描画されない（Phase 2 以降で対応）。
  // depth で無限ループを防ぐ（循環参照が挿入時に阻止されるが念のため）。
  private renderNestedComp(container: HTMLElement, childComp: TimelineComposition, childFrame: Frame, depth: number): void {
    if (!isCompNestDepthAllowed(depth)) return;
    const childScene = resolve(childComp, childFrame);
    container.style.cssText = `position:absolute;top:0;left:0;width:${childComp.width}px;height:${childComp.height}px;overflow:hidden;transform-style:preserve-3d`;
    if (childComp.background) container.style.background = rgbaCss(childComp.background);
    else container.style.background = "";

    // 毎フレーム再描画（Phase 1 簡易実装。html/plugin comp は対象外）
    container.innerHTML = "";
    for (const obj of childScene.objects) {
      const div = document.createElement("div");
      div.style.cssText = `position:absolute;top:0;left:0;transform-origin:0 0;transform:${mat4ToCss(obj.worldTransform)};opacity:${obj.opacity};z-index:${Math.round(obj.zOrder * BASE_Z)}`;
      for (const c of obj.components) {
        if (c.type === "comp") {
          // ネストされた comp は再帰描画（深度制限付き）
          const nestedCompId = c.props["compId"] as string | undefined;
          const nestedComp = this.pendingTimelineComps?.get(nestedCompId ?? "");
          if (nestedComp) {
            const innerEl = document.createElement("div");
            const inPoint = (c.props["_inPoint"] as number) ?? 0;
            const trimStart = (c.props["trimStart"] as number) ?? 0;
            const nestedFrame = compChildFrame(childFrame, inPoint, trimStart, nestedComp.duration);
            this.renderNestedComp(innerEl, nestedComp, nestedFrame, depth + 1);
            div.appendChild(innerEl);
          }
          continue;
        }
        const el = createComponentEl(c.type);
        updateComponentEl(el, c.type, c.props, this.textQuality, this.fontCache);
        div.appendChild(el);
      }
      container.appendChild(div);
    }
  }
}

function updateComponentEl(
  el: HTMLElement,
  type: string,
  props: ResolvedComponent["props"],
  textQuality: "draft" | "precise" = "draft",
  fontCache: FontOutlineCache | null = null,
): void {
  switch (type) {
    case "solid": {
      const color = props["color"] as RGBA | undefined;
      const size = props["size"] as { x: number; y: number } | undefined;
      el.style.width = size ? `${size.x}px` : "100%";
      el.style.height = size ? `${size.y}px` : "100%";
      el.style.background = color ? rgbaCss(color) : "#888";
      break;
    }
    case "shape": {
      const fill = props["fill"] as RGBA | undefined;
      const size = props["size"] as { x: number; y: number } | undefined;
      const kind = props["kind"] as string | undefined;
      const radius = props["radius"] as number | undefined;
      el.style.width = size ? `${size.x}px` : "100px";
      el.style.height = size ? `${size.y}px` : "100px";
      el.style.background = fill ? rgbaCss(fill) : "#888";
      el.style.borderRadius = kind === "ellipse" ? "50%" : radius ? `${radius}px` : "0";
      break;
    }
    case "text": {
      const fontFamily = typeof props["font"] === "string" ? props["font"] : "sans-serif";
      const font = fontCache?.getFont(fontFamily) ?? null;
      applyTextEl(el, props, textQuality, font);
      break;
    }
    case "image": {
      const img = el as HTMLImageElement;
      const fit = props["fit"] as string | undefined;
      img.style.objectFit = (fit as "contain" | "cover" | "fill") ?? "contain";
      // asset の src 解決は AssetStore 経由（後続）。MVP は src を直接 props で受ける。
      const src = (props["src"] as string | undefined) ?? "";
      if (img.getAttribute("src") !== src) img.src = src; // 変化時のみ → flicker 回避
      break;
    }
  }
}

function mat4ToCss(m: readonly number[]): string {
  return `matrix3d(${m.join(",")})`;
}

function createComponentEl(type: string): HTMLElement {
  if (type === "image") {
    const img = document.createElement("img");
    img.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
    return img;
  }
  const el = document.createElement("div");
  el.style.cssText = "position:absolute;top:0;left:0;pointer-events:none";
  return el;
}
