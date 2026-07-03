import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import type { ParamDescriptor, SceneObject } from "../../core/schema";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { sampleVec3 } from "../../runtime/interpolate";
import { currentTimelineComp, useEditorStore } from "../store";
import {
  applyMotionTrackToProject,
  targetHasPositionExpression,
} from "../motionTrack/applyMotionTrack";
import { finalizeMotionTrackBake, runMotionTrack } from "../motionTrack/quarTracker";

// InspectorPanel の ComponentFields を再利用するための props 型。
type ComponentFieldsProps = {
  obj: SceneObject;
  compIdx: number;
  params: ParamDescriptor[];
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus?: () => void;
  onEditBlur?: () => void;
};

export function VideoComponentFields({
  obj,
  compIdx,
  frame,
  updateObject,
  previewPatch,
  onEditFocus,
  onEditBlur,
  componentFields: ComponentFieldsImpl,
}: {
  obj: SceneObject;
  compIdx: number;
  frame: number;
  updateObject: (id: string, patch: Partial<SceneObject>, label?: string) => void;
  previewPatch: (patch: Partial<SceneObject>) => void;
  onEditFocus?: () => void;
  onEditBlur?: () => void;
  componentFields: ComponentType<ComponentFieldsProps>;
}) {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const applyCommand = useEditorStore((s) => s.applyCommand);
  const getFs = useEditorStore((s) => s.getFs);
  const addCamera = useEditorStore((s) => s.addCamera);
  const addNullLayer = useEditorStore((s) => s.addNullLayer);

  const comp = currentTimelineComp(project, compId);
  const def = globalPluginRegistry.getComponentDef("video");
  const params = def?.params ?? [];

  const videoComp = obj.components[compIdx];
  const assetId = typeof videoComp?.props["asset"] === "string" ? videoComp.props["asset"] : null;

  const applyTargets = useMemo(() => {
    if (!comp) return [];
    return comp.objects
      .filter((o) => o.enabled && (o.isNull || o.components.some((c) => c.type === "camera")))
      .map((o) => ({
        id: o.id,
        label: `${o.name} (${o.isNull ? "Null" : "Camera"})`,
      }));
  }, [comp, obj.id]);

  const [targetId, setTargetId] = useState<string>(() => applyTargets[0]?.id ?? "");

  useEffect(() => {
    if (!targetId && applyTargets[0]) setTargetId(applyTargets[0].id);
    else if (targetId && !applyTargets.some((t) => t.id === targetId) && applyTargets[0]) {
      setTargetId(applyTargets[0].id);
    }
  }, [applyTargets, targetId]);
  const [userScale, setUserScale] = useState(1);
  const [sampleInterval, setSampleInterval] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; phase: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const btnStyle: CSSProperties = {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#bbb",
    borderRadius: 3,
    padding: "2px 5px",
    cursor: "pointer",
    fontSize: 10,
  };

  const selectStyle: CSSProperties = {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#ddd",
    borderRadius: 3,
    padding: "2px 4px",
    fontSize: 11,
    flex: 1,
  };

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
    setRunning(false);
    setProgress(null);
    setStatus("キャンセルしました");
  }, []);

  const handleTrack = useCallback(async () => {
    if (!project || !comp || !assetId || !targetId) return;
    const target = comp.objects.find((o) => o.id === targetId);
    if (!target) {
      setStatus("適用先が見つかりません");
      return;
    }
    let clearExpression = false;
    if (targetHasPositionExpression(target)) {
      const ok = window.confirm(
        "適用先の Position に expression があります。クリアしてキーフレームで上書きしますか？",
      );
      if (!ok) return;
      clearExpression = true;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setStatus("トラッカーを読み込み中…");
    setProgress(null);

    try {
      const result = await runMotionTrack({
        project,
        comp,
        videoLayer: obj,
        assetId,
        fs: getFs(),
        options: { userScale, sampleInterval },
        signal: ac.signal,
        onProgress: (p) => {
          const label =
            p.phase === "loading"
              ? "トラッカーを読み込み中…"
              : p.phase === "extracting"
                ? "フレーム抽出"
                : "トラッキング";
          setStatus(label);
          setProgress({ current: p.current, total: p.total, phase: p.phase });
        },
      });

      const baseline = sampleVec3(target.transform.position, 0);
      const positionsByFrame = finalizeMotionTrackBake(
        result.compFrames,
        result.track.smoothed,
        result.validMask,
        baseline,
        userScale,
      );

      const { before, after } = applyMotionTrackToProject(project, comp.id, targetId, {
        baselinePosition: baseline,
        positionsByFrame,
        bakeStart: result.bakeStart,
        bakeEnd: result.bakeEnd,
        clearExpression,
      });

      applyCommand({ label: "Motion Track Bake", before, after });
      setStatus(`完了 — ${result.compFrames.length} フレームをベイクしました（並進のみ）`);
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setStatus("キャンセルしました");
      } else {
        setStatus(`失敗: ${e instanceof Error ? e.message : String(e)}`);
      }
    } finally {
      setRunning(false);
      setProgress(null);
      abortRef.current = null;
    }
  }, [
    project,
    comp,
    assetId,
    targetId,
    obj,
    getFs,
    userScale,
    sampleInterval,
    applyCommand,
  ]);

  return (
    <>
      <ComponentFieldsImpl
        obj={obj}
        compIdx={compIdx}
        params={params}
        frame={frame}
        updateObject={updateObject}
        previewPatch={previewPatch}
        onEditFocus={onEditFocus}
        onEditBlur={onEditBlur}
      />

      <div style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid #333" }}>
        <div style={{ fontSize: 11, color: "#8cf", marginBottom: 6 }}>Motion Track</div>
        <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
          並進のみ（Position）。回転・POI・zoom は対象外。
        </div>

        {applyTargets.length === 0 ? (
          <div style={{ fontSize: 10, color: "#a86", marginBottom: 6 }}>
            適用先がありません。Camera または Null を追加してください。
            <div style={{ display: "flex", gap: 4, marginTop: 4 }}>
              <button type="button" style={btnStyle} onClick={() => addCamera()}>
                Add Camera
              </button>
              <button type="button" style={btnStyle} onClick={() => addNullLayer()}>
                Add Null
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <label style={{ fontSize: 10, color: "#aaa" }}>
              適用先
              <select
                value={targetId || applyTargets[0]?.id}
                onChange={(e) => setTargetId(e.target.value)}
                style={selectStyle}
                disabled={running}
              >
                {applyTargets.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ fontSize: 10, color: "#aaa" }}>
              スケール係数
              <input
                type="number"
                min={0.01}
                step={0.1}
                value={userScale}
                onChange={(e) => setUserScale(Math.max(0.01, Number(e.target.value) || 1))}
                style={selectStyle}
                disabled={running}
              />
            </label>
            <label style={{ fontSize: 10, color: "#aaa" }}>
              サンプリング間隔（フレーム）
              <input
                type="number"
                min={1}
                step={1}
                value={sampleInterval}
                onChange={(e) => setSampleInterval(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                style={selectStyle}
                disabled={running}
              />
            </label>
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <button
            type="button"
            onClick={handleTrack}
            disabled={running || !assetId || applyTargets.length === 0}
            style={{ ...btnStyle, fontSize: 10 }}
            title="映像から並進を推定し、選択先の Position に KF ベイク"
          >
            Track Motion → Bake Keyframes
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
          <div style={{ fontSize: 10, color: status.startsWith("失敗") ? "#f88" : "#8a8", marginTop: 4 }}>
            {status}
          </div>
        )}
      </div>
    </>
  );
}
