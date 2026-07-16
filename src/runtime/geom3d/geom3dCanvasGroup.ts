/**
 * §5.5f-1 WebGL canvas 共有の host 解決（純関数・INV-1）。
 *
 * Inspector（SceneObject を見る）と DomRenderer（ResolvedObject を見る）の両方から
 * **同じ規則**で呼ばれる — 表示している host と実際に描き込む canvas がズレないよう、
 * 判定は必ずこの 1 箇所に集約する。
 */

/** host 解決に必要な最小情報。SceneObject / ResolvedObject の双方から詰められる。 */
export interface Geom3DLayerInfo {
  id: string;
  zOrder: number;
  /** Null / 音声のみ = 描画に寄与しない ⇒ チェーン探索で透過する（§5.5f-1）。 */
  transparentToChain: boolean;
  /** geomEnabled=true の WebGL レイヤーか。 */
  webgl: boolean;
  /** geomShareCanvas。false なら常に自分が host（グループの終端）。 */
  share: boolean;
}

function byDrawOrder(a: Geom3DLayerInfo, b: Geom3DLayerInfo): number {
  // resolve.ts の並びと同一規約（zOrder 昇順＝下→上、tie は id で安定化）。
  return a.zOrder !== b.zOrder ? a.zOrder - b.zOrder : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * WebGL レイヤー id → canvas を宿す host レイヤー id（自分が最上位なら自分の id）。
 * 非 WebGL レイヤーはキーに含まれない。
 */
export function resolveGeom3DCanvasHosts(layers: readonly Geom3DLayerInfo[]): Map<string, string> {
  const sorted = [...layers].sort(byDrawOrder);
  const hosts = new Map<string, string>();
  // 上から下へ解く＝上位の host が確定済みなので推移解決が 1 パスで済む（循環も原理的に起きない）。
  for (let i = sorted.length - 1; i >= 0; i--) {
    const self = sorted[i]!;
    if (!self.webgl) continue;
    if (!self.share) {
      hosts.set(self.id, self.id);
      continue;
    }
    let host = self.id;
    for (let j = i + 1; j < sorted.length; j++) {
      const above = sorted[j]!;
      if (above.transparentToChain) continue;
      // 最初に当たった描画レイヤーが WebGL なら合流、そうでなければチェーン切断（自分が host）。
      if (above.webgl) host = hosts.get(above.id) ?? above.id;
      break;
    }
    hosts.set(self.id, host);
  }
  return hosts;
}

/** §5.5f-1 チェーン探索で透過する層か（Null / 全 component が audio）。 */
export function isTransparentToGeom3DChain(
  isNull: boolean | undefined,
  componentTypes: readonly string[],
): boolean {
  if (isNull === true) return true;
  return componentTypes.length > 0 && componentTypes.every((t) => t === "audio");
}

/** SceneObject / ResolvedObject の component を両方受けられる最小形。 */
export interface Geom3DComponentLike {
  type: string;
  props: Record<string, unknown>;
}

/**
 * §5.5f-1 このレイヤーを WebGL 描画たらしめている component の index（無ければ -1）。
 * **「レイヤーが WebGL か」の判定はここが唯一の正**。現状は 3D-extrude text のみだが、
 * shape 等の押し出しが増えたら**この関数だけを広げれば** Inspector / DomRenderer 双方に伝播する。
 */
export function geom3dWebglComponentIndex(components: readonly Geom3DComponentLike[]): number {
  return components.findIndex((c) => c.type === "text" && c.props["geomEnabled"] === true);
}

/** SceneObject / ResolvedObject → host 解決の入力。Inspector と DomRenderer で同じ写像を通す。 */
export function toGeom3DLayerInfo(obj: {
  id: string;
  zOrder: number;
  isNull?: boolean;
  components: readonly Geom3DComponentLike[];
}): Geom3DLayerInfo {
  const webglIdx = geom3dWebglComponentIndex(obj.components);
  return {
    id: obj.id,
    zOrder: obj.zOrder,
    transparentToChain: isTransparentToGeom3DChain(obj.isNull, obj.components.map((c) => c.type)),
    webgl: webglIdx >= 0,
    share: obj.components[webglIdx]?.props["geomShareCanvas"] === true,
  };
}
