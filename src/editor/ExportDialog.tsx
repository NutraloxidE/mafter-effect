// §11.2 Export ダイアログ。ExportConfig を設定してエクスポートを開始する。

import { useCallback, useRef, useState } from "react";
import type { ExportConfig } from "../core/schema";
import { IndexedDbFs } from "../fs/IndexedDbFs";
import { diagnoseVideoSupport, exportComposition, type ExportProgress } from "../runtime/exporter";
import type { Project } from "../core/schema";

interface Props {
  project: Project;
  compId: string;
  onClose: () => void;
}

const fs = new IndexedDbFs("mafter-effect-fs");

export function ExportDialog({ project, compId, onClose }: Props) {
  const comp = project.compositions.find((c) => c.id === compId);
  const tl = comp?.kind === "timeline" ? comp : null;

  const [format, setFormat] = useState<ExportConfig["format"]>("mp4");
  const [startFrame, setStartFrame] = useState(0);
  const [endFrame, setEndFrame] = useState(tl?.duration ?? 150);
  const [fps, setFps] = useState(tl?.fps ?? 30);
  const [scale, setScale] = useState(1);
  const [alpha, setAlpha] = useState(false);
  const [textRenderMode, setTextRenderMode] = useState<"precise" | "draft">("precise");

  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // mp4/webm を選んでいるのに WebCodecs が使えない環境では、書き出すと必ず PNG-seq に
  // 落ちる。事前に理由を提示して「常に zip がダウンロードされる」混乱を防ぐ。
  const videoUnsupported = (format === "mp4" || format === "webm")
    ? diagnoseVideoSupport()
    : null;

  const isExporting = progress !== null && progress.phase !== "done" && progress.phase !== "error";

  const onExport = useCallback(async () => {
    if (!tl) return;
    setError(null);
    setFallbackNote(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const cfg: ExportConfig = {
      range: [startFrame, endFrame],
      fps,
      scale,
      format,
      alpha,
      textRenderMode,
    };

    try {
      const result = await exportComposition(project, compId, fs, cfg, setProgress, ctrl.signal);
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
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        setProgress(null);
      } else {
        setError(String(e));
        setProgress((p) => p ? { ...p, phase: "error" } : null);
      }
    } finally {
      abortRef.current = null;
    }
  }, [project, compId, tl, startFrame, endFrame, fps, scale, format, alpha, textRenderMode]);

  const onCancel = () => {
    abortRef.current?.abort();
    abortRef.current = null;
  };

  if (!tl) return null;

  const pctDone = progress
    ? Math.round((progress.frame / Math.max(1, progress.totalFrames)) * 100)
    : 0;

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <span style={{ fontWeight: "bold", fontSize: 13, color: "#ddd" }}>Export — {tl.name}</span>
          <button onClick={onClose} disabled={isExporting} style={iconBtn}>✕</button>
        </div>

        {/* Settings */}
        <div style={sectionStyle}>
          <Row label="Format">
            <select value={format} onChange={(e) => setFormat(e.target.value as ExportConfig["format"])} style={selectStyle}>
              <option value="mp4">MP4 (H.264, WebCodecs)</option>
              <option value="webm">WebM (VP9, WebCodecs)</option>
              <option value="png-seq">PNG Sequence (ZIP)</option>
            </select>
          </Row>
          <Row label="Range">
            <input type="number" value={startFrame} min={0} max={endFrame - 1}
              onChange={(e) => setStartFrame(Number(e.target.value))} style={{ ...numInput, width: 60 }} />
            <span style={{ color: "#666", margin: "0 4px" }}>–</span>
            <input type="number" value={endFrame} min={startFrame + 1} max={tl.duration}
              onChange={(e) => setEndFrame(Number(e.target.value))} style={{ ...numInput, width: 60 }} />
            <span style={{ color: "#555", fontSize: 10, marginLeft: 4 }}>frames</span>
          </Row>
          <Row label="FPS">
            <input type="number" value={fps} min={1} max={120}
              onChange={(e) => setFps(Number(e.target.value))} style={{ ...numInput, width: 60 }} />
          </Row>
          <Row label="Scale">
            <select value={scale} onChange={(e) => setScale(Number(e.target.value))} style={selectStyle}>
              <option value={0.5}>0.5× ({Math.round(tl.width * 0.5)}×{Math.round(tl.height * 0.5)})</option>
              <option value={1}>1× ({tl.width}×{tl.height})</option>
              <option value={2}>2× ({tl.width * 2}×{tl.height * 2})</option>
            </select>
          </Row>
          {(format === "webm" || format === "png-seq") && (
            <Row label="Alpha">
              <input type="checkbox" checked={alpha} onChange={(e) => setAlpha(e.target.checked)} />
              <span style={{ color: "#888", fontSize: 10, marginLeft: 4 }}>transparent bg</span>
            </Row>
          )}
          <Row label="Text">
            <select
              value={textRenderMode}
              onChange={(e) => setTextRenderMode(e.target.value as "precise" | "draft")}
              style={selectStyle}
            >
              <option value="precise">厳密 (SVG アウトライン)</option>
              <option value="draft">軽量 (DOM テキスト)</option>
            </select>
          </Row>
        </div>

        {/* WebCodecs 非対応の事前警告（mp4/webm 選択時のみ） */}
        {videoUnsupported && (
          <div style={{ fontSize: 11, color: "#fc8", marginBottom: 10, background: "#2a2415", padding: "6px 8px", borderRadius: 3, lineHeight: 1.5 }}>
            ⚠ {format.toUpperCase()} はこの環境で書き出せません（PNG 連番 ZIP になります）。<br />
            {videoUnsupported}
          </div>
        )}

        {/* Warnings */}
        <div style={{ fontSize: 10, color: "#666", marginBottom: 10, lineHeight: 1.5 }}>
          ⚠ best-effort: CSS 3D preserve-3d / cross-origin images may differ from preview.<br />
          §26: 厳密モードは asset フォント取り込みで最も正確。system フォントは SVG text 近似。<br />
          Video requires Chrome 94+ (WebCodecs). Older browsers fall back to PNG sequence.
        </div>

        {/* Progress */}
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
          <div style={{ fontSize: 11, color: "#f66", marginBottom: 8, background: "#2a1a1a", padding: "4px 6px", borderRadius: 3 }}>
            Error: {error}
          </div>
        )}

        {fallbackNote && !error && (
          <div style={{ fontSize: 11, color: "#fc8", marginBottom: 8, background: "#2a2415", padding: "6px 8px", borderRadius: 3, whiteSpace: "pre-wrap", lineHeight: 1.5 }}>
            ⚠ {fallbackNote}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
          {isExporting
            ? <button onClick={onCancel} style={cancelBtn}>Cancel</button>
            : <>
                <button onClick={onClose} style={secondaryBtn}>Close</button>
                <button onClick={() => void onExport()} style={primaryBtn}>Export</button>
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

// ── Styles ──────────────────────────────────────────────────────────────────

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 9999,
};

const dialogStyle: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 16, width: 380, maxWidth: "90vw", color: "#ccc", fontSize: 12,
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
