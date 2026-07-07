import {
  useCallback,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SceneObject } from "../../core/schema";
import { newBinId, newObjectId } from "../../core/ids";
import { DIR_ASSETS } from "../../core/paths";
import type { AssetEntry } from "../../core/schema";
import { ScrubNumber } from "../ScrubNumber";
import { currentTimelineComp, useEditorStore } from "../store";
import {
  applySubjectExtractToProject,
  resolveSubjectExtractAssetSize,
  subjectExtractLayerName,
} from "../subjectExtract/applySubjectExtract";
import { runSubjectExtract } from "../subjectExtract/runSubjectExtract";
import type { SubjectExtractTarget } from "../subjectExtract/types";
import {
  VideoInspectorFoldout,
  videoInspectorBtnStyle,
  videoInspectorFieldLabelStyle,
  videoInspectorScrubInputStyle,
  videoInspectorScrubRowStyle,
  videoInspectorSelectStyle,
} from "./VideoInspectorFoldout";

const SUBJECT_OPTIONS: Array<{ id: SubjectExtractTarget; label: string }> = [
  { id: "person", label: "Person（人物）" },
];

/**
 * Video レイヤー Inspector 内の Subject Extract UI（折りたたみ）。
 * 見た目は Motion Track と同型（VideoInspectorFoldout + 共有 styles）。
 */
