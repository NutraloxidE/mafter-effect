// §32.1/§32.2 テキスト一括置換モーダル。現在コンプの連番テキストレイヤーへ
// 入力トークンを番号順に流し込む。ライブプレビュー付き。編集は 1 undo（store 経由）。

import { useMemo, useState } from "react";
import { currentTimelineComp, useEditorStore } from "../store";
import { planBulkReplace, type OrderMode, type ReplaceMode } from "../macros/textBulkReplace";
import { textLayerPositions } from "../macros/textLayerPositions";

export function TextBulkReplaceDialog({ onClose }: { onClose: () => void }) {
  const project = useEditorStore((s) => s.project);
  const currentCompId = useEditorStore((s) => s.currentCompId);
  const currentFrame = useEditorStore((s) => s.currentFrame);
  const applyTextBulkReplace = useEditorStore((s) => s.applyTextBulkReplace);

  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ReplaceMode>("char");
  const [order, setOrder] = useState<OrderMode>("content");

  const comp = useMemo(
    () => currentTimelineComp(project, currentCompId),
    [project, currentCompId],
  );
  const objects = comp?.objects ?? [];

  const positions = useMemo(
    () => (order === "reading" && comp ? textLayerPositions(comp, currentFrame) : undefined),
    [order, comp, currentFrame],
  );

  const plan = useMemo(
    () => planBulkReplace(objects, input, mode, order, positions),
    [objects, input, mode, order, positions],
  );

  const numberedLayerCount = plan.targetCount + plan.skipped.length;
  const canApply = plan.assignments.length > 0;

  const onApply = () => {
    applyTextBulkReplace(input, mode, order);
    onClose();
  };

  return (
    <div style={overlayStyle} onMouseDown={onClose}>
      <div style={dialogStyle} onMouseDown={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: "bold", fontSize: 13, color: "#ddd", marginBottom: 4 }}>
          テキスト一括置換
        </div>
        <div style={{ fontSize: 10, color: "#888", marginBottom: 10 }}>
          {order === "content" ? (
            <>
              現在のコンポジションで、中身が <code style={codeStyle}>1</code>{" "}
              <code style={codeStyle}>2</code> <code style={codeStyle}>3</code>… の連番テキストレイヤーに、
              入力を番号順に割り当てて置換します。
            </>
          ) : (
            <>
              現在のコンポジションのテキストレイヤーを<strong>配置順（左上→行→右下）</strong>で自動採番し、
              入力を順に割り当てて置換します（中身が数字でなくても対象）。現フレームで表示中のレイヤーが対象。
            </>
          )}
        </div>

        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={mode === "char" ? "例: りんご → 1→り, 2→ん, 3→ご" : "例: the quick brown → 1→the, 2→quick, 3→brown"}
          style={textareaStyle}
        />

        <div style={{ display: "flex", gap: 14, alignItems: "center", margin: "10px 0 4px" }}>
          <span style={{ fontSize: 11, color: "#999", width: 62 }}>採番:</span>
          <label style={radioLabel}>
            <input type="radio" name="order" checked={order === "content"} onChange={() => setOrder("content")} />
            中身の数字
          </label>
          <label style={radioLabel}>
            <input type="radio" name="order" checked={order === "reading"} onChange={() => setOrder("reading")} />
            配置順（左上→右下）
          </label>
        </div>

        <div style={{ display: "flex", gap: 14, alignItems: "center", margin: "0 0 10px" }}>
          <span style={{ fontSize: 11, color: "#999", width: 62 }}>分割:</span>
          <label style={radioLabel}>
            <input type="radio" name="mode" checked={mode === "char"} onChange={() => setMode("char")} />
            文字（1 文字ずつ）
          </label>
          <label style={radioLabel}>
            <input type="radio" name="mode" checked={mode === "word"} onChange={() => setMode("word")} />
            単語（空白区切り）
          </label>
        </div>

        {/* ライブプレビュー */}
        <div style={{ fontSize: 10, color: "#777", marginBottom: 4 }}>
          プレビュー（対象レイヤー {numberedLayerCount} / トークン {plan.tokenCount}）
        </div>
        <div style={previewBoxStyle}>
          {numberedLayerCount === 0 ? (
            <div style={{ color: "#888", fontSize: 11 }}>
              {order === "content"
                ? "現在のコンポジションに連番（中身が整数）のテキストレイヤーがありません。"
                : "現在のコンポジションの現フレームに表示中のテキストレイヤーがありません。"}
            </div>
          ) : (
            <>
              {[...plan.assignments]
                .sort((a, b) => a.number - b.number)
                .map((a) => (
                  <div key={a.objectId} style={previewRow}>
                    <span style={{ color: "#7fb8f0", width: 28, display: "inline-block" }}>#{a.number}</span>
                    <span style={{ color: "#888" }}>{a.oldText}</span>
                    <span style={{ color: "#555", margin: "0 6px" }}>→</span>
                    <span style={{ color: "#dfd" }}>{a.newText}</span>
                  </div>
                ))}
              {plan.unmatchedNumbers.length > 0 && (
                <div style={noteRow}>
                  未置換（トークン不足）: 番号 {plan.unmatchedNumbers.join(", ")}
                </div>
              )}
              {plan.unusedTokens.length > 0 && (
                <div style={noteRow}>未使用トークン: {plan.unusedTokens.join(" / ")}</div>
              )}
              {plan.skipped.length > 0 && (
                <div style={noteRow}>
                  除外（keyframe/expression 付き）: {plan.skipped.length} 件
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", marginTop: 12 }}>
          <button onClick={onClose} style={secondaryBtn}>キャンセル</button>
          <button onClick={onApply} disabled={!canApply} style={canApply ? primaryBtn : disabledBtn}>
            {canApply ? `置換（${plan.assignments.length} 件）` : "置換"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 10001,
};

const dialogStyle: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 16, width: 420, maxWidth: "92vw", color: "#ccc", fontSize: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,.6)",
};

const textareaStyle: React.CSSProperties = {
  width: "100%", minHeight: 64, resize: "vertical", boxSizing: "border-box",
  background: "#161616", border: "1px solid #333", color: "#ccc",
  borderRadius: 4, padding: 8, fontSize: 12, fontFamily: "inherit",
};

const radioLabel: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#bbb", cursor: "pointer",
};

const previewBoxStyle: React.CSSProperties = {
  background: "#141414", border: "1px solid #2a2a2a", borderRadius: 4,
  padding: 8, maxHeight: 180, overflowY: "auto", fontSize: 12,
  fontFamily: "ui-monospace, monospace",
};

const previewRow: React.CSSProperties = { display: "flex", alignItems: "center", padding: "1px 0" };
const noteRow: React.CSSProperties = { color: "#c9a", fontSize: 10, marginTop: 6, fontFamily: "system-ui, sans-serif" };
const codeStyle: React.CSSProperties = { background: "#2a2a2a", borderRadius: 2, padding: "0 3px" };

const baseBtn: React.CSSProperties = {
  border: "none", borderRadius: 3, padding: "4px 12px", fontSize: 11, cursor: "pointer",
};
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#3a7a5a", color: "#dfd" };
const disabledBtn: React.CSSProperties = { ...baseBtn, background: "#2a2a2a", color: "#666", cursor: "default" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#333", color: "#aaa" };
