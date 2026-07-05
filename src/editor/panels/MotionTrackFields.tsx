import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { SceneObject } from "../../core/schema";
import { sampleVec3 } from "../../runtime/interpolate";
import { ScrubNumber } from "../ScrubNumber";
import { currentTimelineComp, useEditorStore } from "../store";
import {
  applyCombinedTrackToProject,
  applyMotionTrackToProject,
  applyRotationTrackToProject,
  applySolveTrackToProject,
  targetHasPositionExpression,
  targetHasRotationExpression,
} from "../motionTrack/applyMotionTrack";
import {
  finalizeMotionTrackBake,
  finalizeRotationTrackBake,
  isMotionSuspiciouslySmall,
  runCombinedMotionTrack,
  runMotionTrack,
  runRotationTrack,
  runSolveTrack,
  runWalkTrack,
} from "../motionTrack/quarTracker";
import { defaultSolveAutoScaleTargetPx } from "../motionTrack/autoScale";
import { solvedFocalToCameraZoom } from "../motionTrack/sfm/sfmConvert";
import type { TrackMode } from "../motionTrack/types";
import {
  TRACK_ROI_PRESET_LABELS,
  TRACK_ROI_PRESETS,
  normalizeTrackRoi,
  presetToMask,
  type TrackRoi,
  type TrackRoiPresetId,
} from "../motionTrack/trackRoi";
import { resolveVideoAssetUrl } from "../motionTrack/frameExtractor";
import {
  TRACK_VALIDITY_WARN_RATIO,
  summarizeTrackValidity,
} from "../motionTrack/trackDiagnostics";
import {
  VideoInspectorFoldout,
  videoInspectorBtnStyle,
  videoInspectorScrubInputStyle,
  videoInspectorScrubRowStyle,
  videoInspectorSelectStyle,
} from "./VideoInspectorFoldout";

/**
 * Video レイヤー Inspector 内の Motion Track UI（折りたたみ）。
 * VideoComponentFields から非破壊分離。ロジック・ベイク経路は従来どおり。
 */
