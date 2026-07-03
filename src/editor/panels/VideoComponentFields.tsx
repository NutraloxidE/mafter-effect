import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties } from "react";
import type { ParamDescriptor, SceneObject } from "../../core/schema";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import { sampleVec3 } from "../../runtime/interpolate";
import { ScrubNumber } from "../ScrubNumber";
import { currentTimelineComp, useEditorStore } from "../store";
import {
  applyCombinedTrackToProject,
  applyMotionTrackToProject,
  applyRotationTrackToProject,
  targetHasPositionExpression,
  targetHasRotationExpression,
} from "../motionTrack/applyMotionTrack";
import {
  finalizeMotionTrackBake,
  finalizeRotationTrackBake,
  runCombinedMotionTrack,
  runMotionTrack,
  runRotationTrack,
} from "../motionTrack/quarTracker";
import type { TrackMode } from "../motionTrack/types";

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

  const [targetId, setTargetId] = useState<string>("");
  const [trackMode, setTrackMode] = useState<TrackMode>("position");
  const [focalLength, setFocalLength] = useState(550);
  const [userScale, setUserScale] = useState(1);
  const [sampleInterval, setSampleInterval] = useState(1);
  const [status, setStatus] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<{ current: number; total: number; phase: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const rotationTargetOptions = useMemo(() => {
    if (!comp) return [];
    return comp.objects
      .filter((o) => o.enabled && (o.isNull || o.components.some((c) => c.type === "camera")))
      .map((o) => {
        if (o.isNull) {
          return { id: o.id, label: `${o.name} (Null)`, eligible: true };
        }
        const cam = o.components.find((c) => c.type === "camera");
        const isOneNode = cam?.props["cameraType"] === "one-node";
        return {
          id: o.id,
          label: isOneNode
            ? `${o.name} (Camera one-node)`
            : `${o.name} (Camera two-node)`,
          eligible: isOneNode,
        };
      });
  }, [comp]);

  const positionTargets = useMemo(() => {
    if (!comp) return [];
    return comp.objects
      .filter((o) => o.enabled && (o.isNull || o.components.some((c) => c.type === "camera")))
      .map((o) => ({
        id: o.id,
        label: `${o.name} (${o.isNull ? "Null" : "Camera"})`,
        eligible: true,
      }));
  }, [comp]);

  const usesRotationTargets = trackMode === "rotation" || trackMode === "both";

  const activeTargets = usesRotationTargets
    ? rotationTargetOptions.filter((t) => t.eligible)
    : positionTargets;

  const rotationOnlyTwoNode =
    usesRotationTargets &&
    activeTargets.length === 0 &&
    rotationTargetOptions.some((t) => !t.eligible && !t.label.includes("Null"));

  useEffect(() => {
    if (!targetId && activeTargets[0]) setTargetId(activeTargets[0].id);
    else if (targetId && !activeTargets.some((t) => t.id === targetId) && activeTargets[0]) {
      setTargetId(activeTargets[0].id);
    }
  }, [activeTargets, targetId]);

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

  const scrubInputStyle: CSSProperties = {
    background: "#2a2a2a",
    border: "1px solid #444",
    color: "#ddd",
    borderRadius: 3,
    padding: "2px 4px",
    fontSize: 11,
  };

  const scrubRowStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontSize: 10,
    color: "#aaa",
  };

  const scrubWrap = (node: React.ReactNode) => (
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

  const handleTrack = useCallback(async () => {
    if (!project || !comp || !assetId || !targetId) return;
    const target = comp.objects.find((o) => o.id === targetId);
    if (!target) {
      setStatus("適用先が見つかりません");
      return;
    }
    let clearPositionExpression = false;
    let clearRotationExpression = false;
    const hasPosExpr = targetHasPositionExpression(target);
    const hasRotExpr = targetHasRotationExpression(target);

    if (trackMode === "position" && hasPosExpr) {
      const ok = window.confirm(
        "適用先の Position に expression があります。クリアしてキーフレームで上書きしますか？",
      );
      if (!ok) return;
      clearPositionExpression = true;
    } else if (trackMode === "rotation" && hasRotExpr) {
      const ok = window.confirm(
        "適用先の Rotation に expression があります。クリアしてキーフレームで上書きしますか？",
      );
      if (!ok) return;
      clearRotationExpression = true;
    } else if (trackMode === "both" && (hasPosExpr || hasRotExpr)) {
      const props = [hasPosExpr ? "Position" : null, hasRotExpr ? "Rotation" : null]
        .filter(Boolean)
        .join(" / ");
      const ok = window.confirm(
        `適用先の ${props} に expression があります。クリアしてキーフレームで上書きしますか？`,
      );
      if (!ok) return;
      clearPositionExpression = hasPosExpr;
      clearRotationExpression = hasRotExpr;
    }

    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setStatus(
      trackMode === "rotation"
        ? "回転トラッカーを読み込み中…"
        : trackMode === "both"
          ? "トラッカーを読み込み中…（並進 + 回転）"
          : "トラッカーを読み込み中…",
    );
    setProgress(null);

    try {
      if (trackMode === "position") {
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
          clearExpression: clearPositionExpression,
        });

        applyCommand({ label: "Motion Track Bake", before, after });
        setStatus(`完了 — ${result.compFrames.length} フレームをベイクしました（並進のみ）`);
      } else if (trackMode === "rotation") {
        const result = await runRotationTrack({
          project,
          comp,
          videoLayer: obj,
          assetId,
          fs: getFs(),
          options: { userScale, sampleInterval, focalLength },
          signal: ac.signal,
          onProgress: (p) => {
            const label =
              p.phase === "loading"
                ? "OpenCV トラッカーを読み込み中…"
                : p.phase === "extracting"
                  ? "フレーム抽出"
                  : "回転トラッキング";
            setStatus(label);
            setProgress({ current: p.current, total: p.total, phase: p.phase });
          },
        });

        const baseline = sampleVec3(target.transform.rotation, 0);
        const rotationsByFrame = finalizeRotationTrackBake(
          result.compFrames,
          result.track.smoothed,
          result.validMask,
          baseline,
        );

        const { before, after } = applyRotationTrackToProject(project, comp.id, targetId, {
          baselineRotation: baseline,
          rotationsByFrame,
          bakeStart: result.bakeStart,
          bakeEnd: result.bakeEnd,
          clearExpression: clearRotationExpression,
        });

        applyCommand({ label: "Motion Track Rotation Bake", before, after });
        setStatus(`完了 — ${result.compFrames.length} フレームをベイクしました（回転のみ）`);
      } else {
        const result = await runCombinedMotionTrack({
          project,
          comp,
          videoLayer: obj,
          assetId,
          fs: getFs(),
          options: { userScale, sampleInterval, focalLength },
          signal: ac.signal,
          onProgress: (p) => {
            const label =
              p.phase === "loading"
                ? "トラッカーを読み込み中…（並進 + 回転）"
                : p.phase === "extracting"
                  ? "フレーム抽出"
                  : "トラッキング（並進 + 回転）";
            setStatus(label);
            setProgress({ current: p.current, total: p.total, phase: p.phase });
          },
        });

        const posBaseline = sampleVec3(target.transform.position, 0);
        const rotBaseline = sampleVec3(target.transform.rotation, 0);
        const positionsByFrame = finalizeMotionTrackBake(
          result.position.compFrames,
          result.position.track.smoothed,
          result.position.validMask,
          posBaseline,
          userScale,
        );
        const rotationsByFrame = finalizeRotationTrackBake(
          result.rotation.compFrames,
          result.rotation.track.smoothed,
          result.rotation.validMask,
          rotBaseline,
        );

        const { before, after } = applyCombinedTrackToProject(
          project,
          comp.id,
          targetId,
          {
            baselinePosition: posBaseline,
            positionsByFrame,
            bakeStart: result.position.bakeStart,
            bakeEnd: result.position.bakeEnd,
            clearExpression: clearPositionExpression,
          },
          {
            baselineRotation: rotBaseline,
            rotationsByFrame,
            bakeStart: result.rotation.bakeStart,
            bakeEnd: result.rotation.bakeEnd,
            clearExpression: clearRotationExpression,
          },
        );

        applyCommand({ label: "Motion Track Combined Bake", before, after });
        setStatus(
          `完了 — ${result.position.compFrames.length} フレームをベイクしました（並進 + 回転）`,
        );
      }
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
    trackMode,
    focalLength,
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
          {trackMode === "position"
            ? "並進（Position）のみ。"
            : trackMode === "rotation"
              ? "回転（Rotation）のみ。Null / one-node Camera。two-node は Phase 1b-b。"
              : "並進 + 回転を同時にベイク。Null / one-node Camera。"}
        </div>

        <label style={{ fontSize: 10, color: "#aaa", display: "block", marginBottom: 4 }}>
          モード
          <select
            value={trackMode}
            onChange={(e) => setTrackMode(e.target.value as TrackMode)}
            style={selectStyle}
            disabled={running}
          >
            <option value="position">Position（並進）</option>
            <option value="rotation">Rotation（回転）</option>
            <option value="both">Both（並進 + 回転）</option>
          </select>
        </label>

        {activeTargets.length === 0 ? (
          <div style={{ fontSize: 10, color: "#a86", marginBottom: 6 }}>
            {rotationOnlyTwoNode ? (
              <>
                Two-node Camera は Rotation モード未対応です。Inspector の Camera → Type を{" "}
                <strong>One-Node</strong> に変更するか、Null を適用先にしてください。
              </>
            ) : (
              <>適用先がありません。Camera または Null を追加してください。</>
            )}
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
                value={targetId || activeTargets[0]?.id}
                onChange={(e) => setTargetId(e.target.value)}
                style={selectStyle}
                disabled={running}
              >
                {(usesRotationTargets ? rotationTargetOptions : positionTargets).map((t) => (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={usesRotationTargets && !t.eligible}
                  >
                    {t.label}
                    {usesRotationTargets && !t.eligible ? " — 未対応" : ""}
                  </option>
                ))}
              </select>
            </label>
            {(trackMode === "position" || trackMode === "both") && (
              <div style={scrubRowStyle}>
                <span style={{ flex: 1 }}>スケール係数</span>
                {scrubWrap(
                  <ScrubNumber
                    value={userScale}
                    onCommit={(v) => setUserScale(Math.max(0.01, v))}
                    min={0.01}
                    step={0.1}
                    decimals={2}
                    style={scrubInputStyle}
                  />,
                )}
              </div>
            )}
            {(trackMode === "rotation" || trackMode === "both") && (
              <div style={scrubRowStyle}>
                <span style={{ flex: 1 }}>焦点距離（px）</span>
                {scrubWrap(
                  <ScrubNumber
                    value={focalLength}
                    onCommit={(v) => setFocalLength(Math.max(50, v))}
                    min={50}
                    step={10}
                    speed={10}
                    style={scrubInputStyle}
                  />,
                )}
              </div>
            )}
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
            onClick={handleTrack}
            disabled={running || !assetId || activeTargets.length === 0}
            style={{ ...btnStyle, fontSize: 10 }}
            title={
              trackMode === "position"
                ? "映像から並進を推定し、選択先の Position に KF ベイク"
                : trackMode === "rotation"
                  ? "映像から回転を推定し、選択先の Rotation に KF ベイク"
                  : "映像から並進と回転を推定し、Position / Rotation に KF ベイク"
            }
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
