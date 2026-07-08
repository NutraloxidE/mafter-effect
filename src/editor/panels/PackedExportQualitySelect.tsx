import { useState } from "react";
import type { SceneObject } from "../../core/schema";
import {
  evictPreviewMediaAsset,
  reloadPreviewMediaFromProject,
} from "../../runtime/imageAssetCache";
import {
  PACKED_SAME_AS_EXPORT,
  QUALITY_UI_GROUPS,
  footageQualityLabel,
  isProxyTier,
  normalizeFootageQuality,
  normalizePackedPreviewSelection,
  type FootageQuality,
} from "../../runtime/footageQuality";
import { webcodecsUnavailableReason } from "../../runtime/webcodecsVideoEncode";
import { useEditorStore } from "../store";
import { videoInspectorFieldLabelStyle, videoInspectorSelectStyle } from "./VideoInspectorFoldout";

/**
 * §16.2b — packed alpha レイヤー専用の「書き出し画質」ドロップダウン。
 *
 * [[PackedPreviewQualitySelect]]（プレビュー画質・`footageQuality` prop）とは独立した
 * `packedExportQuality` prop を編集する。`effectivePackedQuality` は `exportStep`（決定論
 * export/bake）のときだけこちらを参照するため、**プレビューの表示画質には一切影響しない** —
 * ただし Preview Quality が「Same as Export Quality」にリンクされている場合はこの変更が
 * プレビューにも波及するため、その場合だけ evict + 明示リロードでプレビューを追従させる。
 * 既定は `"original"`（既存プロジェクト・未設定時は今までどおり原本で書き出す）。
 */
export function PackedExportQualitySelect({
  videoLayer,
  compIdx,
  updateObject,
}: {
  videoLayer: SceneObject;
  compIdx: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
}) {
  const ensureProxyTier = useEditorStore((s) => s.ensureProxyTier);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const videoComp = videoLayer.components[compIdx];
  const assetId = typeof videoComp?.props["asset"] === "string" ? (videoComp.props["asset"] as string) : "";
  const value = normalizeFootageQuality(videoComp?.props["packedExportQuality"]);

  const commit = (q: FootageQuality): void => {
    const nextComponents = videoLayer.components.map((c, i) =>
      i === compIdx ? { ...c, props: { ...c.props, packedExportQuality: q } } : c,
    );
    updateObject(videoLayer.id, { components: nextComponents }, "Edit Export Quality");
  };

  const onChange = (q: FootageQuality): void => {
    commit(q);
    setFailed(false);
    if (!assetId) return;
    const previewLinked = normalizePackedPreviewSelection(videoComp?.props["footageQuality"]) === PACKED_SAME_AS_EXPORT;
    const needsProxy = isProxyTier(q);
    if (!needsProxy && !previewLinked) return;
    // 事前生成しておく（本番 export 時に collectExportProxyJobs が再度 ensureProxyTier を
    // 呼ぶが既に生成済みなら即 true を返す）。プレビューが「Same as Export Quality」で
    // リンクされていなければプレビュー側の URL 解決には使われないため evict/reload は不要。
    setBusy(true);
    void (async () => {
      const ok = needsProxy ? await ensureProxyTier(assetId, q) : true;
      if (ok && previewLinked) {
        evictPreviewMediaAsset(assetId);
        const fs = useEditorStore.getState().getFs();
        const proj = useEditorStore.getState().project;
        if (proj) {
          await reloadPreviewMediaFromProject(proj, fs);
          useEditorStore.setState((s) => ({ projectRevision: s.projectRevision + 1 }));
        }
      }
      setBusy(false);
      setFailed(!ok);
    })();
  };

  return (
    <div style={{ marginBottom: 6 }}>
      <label style={videoInspectorFieldLabelStyle}>Export Quality</label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={value}
          onChange={(e) => onChange(normalizeFootageQuality(e.target.value))}
          style={videoInspectorSelectStyle}
        >
          {QUALITY_UI_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.tiers.map((t) => (
                <option key={t} value={t}>{footageQualityLabel(t)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {busy && <span style={{ fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>generating…</span>}
        {failed && !busy && (
          <span style={{ fontSize: 11, color: "#e57373", whiteSpace: "nowrap" }}>
            {webcodecsUnavailableReason() ? "proxy failed (no WebCodecs)" : "proxy failed"}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "#888", marginTop: 3 }}>
        mp4 / webm / PNG 書き出し（および HTML バンドルの焼き込みレイヤー）の画質を調整します。プレビューの表示には影響しません。既定は Original（原本画質）です。
      </div>
    </div>
  );
}