export function MotionTrackFields({ videoLayer }: { videoLayer: SceneObject }) {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const applyCommand = useEditorStore((s) => s.applyCommand);
  const getFs = useEditorStore((s) => s.getFs);
  const addCamera = useEditorStore((s) => s.addCamera);
  const addNullLayer = useEditorStore((s) => s.addNullLayer);

  const comp = currentTimelineComp(project, compId);
  const videoComp = videoLayer.components.find((c) => c.type === "video");
  const assetId = typeof videoComp?.props["asset"] === "string" ? videoComp.props["asset"] : null;

  const [expanded, setExpanded] = useState(false);
  const [targetId, setTargetId] = useState<string>("");
  const [trackMode, setTrackMode] = useState<TrackMode>("solve");
  const [focalLength, setFocalLength] = useState(550);
  const [solveFocal, setSolveFocal] = useState(true);
  const [applySolvedZoom, setApplySolvedZoom] = useState(true);
  const [userScale, setUserScale] = useState(1);
  const [sampleInterval, setSampleInterval] = useState(1);
  /** 既定は全体。人混み時のみ「背景優先」を手動選択（Comp 27 で道路を消す事故を防ぐ） */
  const [roiPreset, setRoiPreset] = useState<TrackRoiPresetId>("full");
  const [customRoi, setCustomRoi] = useState<TrackRoi>({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
  const [videoPreviewUrl, setVideoPreviewUrl] = useState<string | null>(null);
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

  const usesRotationTargets =
    trackMode === "rotation" ||
    trackMode === "both" ||
    trackMode === "walk" ||
    trackMode === "solve";

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

  useEffect(() => {
    if (roiPreset !== "custom" || !project || !assetId) {
      setVideoPreviewUrl(null);
      return;
    }
    let cancelled = false;
    void resolveVideoAssetUrl(project, assetId, getFs()).then((url) => {
      if (!cancelled) setVideoPreviewUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [roiPreset, project, assetId, getFs]);

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
    } else if (
      (trackMode === "both" || trackMode === "walk" || trackMode === "solve") &&
      (hasPosExpr || hasRotExpr)
    ) {
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
          : trackMode === "walk"
            ? "Walk トラッカーを読み込み中…（前進・揺れ・見回し）"
            : trackMode === "solve"
              ? "3D Solve を読み込み中…（一括カメラ解析）"
              : "トラッカーを読み込み中…",
    );
    setProgress(null);

    const mask = presetToMask(roiPreset, customRoi);

    try {
      if (trackMode === "position") {
        const result = await runMotionTrack({
          project,
          comp,
          videoLayer,
          assetId,
          fs: getFs(),
          options: { userScale, sampleInterval, mask },
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

        const posDiag = summarizeTrackValidity(result.validMask, 4);
        const baseline = sampleVec3(target.transform.position, 0);
        const baked = finalizeMotionTrackBake(
          result.compFrames,
          result.track.smoothed,
          result.validMask,
          baseline,
          userScale,
          { autoScale: true, autoScaleTargetPx: Math.max(80, comp.height * 0.15) },
        );

        const { before, after } = applyMotionTrackToProject(project, comp.id, targetId, {
          baselinePosition: baseline,
          positionsByFrame: baked.positionsByFrame,
          bakeStart: result.bakeStart,
          bakeEnd: result.bakeEnd,
          clearExpression: clearPositionExpression,
        });

        applyCommand({ label: "Motion Track Bake", before, after });
        const posPct = Math.round(posDiag.validRatio * 100);
        const warnSmall = isMotionSuspiciouslySmall(baked.range, 3);
        setStatus(
          `完了 — ${result.compFrames.length} フレーム（並進・有効 ${posPct}%・auto×${baked.autoScale.toFixed(1)}）` +
            (posDiag.validRatio < TRACK_VALIDITY_WARN_RATIO
              ? "。有効率が低いです。追跡範囲を「全体」にして再試行してください"
              : warnSmall
                ? "。変位が小さいです。スケールを上げるか Walk モードを試してください"
                : ""),
        );
      } else if (trackMode === "solve") {
        const posBaseline = sampleVec3(target.transform.position, 0);
        const rotBaseline = sampleVec3(target.transform.rotation, 0);
        const result = await runSolveTrack(
          {
            project,
            comp,
            videoLayer,
            assetId,
            fs: getFs(),
            options: {
              userScale,
              sampleInterval,
              focalLength,
              solveFocal,
              mask,
              autoScale: true,
              autoScaleTargetPx: defaultSolveAutoScaleTargetPx(comp.height),
            },
            signal: ac.signal,
            onProgress: (p) => {
              const label =
                p.phase === "loading"
                  ? "3D Solve を読み込み中…"
                  : p.phase === "extracting"
                    ? "フレーム抽出"
                    : p.phase === "tracking"
                      ? "特徴トラッキング"
                      : "カメラ解析（バンドル調整）";
              setStatus(label);
              setProgress({ current: p.current, total: p.total, phase: p.phase });
            },
          },
          { position: posBaseline, rotation: rotBaseline },
        );

        const solveDiag = summarizeTrackValidity(result.validMask, 4);
        if (solveDiag.validRatio < TRACK_VALIDITY_WARN_RATIO) {
          const pct = Math.round(solveDiag.validRatio * 100);
          const abort = window.confirm(
            `3D Solve の有効フレームが ${pct}% しかありません（残りは補間）。\nベイクを中止しますか？\n（OK = 中止 / キャンセル = それでもベイク）`,
          );
          if (abort) {
            setStatus(`中止 — 3D Solve 有効率が低いためベイクしませんでした（有効 ${pct}%）`);
            return;
          }
        }

        const targetIsCamera = target.components.some((c) => c.type === "camera");
        const zoomPx =
          targetIsCamera && applySolvedZoom && result.mode === "sfm"
            ? solvedFocalToCameraZoom(result.focalPx, result.trackHeight, comp.height)
            : undefined;

        const { before, after } = applySolveTrackToProject(
          project,
          comp.id,
          targetId,
          {
            baselinePosition: posBaseline,
            positionsByFrame: result.positionsByFrame,
            bakeStart: result.bakeStart,
            bakeEnd: result.bakeEnd,
            clearExpression: clearPositionExpression,
          },
          {
            baselineRotation: rotBaseline,
            rotationsByFrame: result.rotationsByFrame,
            bakeStart: result.bakeStart,
            bakeEnd: result.bakeEnd,
            clearExpression: clearRotationExpression,
          },
          zoomPx,
        );
        applyCommand({ label: "Motion Track 3D Solve Bake", before, after });

        if (result.mode === "rotationOnly") {
          setStatus(
            `完了 — 3D Solve ${result.compFrames.length}f（視差なし → 回転のみ推定。${result.message ?? ""}）`,
          );
        } else {
          const errStr = Number.isFinite(result.medianReprojErrPx)
            ? `・誤差 ${result.medianReprojErrPx.toFixed(2)}px`
            : "";
          const zoomStr = zoomPx ? `・zoom ${Math.round(zoomPx)}px 適用` : "";
          const effScale = result.autoScale * userScale;
          const scaleStr = `・auto×${result.autoScale.toFixed(1)}·user×${userScale.toFixed(2)}（実効×${effScale.toFixed(1)}）`;
          const half = result.halfStats;
          const halfStr = half
            ? `・点 前半${half.earlyMedianPoints}/後半${half.lateMedianPoints}`
            : "";
          setStatus(
            `完了 — 3D Solve ${result.compFrames.length}f（有効 ${Math.round(solveDiag.validRatio * 100)}%・KF ${result.keyframeCount}・点 ${result.pointCount}${halfStr}${scaleStr}${errStr}${zoomStr}）`,
          );
        }
      } else if (trackMode === "walk") {
        const posBaseline = sampleVec3(target.transform.position, 0);
        const rotBaseline = sampleVec3(target.transform.rotation, 0);
        const result = await runWalkTrack(
          {
            project,
            comp,
            videoLayer,
            assetId,
            fs: getFs(),
            options: {
              userScale,
              sampleInterval,
              focalLength,
              mask,
              autoScale: true,
              autoScaleTargetPx: Math.max(80, comp.height * 0.15),
            },
            signal: ac.signal,
            onProgress: (p) => {
              const label =
                p.phase === "loading"
                  ? "Walk トラッカーを読み込み中…"
                  : p.phase === "extracting"
                    ? "フレーム抽出"
                    : "Walk トラッキング（R+t）";
              setStatus(label);
              setProgress({ current: p.current, total: p.total, phase: p.phase });
            },
          },
          { position: posBaseline, rotation: rotBaseline },
        );

        const walkDiag = summarizeTrackValidity(result.validMask, 4);
        if (walkDiag.validRatio < TRACK_VALIDITY_WARN_RATIO) {
          const pct = Math.round(walkDiag.validRatio * 100);
          const abort = window.confirm(
            `Walk の有効フレームが ${pct}% しかありません。\nベイクを中止しますか？\n（OK = 中止 / キャンセル = それでもベイク）`,
          );
          if (abort) {
            setStatus(`中止 — Walk 有効率が低いためベイクしませんでした（有効 ${pct}%）`);
            return;
          }
        }

        const { before, after } = applyCombinedTrackToProject(
          project,
          comp.id,
          targetId,
          {
            baselinePosition: posBaseline,
            positionsByFrame: result.positionsByFrame,
            bakeStart: result.bakeStart,
            bakeEnd: result.bakeEnd,
            clearExpression: clearPositionExpression,
          },
          {
            baselineRotation: rotBaseline,
            rotationsByFrame: result.rotationsByFrame,
            bakeStart: result.bakeStart,
            bakeEnd: result.bakeEnd,
            clearExpression: clearRotationExpression,
          },
        );
        applyCommand({ label: "Motion Track Walk Bake", before, after });
        const errStr = Number.isFinite(result.lastReprojErrPx)
          ? `・err ${result.lastReprojErrPx.toFixed(1)}px`
          : "";
        const pnpStr =
          result.pnpAcceptCount > 0
            ? `・PnP ${result.pnpAcceptCount}f`
            : "・PnP unused";
        setStatus(
          `完了 — Walk ${result.compFrames.length}f（有効 ${Math.round(walkDiag.validRatio * 100)}%・auto×${result.autoScale.toFixed(1)}・range ${result.range.toFixed(1)}px・map ${result.maxMapPoints}${pnpStr}${errStr}）`,
        );
      } else if (trackMode === "rotation") {
        const result = await runRotationTrack({
          project,
          comp,
          videoLayer,
          assetId,
          fs: getFs(),
          options: { userScale, sampleInterval, focalLength, mask },
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

        const rotDiag = summarizeTrackValidity(result.validMask, 4);
        if (rotDiag.validRatio < TRACK_VALIDITY_WARN_RATIO) {
          const pct = Math.round(rotDiag.validRatio * 100);
          const bakeAnyway = window.confirm(
            `回転の有効フレームが ${pct}% しかありません（閾値 ${Math.round(TRACK_VALIDITY_WARN_RATIO * 100)}%）。\n` +
              `このままベイクすると identity（無回転）のキーフレームで上書きされます。\n\n` +
              `キャンセルしてベイクを中止しますか？\n（OK = 中止 / キャンセル = それでもベイク）`,
          );
          // confirm OK = true = user wants to cancel bake
          if (bakeAnyway) {
            setStatus(`中止 — 回転の有効率が低いためベイクしませんでした（有効 ${pct}%）`);
            return;
          }
        }

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
        setStatus(
          `完了 — ${result.compFrames.length} フレームをベイクしました（回転・有効 ${Math.round(rotDiag.validRatio * 100)}%）`,
        );
      } else {
        const result = await runCombinedMotionTrack({
          project,
          comp,
          videoLayer,
          assetId,
          fs: getFs(),
          options: { userScale, sampleInterval, focalLength, mask },
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

        const posDiag = summarizeTrackValidity(result.position.validMask, 4);
        const rotDiag = summarizeTrackValidity(result.rotation.validMask, 4);
        let bakeRotation = true;
        if (rotDiag.validRatio < TRACK_VALIDITY_WARN_RATIO) {
          const pct = Math.round(rotDiag.validRatio * 100);
          const positionOnly = window.confirm(
            `回転の有効フレームが ${pct}% しかありません。\n` +
              `identity 回転で上書きせず、並進のみベイクしますか？\n\n` +
              `（OK = 並進のみ / キャンセル = 中止）`,
          );
          if (!positionOnly) {
            setStatus(`中止 — 回転の有効率が低いためベイクしませんでした（回転有効 ${pct}%）`);
            return;
          }
          bakeRotation = false;
        }

        const posBaseline = sampleVec3(target.transform.position, 0);
        const bakedPos = finalizeMotionTrackBake(
          result.position.compFrames,
          result.position.track.smoothed,
          result.position.validMask,
          posBaseline,
          userScale,
          { autoScale: true, autoScaleTargetPx: Math.max(80, comp.height * 0.15) },
        );

        if (!bakeRotation) {
          const { before, after } = applyMotionTrackToProject(project, comp.id, targetId, {
            baselinePosition: posBaseline,
            positionsByFrame: bakedPos.positionsByFrame,
            bakeStart: result.position.bakeStart,
            bakeEnd: result.position.bakeEnd,
            clearExpression: clearPositionExpression,
          });
          applyCommand({ label: "Motion Track Bake (position only)", before, after });
          setStatus(
            `完了 — 並進のみベイク（回転は有効 ${Math.round(rotDiag.validRatio * 100)}% のためスキップ・並進有効 ${Math.round(posDiag.validRatio * 100)}%）`,
          );
        } else {
          const rotBaseline = sampleVec3(target.transform.rotation, 0);
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
              positionsByFrame: bakedPos.positionsByFrame,
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
            `完了 — ${result.position.compFrames.length} フレーム（並進有効 ${Math.round(posDiag.validRatio * 100)}% / 回転有効 ${Math.round(rotDiag.validRatio * 100)}%・auto×${bakedPos.autoScale.toFixed(1)}）`,
          );
        }
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
    videoLayer,
    getFs,
    userScale,
    sampleInterval,
    applyCommand,
    trackMode,
    focalLength,
    solveFocal,
    applySolvedZoom,
    roiPreset,
    customRoi,
  ]);

  return (
    <VideoInspectorFoldout
      label="Motion Track"
      expanded={expanded}
      onToggle={() => setExpanded((v) => !v)}
    >
      <div style={{ fontSize: 10, color: "#888", marginBottom: 6 }}>
        {trackMode === "solve"
          ? "3D Solve: 全フレームを一括解析（バンドル調整）。焦点距離も自動推定。AE の 3D Camera Tracker 相当。"
          : trackMode === "position"
            ? "並進（Position）のみ。auto-scale あり。"
            : trackMode === "rotation"
              ? "その場回転のみ（三脚パン向け）。歩き撮りには 3D Solve を使う。"
              : trackMode === "walk"
                ? "Walk: 前進・揺れ・見回し。フロー予測＋地図PnP（逐次推定・ドリフトあり）。"
                : "並進 + その場回転を独立にベイク。精度重視なら 3D Solve を推奨。"}
      </div>

        <label style={{ fontSize: 10, color: "#aaa", display: "block", marginBottom: 4 }}>
          モード
          <select
            value={trackMode}
            onChange={(e) => setTrackMode(e.target.value as TrackMode)}
            style={selectStyle}
            disabled={running}
          >
            <option value="solve">3D Solve（一括解析・推奨）</option>
            <option value="walk">Walk（前進・揺れ・見回し）</option>
            <option value="position">Position（並進）</option>
            <option value="rotation">Rotation（その場回転）</option>
            <option value="both">Both（並進 + その場回転）</option>
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
            {(trackMode === "position" ||
              trackMode === "both" ||
              trackMode === "walk" ||
              trackMode === "solve") && (
              <div style={scrubRowStyle}>
                <span style={{ flex: 1 }}>
                  スケール係数
                  {trackMode === "solve" ? "（並進・奥行き・1=強め既定）" : ""}
                </span>
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
            {(trackMode === "rotation" ||
              trackMode === "both" ||
              trackMode === "walk" ||
              trackMode === "solve") && (
              <div style={scrubRowStyle}>
                <span style={{ flex: 1 }}>
                  焦点距離（px{trackMode === "solve" && solveFocal ? "・初期値" : ""}）
                </span>
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
            {trackMode === "solve" && (
              <>
                <label style={{ ...scrubRowStyle, cursor: "pointer" }}>
                  <span style={{ flex: 1 }}>焦点距離を自動推定</span>
                  <input
                    type="checkbox"
                    checked={solveFocal}
                    onChange={(e) => setSolveFocal(e.target.checked)}
                    disabled={running}
                  />
                </label>
                <label style={{ ...scrubRowStyle, cursor: "pointer" }}>
                  <span style={{ flex: 1 }}>推定 zoom をカメラに適用</span>
                  <input
                    type="checkbox"
                    checked={applySolvedZoom}
                    onChange={(e) => setApplySolvedZoom(e.target.checked)}
                    disabled={running}
                  />
                </label>
              </>
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
            <label style={{ fontSize: 10, color: "#aaa", display: "block" }}>
              追跡範囲（ROI）
              <select
                value={roiPreset}
                onChange={(e) => {
                  const next = e.target.value as TrackRoiPresetId;
                  setRoiPreset(next);
                  if (next !== "custom" && next !== "background" && next in TRACK_ROI_PRESETS) {
                    setCustomRoi({ ...TRACK_ROI_PRESETS[next] });
                  }
                }}
                style={selectStyle}
                disabled={running}
              >
                {(Object.keys(TRACK_ROI_PRESET_LABELS) as TrackRoiPresetId[]).map((id) => (
                  <option key={id} value={id}>
                    {TRACK_ROI_PRESET_LABELS[id]}
                  </option>
                ))}
              </select>
            </label>
            <div style={{ fontSize: 9, color: "#666", marginTop: -2 }}>
              {roiPreset === "background"
                ? "手前中央の群衆帯を除外（人混み歩き撮り向け）。道路だけのシーンでは「全体」を使う"
                : roiPreset === "full"
                  ? "人が多いシーンでは「背景優先（人混み）」を選択"
                  : "人が多いときは「背景優先」が安定しやすい"}
            </div>
            {roiPreset === "custom" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <CustomRoiPreview roi={customRoi} videoUrl={videoPreviewUrl} />
                {(
                  [
                    ["X %", "x"],
                    ["Y %", "y"],
                    ["W %", "w"],
                    ["H %", "h"],
                  ] as const
                ).map(([label, key]) => (
                  <div key={key} style={scrubRowStyle}>
                    <span style={{ flex: 1 }}>{label}</span>
                    {scrubWrap(
                      <ScrubNumber
                        value={Math.round(customRoi[key] * 100)}
                        onLiveChange={(v) => {
                          const frac = Math.max(0, Math.min(100, v)) / 100;
                          setCustomRoi((prev) =>
                            normalizeTrackRoi({ ...prev, [key]: frac }),
                          );
                        }}
                        onCommit={(v) => {
                          const frac = Math.max(0, Math.min(100, v)) / 100;
                          setCustomRoi((prev) =>
                            normalizeTrackRoi({ ...prev, [key]: frac }),
                          );
                        }}
                        min={key === "w" || key === "h" ? 10 : 0}
                        max={100}
                        decimals={0}
                        step={1}
                        speed={1}
                        style={scrubInputStyle}
                      />,
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 6 }}>
          <button
            type="button"
            onClick={handleTrack}
            disabled={running || !assetId || activeTargets.length === 0}
            style={{ ...btnStyle, fontSize: 10 }}
            title={
              trackMode === "solve"
                ? "全フレーム一括の SfM + バンドル調整でカメラを解析し Position / Rotation（+ zoom）をベイク"
                : trackMode === "position"
                  ? "映像から並進を推定し、選択先の Position に KF ベイク"
                  : trackMode === "rotation"
                    ? "その場回転を推定し、選択先の Rotation に KF ベイク"
                    : trackMode === "walk"
                      ? "前進・揺れ・見回しを R+t で推定し Position / Rotation に KF ベイク"
                      : "並進とその場回転を独立に推定してベイク"
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
    </VideoInspectorFoldout>
  );
}

/** カスタム ROI の追跡範囲を緑枠で表示（映像サムネ上）。 */
function CustomRoiPreview({
  roi,
  videoUrl,
}: {
  roi: TrackRoi;
  videoUrl: string | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const n = normalizeTrackRoi(roi);

  useEffect(() => {
    const el = videoRef.current;
    if (!el || !videoUrl) return;
    el.src = videoUrl;
    el.muted = true;
    el.playsInline = true;
    const onMeta = () => {
      try {
        el.currentTime = 0;
      } catch {
        /* seek best-effort */
      }
    };
    el.addEventListener("loadedmetadata", onMeta);
    el.load();
    return () => {
      el.removeEventListener("loadedmetadata", onMeta);
      el.removeAttribute("src");
      el.load();
    };
  }, [videoUrl]);

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "16 / 9",
        background: "#1a1a1a",
        border: "1px solid #444",
        borderRadius: 3,
        overflow: "hidden",
        marginTop: 2,
      }}
      title="緑の枠が追跡範囲（カスタム ROI）"
    >
      {videoUrl ? (
        <video
          ref={videoRef}
          muted
          playsInline
          preload="metadata"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            // fill: ROI 正規化座標とプレビュー矩形を一致させる
            objectFit: "fill",
            background: "#111",
          }}
        />
      ) : (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "#555",
            fontSize: 10,
          }}
        >
          映像プレビュー
        </div>
      )}
      {/* 緑枠 + 外側を暗く（box-shadow で穴あき暗幕） */}
      <div
        aria-hidden
        style={{
          position: "absolute",
          left: `${n.x * 100}%`,
          top: `${n.y * 100}%`,
          width: `${n.w * 100}%`,
          height: `${n.h * 100}%`,
          border: "2px solid #3dffa0",
          boxShadow: "0 0 0 9999px rgba(0,0,0,0.5)",
          boxSizing: "border-box",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 4,
          bottom: 3,
          fontSize: 9,
          color: "#3dffa0",
          textShadow: "0 0 3px #000",
          pointerEvents: "none",
          zIndex: 1,
        }}
      >
        追跡範囲
      </div>
    </div>
  );
}
