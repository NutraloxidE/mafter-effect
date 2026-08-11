import { useEffect, useMemo, useState } from "react";
import { createSignalingBackend } from "../signaling/SignalingService";
import { WorkerRuntime } from "../worker/WorkerRuntime";

function codeFromPath(): string {
  const match = /^\/w\/([^/]+)/i.exec(window.location.pathname);
  return match?.[1] ?? "";
}

export function WorkerJoinView() {
  const initialCode = useMemo(codeFromPath, []);
  const runtime = useMemo(() => new WorkerRuntime({
    backend: createSignalingBackend({ useInMemory: import.meta.env.VITE_SWARM_USE_IN_MEMORY === "1" }),
    label: typeof navigator !== "undefined" ? navigator.platform || "Browser worker" : "Browser worker",
  }), []);
  const [code, setCode] = useState(initialCode);
  const [snapshot, setSnapshot] = useState(runtime.getSnapshot());

  useEffect(() => {
    const unsubscribe = runtime.subscribe(() => setSnapshot(runtime.getSnapshot()));
    return () => {
      unsubscribe();
      runtime.stop();
    };
  }, [runtime]);

  const join = () => { void runtime.join(code); };

  // The /w/<code> link already carries consent to help; joining by hand adds nothing.
  useEffect(() => {
    if (initialCode.trim().length >= 4) void runtime.join(initialCode);
  }, [runtime, initialCode]);
  return (
    <main style={pageStyle}>
      <section style={cardStyle}>
        <div style={{ color: "#7fb8f0", fontSize: 13, fontWeight: 700, marginBottom: 14 }}>Mafter Render Worker</div>
        <div style={{ color: "#ddd", fontSize: 20, marginBottom: 8 }}>Use this device to help render.</div>
        <div style={{ color: "#999", fontSize: 13, lineHeight: 1.5, marginBottom: 18 }}>Keep this tab in the foreground: browsers throttle background tabs so hard that render jobs miss their deadline and the host takes the work back. Rendering may use significant CPU/GPU and battery. This device receives render jobs only; it cannot edit the host project.</div>
        <label style={{ display: "block", color: "#999", fontSize: 12, marginBottom: 5 }}>Join code</label>
        <input value={code} onChange={(event) => setCode(event.target.value.toUpperCase())} placeholder="8KD3F2" style={inputStyle} disabled={snapshot.state !== "idle" && snapshot.state !== "error"} />
        {snapshot.error && <div style={{ color: "#e9a3a3", fontSize: 12, marginTop: 8 }}>{snapshot.error}</div>}
        {snapshot.state === "idle" || snapshot.state === "error" ? <button onClick={join} disabled={code.trim().length < 4} style={primaryButtonStyle}>Join as Worker</button> : <div style={{ marginTop: 16, borderTop: "1px solid #333", paddingTop: 14 }}><div style={{ color: "#9fd7aa", fontSize: 16, marginBottom: 6 }}>Connected to Mafter</div><div style={statusStyle}>Status: {snapshot.state === "rendering" ? "Rendering" : snapshot.state === "waiting-approval" ? "Waiting for host approval" : "Ready"}</div><div style={statusStyle}>Connection: {snapshot.connection}</div>{snapshot.currentJobId && <div style={statusStyle}>Current job: {snapshot.currentJobId}</div>}<button onClick={() => runtime.stop()} style={secondaryButtonStyle}>Stop Worker</button></div>}
      </section>
    </main>
  );
}

const pageStyle: React.CSSProperties = { minHeight: "100vh", display: "grid", placeItems: "center", background: "#111", color: "#ccc", fontFamily: "system-ui, sans-serif", padding: 20 };
const cardStyle: React.CSSProperties = { width: "min(440px, 100%)", background: "#1b1b1b", border: "1px solid #383838", borderRadius: 8, padding: 24, boxShadow: "0 12px 40px rgba(0,0,0,.35)" };
const inputStyle: React.CSSProperties = { boxSizing: "border-box", width: "100%", background: "#111", color: "#eee", border: "1px solid #555", borderRadius: 4, padding: "10px 12px", fontSize: 18, letterSpacing: 2 };
const primaryButtonStyle: React.CSSProperties = { width: "100%", marginTop: 14, background: "#3978aa", color: "white", border: "none", borderRadius: 4, padding: "10px 12px", fontSize: 14, cursor: "pointer" };
const secondaryButtonStyle: React.CSSProperties = { marginTop: 14, background: "#292929", color: "#ccc", border: "1px solid #444", borderRadius: 4, padding: "8px 12px", fontSize: 12, cursor: "pointer" };
const statusStyle: React.CSSProperties = { color: "#aaa", fontSize: 12, margin: "4px 0" };
