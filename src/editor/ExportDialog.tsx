// §11.2 Export / §11.2b Pre-render ダイアログ。ExportConfig を設定して実行する。

import { useCallback, useMemo, useRef, useState } from "react";
import type { AssetEntry, ExportConfig, ExportVideoQuality, Project } from "../core/schema";
import { newBinId, newObjectId } from "../core/ids";
import { DIR_ASSETS } from "../core/paths";
import { exportBundle } from "../runtime/bundleExporter";
import { diagnoseVideoSupport, exportComposition, type ExportProgress } from "../runtime/exporter";
import { findBakeTargets } from "../runtime/bundleBake";
import { collectBundleDependencies } from "../runtime/bundleCollect";
import { collectExportProxyJobs } from "../runtime/footagePlayback";
import {
  DEFAULT_VIDEO_BITRATE,
  presetVideoBitrate,
  resolveExportVideoEncode,
} from "../runtime/exportVideoEncode";
import { probeVideoFile } from "../runtime/videoAssetProbe";
import { applyPreRenderToProject } from "./preRender";
import { useEditorStore } from "./store";
import { feedbackCollector } from "./feedbackCollector";

export type ExportDialogMode = "download" | "prerender";

interface Props {
  project: Project;
  compId: string;
  mode?: ExportDialogMode;
  onClose: () => void;
}

