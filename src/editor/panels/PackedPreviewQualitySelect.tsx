import { useState } from "react";
import type { SceneObject } from "../../core/schema";
import {
  evictPreviewMediaAsset,
  reloadPreviewMediaFromProject,
} from "../../runtime/imageAssetCache";
import {
  PACKED_SAME_AS_EXPORT,
  QUALITY_UI_GROUPS,
  effectivePackedQuality,
  footageQualityLabel,
  isProxyTier,
  normalizeFootageQuality,
  normalizePackedPreviewSelection,
  type PackedPreviewSelection,
} from "../../runtime/footageQuality";
import { webcodecsUnavailableReason } from "../../runtime/webcodecsVideoEncode";
import { useEditorStore } from "../store";
import { videoInspectorFieldLabelStyle, videoInspectorSelectStyle } from "./VideoInspectorFoldout";

/**
 * §16.2b — packed alpha レイヤー専用の「プレビュー画質」ドロップダウン。
 *
 * 通常 video の footageQuality（Quality）ドロップダウンは export（mp4/webm/PNG/HTML bundle）にも
 * 使われるが、packed alpha は decode-bound 対策で決定論 export（mp4/webm/PNG）に常に原本を使う
 * （`effectivePackedQuality` が `exportStep` で強制）。そのため packed レイヤーではこの専用
 * コントロールに差し替え、選択が **決定論 export には影響しない**（HTML bundle export の
 * live 再生には反映される）ことを明示する。
 *
 * 通常 tier に加えて **Same as Export Quality**（`PACKED_SAME_AS_EXPORT`）を選べる —
 * [[PackedExportQualitySelect]] の値にそのまま追従する特殊選択肢（既定 proxy tier への
 * 自動差し替えはしない・Export Quality が Original なら文字通り原本を使う）。
 */
export function PackedPreviewQualitySelect({
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
  const value = normalizePackedPreviewSelection(videoComp?.props["footageQuality"]);
  const exportQuality = normalizeFootageQuality(videoComp?.props["packedExportQuality"]);
  const resolvedTier = effectivePackedQuality(value, { exportStep: false, exportQuality });

  const commit = (q: PackedPreviewSelection): void => {
    const nextComponents = videoLayer.components.map((c, i) =>
      i === compIdx ? { ...c, props: { ...c.props, footageQuality: q } } : c,
    );
    updateObject(videoLayer.id, { components: nextComponents }, "Edit Preview Quality");
  };

  const onChange = (q: PackedPreviewSelection): void => {
    commit(q);
    setFailed(false);
    if (!assetId) return;
    const tier = effectivePackedQuality(q, { exportStep: false, exportQuality });
    if (!isProxyTier(tier)) return;
    setBusy(true);
    void (async () => {
      const ok = await ensureProxyTier(assetId, tier);
      if (ok) {
        // ensureProxyTier 完了「後」に evict → 明示リロードしないと、初回一括ロードとの
        // タイミングレースで proxy が preview に一切反映されないことがある（実機検証で確認済み）。
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
      <label style={videoInspectorFieldLabelStyle}>Preview Quality</label>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <select
          value={value}
          onChange={(e) =>
            onChange(
              e.target.value === PACKED_SAME_AS_EXPORT
                ? PACKED_SAME_AS_EXPORT
                : normalizeFootageQuality(e.target.value),
            )
          }
          style={videoInspectorSelectStyle}
        >
          <optgroup label="Link">
            <option value={PACKED_SAME_AS_EXPORT}>Same as Export Quality</option>
          </optgroup>
          {QUALITY_UI_GROUPS.map((g) => (
            <optgroup key={g.label} label={g.label}>
              {g.tiers.map((t) => (
                <option key={t} value={t}>{footageQualityLabel(t)}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {value === PACKED_SAME_AS_EXPORT && !busy && (
          <span style={{ fontSize: 11, opacity: 0.6, whiteSpace: "nowrap" }}>
            → {footageQualityLabel(resolvedTier)}
          </span>
        )}
        {value === "original" && !busy && (
          <span style={{ fontSize: 11, color: "#e0a030", whiteSpace: "nowrap" }}>
            ⚠ may stutter (no proxy)
          </span>
        )}
        {busy && <span style={{ fontSize: 11, opacity: 0.7, whiteSpace: "nowrap" }}>generating…</span>}
        {failed && !busy && (
          <span style={{ fontSize: 11, color: "#e57373", whiteSpace: "nowrap" }}>
            {webcodecsUnavailableReason() ? "proxy failed (no WebCodecs)" : "proxy failed"}
          </span>
        )}
      </div>
      <div style={{ fontSize: 10, color: "#888", marginTop: 3 }}>
        プレビューと HTML バンドル書き出しの再生にのみ影響します。mp4 / webm / PNG 書き出しは常に原本の画質を使用します。
        「Same as Export Quality」は Export Quality の設定に自動追従します。「Original」を選ぶと文字通り原本を使います
        （proxy 無し・環境によっては再生がカクつくことがあります）。
      </div>
    </div>
  );
}
