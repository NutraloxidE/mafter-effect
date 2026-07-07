import { useCallback, useState } from "react";
import type { AssetEntry, Project, SceneObject, TimelineComposition } from "../../core/schema";
import { isSplitAlphaVideoMeta } from "../../runtime/imageAssetCache";
import { convertSplitAssetToPacked, isConvertError } from "../subjectExtract/convertSplitToPacked";
import { currentTimelineComp, useEditorStore } from "../store";
import {
  VideoInspectorFoldout,
  videoInspectorBtnStyle,
} from "./VideoInspectorFoldout";

/**
 * §16.2 プランv2 §2.4 — Inspector（レイヤー単位）の packed 化アクション。
 * fps はこのレイヤーが属する host comp の fps を使う（曖昧さがない一意の情報源）。
 * 変換後は「この layer だけ」参照を packed に差し替える（同じ split アセットを参照する
 * 他レイヤーには触れない・非破壊）。
 */
export function PackedAlphaConvertFields({ videoLayer }: { videoLayer: SceneObject }) {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const applyCommand = useEditorStore((s) => s.applyCommand);
  const getFs = useEditorStore((s) => s.getFs);

  const [expanded, setExpanded] = useState(false);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number } | null>(null);

  const comp = currentTimelineComp(project, compId);
  const videoComp = videoLayer.components.find((c) => c.type === "video");
  const assetId = typeof videoComp?.props["asset"] === "string" ? videoComp.props["asset"] : null;
  const asset = project?.assets.find((a) => a.id === assetId);

  const handleConvert = useCallback(async () => {
    if (!project || !comp || !assetId) return;
    setRunning(true);
    setStatus("packed 化しています…");
    setProgress(null);
    try {
      const result = await convertSplitAssetToPacked(
        project,
        getFs(),
        assetId,
        comp.fps,
        (current, total) => setProgress({ current, total }),
      );
      if (isConvertError(result)) {
        setStatus(`失敗 — ${result.error}`);
        return;
      }
      const before = useEditorStore.getState().project as Project;
      const after: Project = {
        ...before,
        assets: [...before.assets, result.asset as AssetEntry],
        compositions: before.compositions.map((c) => {
          if (c.id !== comp.id || c.kind !== "timeline") return c;
          const tl = c as TimelineComposition;
          return {
            ...tl,
            objects: tl.objects.map((o) => {
              if (o.id !== videoLayer.id) return o;
              return {
                ...o,
                components: o.components.map((cmp) =>
                  cmp.type === "video" ? { ...cmp, props: { ...cmp.props, asset: result.asset.id } } : cmp,
                ),
              };
            }),
          };
        }),
      };
      applyCommand({ label: "packed 化（split → packed）", before, after });
      setStatus(`完了 — このレイヤーの参照を packed に差し替えました（元 split はそのまま残っています）`);
    } catch (e) {
      setStatus(`失敗 — ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }, [project, comp, assetId, videoLayer.id, getFs, applyCommand]);

  if (!asset || asset.kind !== "video" || !isSplitAlphaVideoMeta(asset.meta)) return null;

  return (
    <VideoInspectorFoldout label="Packed 化（軽量化）" expanded={expanded} onToggle={() => setExpanded((v) => !v)}>
      <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
        split alpha（color+mask 2本）を 1本の packed 動画に変換し、このレイヤーの参照だけ差し替えます。
        元の split アセットは削除されません（非破壊・気に入らなければ Source で戻せます）。
      </div>
      <button
        onClick={handleConvert}
        disabled={running}
        style={{ ...videoInspectorBtnStyle, opacity: running ? 0.6 : 1 }}
      >
        {running ? "変換中…" : "Packed 化"}
      </button>
      {progress && (
        <div style={{ fontSize: 10, color: "#888", marginTop: 4 }}>
          {progress.current} / {progress.total}
        </div>
      )}
      {status && <div style={{ fontSize: 10, color: "#aaa", marginTop: 4 }}>{status}</div>}
    </VideoInspectorFoldout>
  );
}