export function SubjectExtractFields({ videoLayer }: { videoLayer: SceneObject }) {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const applyCommand = useEditorStore((s) => s.applyCommand);
  const getFs = useEditorStore((s) => s.getFs);
  const selectObjects = useEditorStore((s) => s.selectObjects);

  const comp = currentTimelineComp(project, compId);
  const videoComp = videoLayer.components.find((c) => c.type === "video");
  const assetId = typeof videoComp?.props["asset"] === "string" ? videoComp.props["asset"] : null;

  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<SubjectExtractTarget>("person");
  const [sampleInterval, setSampleInterval] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; phase: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const btnStyle = videoInspectorBtnStyle;
  const selectStyle = videoInspectorSelectStyle;
  const scrubInputStyle = videoInspectorScrubInputStyle;
  const scrubRowStyle = videoInspectorScrubRowStyle;

  const scrubWrap = (node: ReactNode) => (
    <div style={{ pointerEvents: running ? "none" : undefined, opacity: running ? 0.45 : 1 }}>
      {node}
    </div>
  );

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    setProgress(null);
    setStatus("キャンセルしました");
  }, []);

  const handleExtract = useCallback(async () => {
    if (!project || !comp || !assetId) return;

    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setStatus("セグメンターを読み込み中…");
    setProgress(null);

    try {
      const result = await runSubjectExtract({
        project,
        comp,
        videoLayer,
        assetId,
        fs: getFs(),
        imageCache: undefined,
        options: { target, sampleInterval },
        signal: ac.signal,
        onProgress: (p) => {
          const labels: Record<string, string> = {
            loading: "セグメンターを読み込み中…",
            extracting: "フレーム抽出",
            segmenting: "人物マスク推定",
            encoding: "WebM エンコード",
            applying: "プロジェクトへ適用",
          };
          setStatus(labels[p.phase] ?? p.phase);
          setProgress({ current: p.current, total: p.total, phase: p.phase });
        },
      });

      setStatus("プロジェクトへ適用中…");
      setProgress({ current: 0, total: 1, phase: "applying" });

      const newAssetId = newObjectId();
      const newLayerId = newObjectId();
      const packedExt = result.mode === "packed" && result.packedContainer === "mp4" ? "mp4" : "webm";
      const assetPath = `${DIR_ASSETS}/${newAssetId}.${result.mode === "packed" ? packedExt : "webm"}`;
      await getFs().write(assetPath, result.webmBytes);

      const sourceAsset = project.assets.find((a) => a.id === assetId);
      const size = resolveSubjectExtractAssetSize(sourceAsset?.meta, {
        width: result.width,
        height: result.height,
      });

      const meta: Record<string, unknown> = {
        width: size.width,
        height: size.height,
        duration: result.durationSec,
        mime: result.mode === "packed" && packedExt === "mp4" ? "video/mp4" : "video/webm",
        hasAlpha: true,
        extractedFrom: assetId,
        footageKind: "native",
      };
      if (result.mode === "split" && result.alphaWebmBytes) {
        const alphaPath = `${DIR_ASSETS}/${newAssetId}.alpha.webm`;
        await getFs().write(alphaPath, result.alphaWebmBytes);
        meta.alphaMode = "split";
        meta.alphaPath = alphaPath;
      } else if (result.mode === "packed" && result.packedLayout) {
        // §2.2 — meta フィールド名はプラン §7 でユーザー承認済み（2026-07-07）。
        meta.alphaMode = "packed";
        meta.packedLayout = "topBottom";
        meta.contentHeight = result.packedLayout.contentHeight;
        meta.gutterPx = result.packedLayout.gutterPx;
      } else {
        meta.alphaMode = "unified";
      }

      const asset: AssetEntry = {
        id: newAssetId,
        path: assetPath,
        kind: "video",
        meta,
      };

      const before = useEditorStore.getState().project!;
      const after = applySubjectExtractToProject(before, {
        compId: comp.id,
        sourceLayer: videoLayer,
        asset,
        layerId: newLayerId,
        layerName: subjectExtractLayerName(videoLayer.name, target),
        assetsBinId: newBinId(),
        extractBinId: newBinId(),
        target,
      });

      applyCommand({ label: "Subject Extract", before, after });
      selectObjects([newLayerId]);
      const modeLabel =
        result.mode === "split"
          ? "split alpha WebM"
          : result.mode === "packed"
            ? `packed alpha ${result.packedContainer === "mp4" ? "mp4(H.264)" : "webm(VP9)"}`
            : "WebM alpha";
      setStatus(`完了 — ${result.frameCount}f · ${result.width}×${result.height}（抽出解像度）· ${modeLabel}`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStatus("キャンセルしました");
      } else {
        setStatus(`失敗 — ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [project, comp, assetId, videoLayer, getFs, target, sampleInterval, applyCommand, selectObjects]);

  return (
    <VideoInspectorFoldout
      label="Subject Extract"
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
        映像から人物を切り抜き、透過 WebM を新レイヤーとしてソースの直上に追加します。
      </div>

      {!assetId ? (
        <div style={{ fontSize: 10, color: "#a86", marginBottom: 6 }}>
          ソース動画が未設定です。Video の Source にフッテージを割り当ててください。
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <label style={videoInspectorFieldLabelStyle}>
            対象
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value as SubjectExtractTarget)}
              style={selectStyle}
              disabled={running}
            >
              {SUBJECT_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </label>

          <div style={scrubRowStyle}>
            <span style={{ flex: 1 }}>サンプリング間隔（フレーム）</span>
            {scrubWrap(
              <ScrubNumber
                value={sampleInterval}
                onCommit={(v) => setSampleInterval(Math.max(1, Math.floor(v)))}
                min={1}
                decimals={0}
                step={1}
                speed={1}
                style={scrubInputStyle}
              />,
            )}
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
        <button
          type="button"
          onClick={() => void handleExtract()}
          disabled={running || !assetId || !comp}
          style={{ ...btnStyle, fontSize: 10 }}
          title="MediaPipe で人物マスクを推定し、透過 WebM を新 video レイヤーに追加"
        >
          Extract Subject → New Layer
        </button>
        {running && (
          <button type="button" onClick={handleCancel} style={{ ...btnStyle, fontSize: 10 }}>
            キャンセル
          </button>
        )}
      </div>

      {progress && (
        <div style={{ fontSize: 10, color: "#888", marginTop: 4 }}>
          {progress.phase} — frame {progress.current}/{progress.total}
        </div>
      )}
      {status && (
        <div
          style={{
            fontSize: 10,
            color: status.startsWith("失敗") ? "#f88" : "#8a8",
            marginTop: 4,
          }}
        >
          {status}
        </div>
      )}
    </VideoInspectorFoldout>
  );
}
