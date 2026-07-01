// フィードバックループ: 催促トースト + 送信モーダル（doc/feedback-loop.md §Phase2d）。
// §5 / INV への影響なし（エディタ外の運用データ、project.json 非汚染）。

import { useEffect, useState } from "react";
import { feedbackCollector, submitFeedback } from "./feedbackCollector";

/** App.tsx にグローバルマウントする催促トースト。しきい値到達を feedbackCollector から購読する。 */
export function FeedbackPrompt() {
  const [visible, setVisible] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    const check = () => {
      if (!showModal && feedbackCollector.shouldPrompt()) setVisible(true);
    };
    check();
    const unsub = feedbackCollector.subscribe(check);
    // スコアは減衰のみで新規発火しないが、クールダウン解除は時間経過でしか分からないためポーリングも併用。
    const interval = window.setInterval(check, 5_000);
    return () => {
      unsub();
      window.clearInterval(interval);
    };
  }, [showModal]);

  if (!visible) return null;

  const dismiss = () => {
    feedbackCollector.markPrompted();
    setVisible(false);
    setShowModal(false);
  };

  return (
    <>
      {!showModal && (
        <div style={toastStyle}>
          <div style={{ marginBottom: 8 }}>作業が滞りそうです。フィードバックを送りますか？</div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={() => setShowModal(true)} style={toastPrimaryBtn}>送る</button>
            <button onClick={dismiss} style={toastBtn}>あとで</button>
            <button onClick={() => { feedbackCollector.setOptedOut(true); dismiss(); }} style={toastBtn}>
              オフにする
            </button>
          </div>
        </div>
      )}
      {showModal && <FeedbackSendModal onClose={dismiss} />}
    </>
  );
}

/** 催促トースト・ProjectPanel の手動送信ボタンの双方から使う送信モーダル。 */
export function FeedbackSendModal({ onClose }: { onClose: () => void }) {
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const signals = feedbackCollector.getTriggeredSignalLabels();

  const onSend = async () => {
    setSending(true);
    setError(null);
    const ok = await submitFeedback(message.trim() || undefined);
    setSending(false);
    if (ok) {
      setSent(true);
      window.setTimeout(onClose, 1200);
    } else {
      setError("送信に失敗しました。ネットワーク回復後に自動で再試行します。");
    }
  };

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={{ fontWeight: "bold", fontSize: 13, color: "#ddd", marginBottom: 10 }}>
          フィードバックを送る
        </div>

        {signals.length > 0 && (
          <div style={{ fontSize: 10, color: "#888", marginBottom: 8 }}>
            検知内容（自動）: {signals.join(", ")}
          </div>
        )}

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value.slice(0, 4000))}
          placeholder="困っていること・要望など（任意）"
          disabled={sending || sent}
          style={textareaStyle}
        />

        <div style={{ fontSize: 10, color: "#666", margin: "8px 0" }}>
          ⚠ project.json やアセットは送信されません。送るのはシグナルとこのテキストのみです。
        </div>

        {error && (
          <div style={{ fontSize: 11, color: "#f66", marginBottom: 8 }}>{error}</div>
        )}

        {sent ? (
          <div style={{ fontSize: 12, color: "#8da" }}>送信しました。ありがとうございます！</div>
        ) : (
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <button onClick={onClose} disabled={sending} style={secondaryBtn}>キャンセル</button>
            <button onClick={() => void onSend()} disabled={sending} style={primaryBtn}>
              {sending ? "送信中…" : "送る"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const toastStyle: React.CSSProperties = {
  position: "fixed", right: 16, bottom: 16, zIndex: 10000,
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 12, width: 280, color: "#ccc", fontSize: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,.6)",
};

const toastBtn: React.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#bbb",
  borderRadius: 3, padding: "4px 10px", cursor: "pointer", fontSize: 11,
};

const toastPrimaryBtn: React.CSSProperties = {
  ...toastBtn, background: "#2a4a3a", color: "#8da", borderColor: "#4a7a5a",
};

const overlayStyle: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 10001,
};

const dialogStyle: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 16, width: 340, maxWidth: "90vw", color: "#ccc", fontSize: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,.6)",
};

const textareaStyle: React.CSSProperties = {
  width: "100%", minHeight: 80, resize: "vertical", boxSizing: "border-box",
  background: "#161616", border: "1px solid #333", color: "#ccc",
  borderRadius: 4, padding: 8, fontSize: 12, fontFamily: "inherit",
};

const baseBtn: React.CSSProperties = {
  border: "none", borderRadius: 3, padding: "4px 12px", fontSize: 11, cursor: "pointer",
};

const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#3a7a5a", color: "#dfd" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#333", color: "#aaa" };