export function ExportDialog({ project, compId, mode = "download", onClose }: Props) {
  const isPrerender = mode === "prerender";
  const comp = project.compositions.find((c) => c.id === compId);
  const tl = comp?.kind === "timeline" ? comp : null;
  const has3DLayers = (tl?.objects ?? []).some((o) => o.threeD === true);

  const [format, setFormat] = useState<ExportConfig["format"]>("mp4");
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(tl?.duration ?? 150);
  const [fps, setFps] = useState(tl?.fps ?? 30);
  const [scale, setScale] = useState(1);
  const [alpha, setAlpha] = useState(false);
  const [textRenderMode, setTextRenderMode] = useState<"precise" | "draft">("precise");
  const [bundleLoop, setBundleLoop] = useState(true);
  // download 既定 high / prerender 既定 max（§11.2b）
  const [videoQuality, setVideoQuality] = useState<ExportVideoQuality>(isPrerender ? "max" : "high");
  const [customBitrateKbps, setCustomBitrateKbps] = useState(Math.round(DEFAULT_VIDEO_BITRATE / 1000));
  const [encodeLatencyMode, setEncodeLatencyMode] = useState<"quality" | "realtime">("quality");

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const videoUnsupported = (format === "mp4" || format === "webm")
    ? diagnoseVideoSupport()
    : null;

  const isExporting = progress !== null && progress.phase !== "done" && progress.phase !== "error";
  const isHtmlBundle = !isPrerender && format === "html-bundle";
  const showVideoQuality = format === "mp4" || format === "webm" || isHtmlBundle;

  const bakeTargetCount = tl && isHtmlBundle
    ? findBakeTargets(
        project,
        collectBundleDependencies(project, compId).timelineCompIds,
      ).length
    : 0;

  const effectiveBitrate = useMemo(() => {
    if (videoQuality === "custom") return customBitrateKbps * 1000;
    return presetVideoBitrate(videoQuality);
  }, [videoQuality, customBitrateKbps]);

  const buildConfig = useCallback((): ExportConfig => {
    const cfg: ExportConfig = {
      range: [startFrame, endFrame],
      fps,
      scale,
      format: isPrerender && format !== "mp4" && format !== "webm" ? "mp4" : format,
      alpha: isPrerender ? false : alpha,
      textRenderMode,
      bundleLoop: format === "html-bundle" && !isPrerender ? bundleLoop : undefined,
    };
    if (cfg.format === "mp4" || cfg.format === "webm" || cfg.format === "html-bundle") {
      cfg.videoQuality = videoQuality;
      if (videoQuality === "custom") cfg.videoBitrate = customBitrateKbps * 1000;
      cfg.encodeLatencyMode = encodeLatencyMode;
    }
    return cfg;
  }, [
    startFrame, endFrame, fps, scale, format, alpha, textRenderMode, bundleLoop,
    videoQuality, customBitrateKbps, encodeLatencyMode, isPrerender,
  ]);

  const onExport = useCallback(async () => {
    if (!tl) return;
    setError(null);
    setFallbackNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const cfg = buildConfig();

    try {
      const ensureProxyTier = useEditorStore.getState().ensureProxyTier;
      const proxyJobs = collectExportProxyJobs(project);
      for (const job of proxyJobs) {
        if (ctrl.signal.aborted) return;
        setProgress({ phase: "render", frame: 0, totalFrames: 1, message: `Preparing ${job.quality} proxy…` });
        const ok = await ensureProxyTier(job.assetId, job.quality);
        if (!ok) {
          setError(`プロキシ生成に失敗しました（asset ${job.assetId} / ${job.quality}）。`);
          feedbackCollector.onExportError();
          return;
        }
      }
      const exportProject = useEditorStore.getState().project ?? project;

      if (isPrerender) {
        if (cfg.format !== "mp4" && cfg.format !== "webm") {
          setError("Pre-render は MP4 / WebM のみ対応です。");
          return;
        }
        const result = await exportComposition(exportProject, compId, useEditorStore.getState().getFs(), cfg, setProgress, ctrl.signal);
        if (result.format !== "mp4" && result.format !== "webm") {
          setError(
            "Pre-render に失敗しました（動画として書き出せませんでした）。"
            + (result.fallbackReason ? `\n理由: ${result.fallbackReason}` : ""),
          );
          feedbackCollector.onExportError();
          setProgress((p) => p ? { ...p, phase: "error" } : null);
          return;
        }

        setProgress({ phase: "pack", frame: 1, totalFrames: 1, message: "Applying Pre-render…" });
        const ext = result.format === "webm" ? "webm" : "mp4";
        const mime = result.format === "webm" ? "video/webm" : "video/mp4";
        const assetId = newObjectId();
        const layerId = newObjectId();
        const preRenderedBinId = newBinId();
        const assetPath = `${DIR_ASSETS}/${assetId}.${ext}`;
        const bytes = new Uint8Array(await result.blob.arrayBuffer());
        const fs = useEditorStore.getState().getFs();
        await fs.write(assetPath, bytes);

        const file = new File([bytes], `${assetId}.${ext}`, { type: mime });
        let meta: Record<string, unknown> = { footageKind: "native", mime };
        try {
          const probe = await probeVideoFile(file);
          meta = {
            footageKind: "native",
            width: probe.width,
            height: probe.height,
            duration: probe.duration,
            mime: probe.mime || mime,
          };
        } catch {
          /* meta optional */
        }

        const asset: AssetEntry = { id: assetId, path: assetPath, kind: "video", meta };
        const before = useEditorStore.getState().project;
        if (!before) {
          setError("プロジェクトがありません。");
          return;
        }
        const after = applyPreRenderToProject(before, {
          compId,
          asset,
          layerId,
          layerName: `Pre-render ${tl.name}`,
          range: cfg.range,
          preRenderedBinId,
        });
        useEditorStore.getState().applyCommand({ label: "Pre-render", before, after });
        useEditorStore.getState().selectObjects([layerId]);
        setProgress({ phase: "done", frame: 1, totalFrames: 1, message: "Pre-render applied" });
        return;
      }

      if (format === "html-bundle") {
        const result = await exportBundle(exportProject, compId, useEditorStore.getState().getFs(), cfg, setProgress, ctrl.signal);
        const name = `${tl.name.replace(/\s+/g, "_")}_bundle.zip`;
        triggerDownload(result.blob, name);
        return;
      }
      const result = await exportComposition(exportProject, compId, useEditorStore.getState().getFs(), cfg, setProgress, ctrl.signal);
      const ext = result.format === "png-seq" ? "zip" : result.format;
      const name = `${tl.name.replace(/\s+/g, "_")}.${ext}`;
      triggerDownload(result.blob, name);
      if (result.format !== format) {
        setProgress({
          phase: "done",
          frame: endFrame - startFrame,
          totalFrames: endFrame - startFrame,
          message: `Saved as ${ext} (requested ${format})`,
        });
        setFallbackNote(
          `${format.toUpperCase()} で書き出せず PNG 連番 (${ext}) になりました。`
          + (result.fallbackReason ? `\n理由: ${result.fallbackReason}` : ""),
        );
        feedbackCollector.onExportFallback();
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setProgress(null);
        feedbackCollector.onExportCancelled();
      } else {
        setError(String(e));
        setProgress((p) => p ? { ...p, phase: "error" } : null);
        feedbackCollector.onExportError();
      }
    } finally {
      abortRef.current = null;
    }
  }, [project, compId, tl, format, startFrame, endFrame, buildConfig, isPrerender]);

  const onCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  if (!tl) return null;

  const pctDone = progress
    ? Math.round((progress.frame / Math.max(1, progress.totalFrames)) * 100)
    : 0;

  const title = isPrerender ? `Pre-render — ${tl.name}` : `Export — ${tl.name}`;
  const primaryLabel = isPrerender ? "Pre-render" : "Export";
  const encodeHint = resolveExportVideoEncode({
    videoQuality,
    videoBitrate: videoQuality === "custom" ? customBitrateKbps * 1000 : undefined,
    encodeLatencyMode,
  });

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontWeight: "bold", fontSize: 13, color: "#ddd" }}>{title}</span>
          <button onClick={onClose} disabled={isExporting} style={iconBtn}>✕</button>
        </div>

        <div style={sectionStyle}>
          <Row label="Format">
            <select
              value={format}
              onChange={(e) => setFormat(e.target.value as ExportConfig["format"])}
              style={selectStyle}
              disabled={isExporting}
            >
              <option value="mp4">MP4 (H.264, WebCodecs)</option>
              <option value="webm">WebM (VP9, WebCodecs)</option>
              {!isPrerender && <option value="png-seq">PNG Sequence (ZIP)</option>}
              {!isPrerender && <option value="html-bundle">Static HTML (ZIP)</option>}
            </select>
          </Row>
          <Row label="Range">
            <input type="number" value={startFrame} min={0} max={endFrame - 1}
              onChange={(e) => setStartFrame(Number(e.target.value))} style={{ ...numInput, width: 60 }}
              disabled={isExporting} />
            <span style={{ color: "#666", margin: "0 4px" }}>–</span>
            <input type="number" value={endFrame} min={startFrame + 1} max={tl.duration}
              onChange={(e) => setEndFrame(Number(e.target.value))} style={{ ...numInput, width: 60 }}
              disabled={isExporting} />
            <span style={{ color: "#555", fontSize: 10, marginLeft: 4 }}>frames</span>
          </Row>
          <Row label="FPS">
            <input type="number" value={fps} min={1} max={120}
              onChange={(e) => setFps(Number(e.target.value))} style={{ ...numInput, width: 60 }}
              disabled={isExporting} />
          </Row>
          <Row label="Scale">
            <select value={scale} onChange={(e) => setScale(Number(e.target.value))} style={selectStyle} disabled={isExporting}>
              <option value={0.5}>0.5× ({Math.round(tl.width * 0.5)}×{Math.round(tl.height * 0.5)})</option>
              <option value={1}>1× ({tl.width}×{tl.height})</option>
              <option value={2}>2× ({tl.width * 2}×{tl.height * 2})</option>
            </select>
          </Row>
          {(format === "webm" || format === "png-seq") && !isHtmlBundle && !isPrerender && (
            <Row label="Alpha">
              <input type="checkbox" checked={alpha} onChange={(e) => setAlpha(e.target.checked)} disabled={isExporting} />
              <span style={{ color: "#888", fontSize: 10, marginLeft: 4 }}>transparent bg</span>
            </Row>
          )}
          {isHtmlBundle && (
            <Row label="Playback">
              <select
                value={bundleLoop ? "loop" : "once"}
                onChange={(e) => setBundleLoop(e.target.value === "loop")}
                style={selectStyle}
                disabled={isExporting}
              >
                <option value="loop">ループ</option>
                <option value="once">1回のみ</option>
              </select>
            </Row>
          )}
          {showVideoQuality && (
            <>
              <Row label="Quality">
                <select
                  value={videoQuality}
                  onChange={(e) => setVideoQuality(e.target.value as ExportVideoQuality)}
                  style={selectStyle}
                  disabled={isExporting}
                >
                  <option value="low">Low (1 Mbps)</option>
                  <option value="medium">Medium (4 Mbps)</option>
                  <option value="high">High (8 Mbps)</option>
                  <option value="max">Max (20 Mbps)</option>
                  <option value="custom">Custom…</option>
                </select>
              </Row>
              <Row label="Bitrate">
                {videoQuality === "custom" ? (
                  <>
                    <input
                      type="number"
                      value={customBitrateKbps}
                      min={Math.round(50_000 / 1000)}
                      max={Math.round(50_000_000 / 1000)}
                      onChange={(e) => setCustomBitrateKbps(Number(e.target.value))}
                      style={{ ...numInput, width: 80 }}
                      disabled={isExporting}
                    />
                    <span style={{ color: "#555", fontSize: 10, marginLeft: 4 }}>kbps</span>
                  </>
                ) : (
                  <span style={{ color: "#888", fontSize: 11 }}>
                    {Math.round(effectiveBitrate / 1000)} kbps
                  </span>
                )}
              </Row>
              <Row label="Encode">
                <select
                  value={encodeLatencyMode}
                  onChange={(e) => setEncodeLatencyMode(e.target.value as "quality" | "realtime")}
                  style={selectStyle}
                  disabled={isExporting}
                >
                  <option value="quality">Quality priority</option>
                  <option value="realtime">Speed priority</option>
                </select>
              </Row>
            </>
          )}
          <Row label="Text">
            <select
              value={textRenderMode}
              onChange={(e) => setTextRenderMode(e.target.value as "precise" | "draft")}
              style={selectStyle}
              disabled={isExporting}
            >
              <option value="precise">厳密 (SVG アウトライン)</option>
              <option value="draft">軽量 (DOM テキスト)</option>
            </select>
          </Row>
        </div>

        {isPrerender && (
          <div style={{ fontSize: 10, color: "#8cf", marginBottom: 10, background: "#15202a", padding: "6px 8px", borderRadius: 3, lineHeight: 1.5 }}>
            書き出し後、ロックされていないレイヤーを非表示にし、最上段に動画レイヤーを置きます（1 undo）。
            ロック済みレイヤーは残ります。ダウンロードはしません。
          </div>
        )}

        {videoUnsupported && (
          <div style={{ fontSize: 11, color: "#fc8", marginBottom: 10, background: "#2a2415", padding: "6px 8px", borderRadius: 3, lineHeight: 1.5 }}>
            ⚠ {format.toUpperCase()} はこの環境で書き出せません{isPrerender ? "（Pre-render 不可）" : "（PNG 連番 ZIP になります）"}。<br />
            {videoUnsupported}
          </div>
        )}

        {isHtmlBundle && bakeTargetCount > 0 && (
          <div style={{ fontSize: 11, color: "#8cf", marginBottom: 10, background: "#15202a", padding: "6px 8px", borderRadius: 3, lineHeight: 1.5 }}>
            plugin / bake レイヤ {bakeTargetCount} 件を動画に焼き込みます（時間がかかります）。
            {showVideoQuality && ` bitrate ≈ ${Math.round(encodeHint.bitrate / 1000)} kbps`}
          </div>
        )}

        {isHtmlBundle && (
          <div style={{ fontSize: 10, color: "#666", marginBottom: 10, lineHeight: 1.5 }}>
            ZIP を解凍し index.html を開くとブラウザで再生されます（§11.7 Folder bundle）。
          </div>
        )}

        {has3DLayers && (
          <div style={{ fontSize: 11, color: "#fc8", marginBottom: 10, background: "#2a2415", padding: "6px 8px", borderRadius: 3, lineHeight: 1.5 }}>
            ⚠ 3D レイヤーを含みます（§5.4b）。Phase1 ではプレビューは正しく 3D 表示されますが、書き出しは foreignObject 制約で平面化される場合があります。正準な 3D 書き出し（GL readPixels）は Phase 2 で対応します。
          </div>
        )}
        <div style={{ fontSize: 10, color: "#666", marginBottom: 10, lineHeight: 1.5 }}>
          ⚠ best-effort: CSS 3D preserve-3d / cross-origin images may differ from preview.<br />
          §26: 厳密モードは asset フォント取り込みで最も正確。system フォントは SVG text 近似。<br />
          Video requires Chrome 94+ (WebCodecs). Older browsers fall back to PNG sequence.
        </div>

        {progress && (
          <div style={{ marginBottom: 10 }}>
            <div style={{ fontSize: 11, color: "#aaa", marginBottom: 4 }}>
              [{progress.phase.toUpperCase()}] {progress.message}
            </div>
            <div style={{ background: "#2a2a2a", borderRadius: 3, height: 6, overflow: "hidden" }}>
              <div style={{ background: progress.phase === "error" ? "#c44" : "#4a8", height: "100%", width: `${pctDone}%`, transition: "width .15s" }} />
            </div>
          </div>
        )}

        {error && (
          <div style={{ fontSize: 11, color: "#f66", marginBottom: 8, background: "#2a1a1a", padding: "4px 6px", borderRadius: 3, whiteSpace: "pre-wrap" }}>
            Error: {error}
          </div>
        )}

        {fallbackNote && !error && (
          <div style={{ fontSize: 11, color: "#fc8", marginBottom: 8, background: "#2a2415", padding: "6px 8px", borderRadius: 3, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            ⚠ {fallbackNote}
          </div>
        )}

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {isExporting
            ? <button onClick={onCancel} style={cancelBtn}>Cancel</button>
            : <>
                <button onClick={onClose} style={secondaryBtn}>Close</button>
                <button
                  onClick={() => void onExport()}
                  style={primaryBtn}
                  disabled={!!videoUnsupported && (format === "mp4" || format === "webm") && isPrerender}
                >
                  {primaryLabel}
                </button>
              </>
          }
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
      <span style={{ width: 52, fontSize: 11, color: "#888", flexShrink: 0 }}>{label}</span>
      {children}
    </div>
  );
}

function triggerDownload(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 9999,
};

const dialogStyle: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 16, width: 400, maxWidth: "90vw", color: "#ccc", fontSize: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,.6)",
};

const sectionStyle: React.CSSProperties = {
  background: "#161616", border: "1px solid #2a2a2a", borderRadius: 4,
  padding: "8px 10px", marginBottom: 10,
};

const selectStyle: React.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ccc",
  borderRadius: 3, padding: "2px 6px", fontSize: 11,
};

const numInput: React.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#ccc",
  borderRadius: 3, padding: "2px 6px", fontSize: 11,
};

const baseBtn: React.CSSProperties = {
  border: "none", borderRadius: 3, padding: "4px 12px", fontSize: 11, cursor: "pointer",
};

const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#3a7a5a", color: "#dfd" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#333", color: "#aaa" };
const cancelBtn: React.CSSProperties = { ...baseBtn, background: "#5a2a2a", color: "#faa" };
const iconBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#666", padding: "2px 6px" };
