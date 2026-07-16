import { useMemo, useState } from "react";
import { useEditorStore } from "../store";
import {
  pipelineAnalysis,
  WEBGL_CONTEXT_LIMIT,
  WEBGL_CONTEXT_WARN_AT,
  type PipelineGlLayers,
  type PipelineSegment,
} from "../pipelineAnalysis";
import type { TimelineComposition } from "../../core/schema";

const TONE_COLORS = {
  light: "#6a9e6a",
  moderate: "#b8a040",
  heavy: "#c08040",
  severe: "#c05050",
} as const;

const KIND_BADGE = {
  live: { label: "Live", bg: "#2a3a4a", color: "#8cf" },
  raster: { label: "Raster", bg: "#3a2a2a", color: "#f8a" },
} as const;

/**
 * §5.5f — WebGL context を消費する canvas 数の表示（応急的な指標）。
 *
 * Chrome の同時 WebGL context 上限は **1 ドキュメント ~16**。超えると古い context から黙って
 * 破棄され、**先に描いたレイヤーの絵が消える**（例外は飛ばない＝ユーザーには原因不明のバグに見える）。
 * `geom3d` は予算なしで per-layer 1 context を作るため、ここが上限へ効く主因。
 *
 * 表示は project データからの**静的な目安**（実 context 数ではない）。frame 依存の in/out 点や
 * alpha video の予算超過時 CPU フォールバックは見ていないため、実数と一致しないことがある。
 */
function GlBadge({ gl }: { gl: PipelineGlLayers }) {
  const over = gl.total >= WEBGL_CONTEXT_LIMIT;
  const near = gl.total >= WEBGL_CONTEXT_WARN_AT;
  const tone = over
    ? { bg: "#4a1a1a", color: "#ff9090" }
    : near
      ? { bg: "#3a2f1a", color: "#e0c070" }
      : { bg: "#1a2f3a", color: "#7fc0e0" };
  const detail = [
    `3D text ${gl.geom3d}`,
    gl.alphaVideo > 0 ? `透過動画 ${gl.alphaVideo}` : null,
  ].filter(Boolean).join(" / ");
  const title = over
    ? `WebGL canvas ${gl.total}（${detail}）— ブラウザの同時 context 上限(~${WEBGL_CONTEXT_LIMIT})に達しています。`
      + "古いレイヤーから描画が消える場合があります（3D Extrude を減らす / canvas 共有する / precomp を pre-render してください）"
    : near
      ? `WebGL canvas ${gl.total}（${detail}）— 上限(~${WEBGL_CONTEXT_LIMIT})が近づいています。`
        + "超えると古いレイヤーの描画が消える場合があります"
      : `WebGL canvas ${gl.total}（${detail}）— 上限 ~${WEBGL_CONTEXT_LIMIT}。canvas 共有したレイヤー群は 1 canvas。precomp の中身も再帰カウント（静的な目安）`;
  return (
    <span
      title={title}
      style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 2, background: tone.bg, color: tone.color }}
    >
      GL×{gl.total}
      {near && "!"}
    </span>
  );
}

export function PipelinePanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const [expanded, setExpanded] = useState(false);

  const comp = useMemo(() => {
    if (!project) return null;
    const c = project.compositions.find((x) => x.id === compId);
    return c?.kind === "timeline" ? (c as TimelineComposition) : null;
  }, [project, compId]);

  const analysis = useMemo(() => {
    if (!project || !comp) return null;
    return pipelineAnalysis(comp, project);
  }, [project, comp]);

  if (!project || !comp || !analysis) {
    return (
      <div style={{ padding: 8, fontSize: 11, color: "#666" }}>
        Pipeline — comp を選択してください
      </div>
    );
  }

  const toneColor = TONE_COLORS[analysis.summaryTone];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1a1a1a", fontSize: 11, color: "#bbb" }}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        style={{
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          padding: "6px 8px",
          border: "none",
          borderBottom: "1px solid #333",
          background: "#222",
          color: "#ddd",
          cursor: "pointer",
          textAlign: "left",
          fontSize: 11,
        }}
      >
        <span style={{ fontWeight: 600, color: "#9bc" }}>Pipeline</span>
        <span style={{ color: toneColor, fontWeight: 600 }}>{analysis.summaryLabel}</span>
        {analysis.alphaWarnings.length > 0 && (
          <span
            title="split alpha 透過レイヤー — 毎フレーム二重描画"
            style={{ fontSize: 9, fontWeight: 700, padding: "1px 4px", borderRadius: 2, background: "#3a1a2a", color: "#e08fb0" }}
          >
            α×{analysis.alphaWarnings.length}
          </span>
        )}
        {analysis.glLayers.total > 0 && <GlBadge gl={analysis.glLayers} />}
        <span style={{ marginLeft: "auto", color: "#666", fontSize: 10 }}>{expanded ? "▾" : "▸"}</span>
      </button>

      {analysis.exportRasterExtra > 0 && (
        <div style={{ flexShrink: 0, padding: "4px 8px", fontSize: 10, color: "#a8b8c8", lineHeight: 1.35, borderBottom: "1px solid #2a2a2a" }}>
          mp4/png: Live調整 {analysis.exportRasterExtra} 件が自動 raster 化されます
        </div>
      )}

      {expanded && (
        <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
          {analysis.segments.length === 0 ? (
            <div style={{ padding: "8px 10px", color: "#666" }}>raster ポイントなし（軽量）</div>
          ) : (
            analysis.segments.map((seg, i) => (
              <SegmentRow
                key={seg.objectId}
                seg={seg}
                selected={selectedIds.includes(seg.objectId)}
                cliff={analysis.cliffs.some((c) => c.atIndex === i)}
              />
            ))
          )}
          {analysis.cliffs.map((cliff, i) => (
            <div
              key={`cliff-${i}`}
              style={{
                margin: "4px 8px",
                padding: "5px 8px",
                background: "#3a2a1a",
                border: "1px solid #6a5030",
                borderRadius: 3,
                color: "#d8b070",
                fontSize: 10,
                lineHeight: 1.4,
              }}
            >
              ⚠ {cliff.message}
            </div>
          ))}
          {analysis.alphaWarnings.map((warning, i) => (
            <div
              key={`alpha-${i}`}
              style={{
                margin: "4px 8px",
                padding: "5px 8px",
                background: "#3a1a2a",
                border: "1px solid #6a3050",
                borderRadius: 3,
                color: "#d87090",
                fontSize: 10,
                lineHeight: 1.4,
              }}
            >
              ◐ {warning.objectName}: {warning.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SegmentRow({
  seg,
  selected,
  cliff,
}: {
  seg: PipelineSegment;
  selected: boolean;
  cliff: boolean;
}) {
  const badge = KIND_BADGE[seg.kind];
  const indent = seg.depth * 10;

  return (
    <div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: `3px 8px 3px ${8 + indent}px`,
          background: selected ? "#2a3540" : cliff ? "#2a2218" : seg.isDefiniteBoundary ? "#1e2428" : "transparent",
          borderLeft: seg.isDefiniteBoundary ? "2px solid #5a8fd0" : cliff ? "2px solid #8a6030" : "2px solid transparent",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            padding: "1px 4px",
            borderRadius: 2,
            background: badge.bg,
            color: badge.color,
            flexShrink: 0,
          }}
        >
          {badge.label}
        </span>
        <span style={{ color: selected ? "#7fb8f0" : "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {seg.objectName}
        </span>
        {seg.isAdjustment && (
          <span style={{ fontSize: 9, color: "#c9a227" }}>
            {seg.adjustmentMode === "raster" ? "ADJ·R" : "ADJ·L"}
          </span>
        )}
      </div>
      <div style={{ padding: `0 8px 4px ${8 + indent + 4}px`, fontSize: 9, color: "#777", lineHeight: 1.3 }}>
        {seg.reason}
      </div>
      {seg.nested && seg.nested.segments.length > 0 && (
        <div style={{ marginLeft: indent + 8, borderLeft: "1px dashed #444" }}>
          {seg.nested.segments.map((nested) => (
            <SegmentRow
              key={`${seg.objectId}-${nested.objectId}`}
              seg={{ ...nested, depth: nested.depth }}
              selected={false}
              cliff={false}
            />
          ))}
        </div>
      )}
    </div>
  );
}
