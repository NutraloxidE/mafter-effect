import { useEffect, useRef, useState } from "react";
import { useSyncExternalStore } from "react";
import { previewCacheService } from "../../editor/previewCacheService";
import { buildPreviewSwarmJob, type RemotePreviewRequest } from "../cache/distributedPreviewCache";
import { attachJobFiles } from "../core/jobFiles";
import { useEditorStore } from "../../editor/store";
import { swarmUiStore } from "./swarmStore";
import { WorkerQr } from "./WorkerQr";
import { WorkerStatusRow } from "./WorkerStatusRow";

const subscribeSwarmUi = (listener: () => void): (() => void) => swarmUiStore.subscribe(listener);
const getSwarmUiSnapshot = (): ReturnType<typeof swarmUiStore.getSnapshot> => swarmUiStore.getSnapshot();

export function WorkerMenu() {
  const [open, setOpen] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const snapshot = useSyncExternalStore(subscribeSwarmUi, getSwarmUiSnapshot, getSwarmUiSnapshot);
  const rootRef = useRef<HTMLSpanElement>(null);

  const connectedWorkers = snapshot.workers.filter((worker) => worker.state === "connected").length;

  useEffect(() => {
    // Installing the renderer is what tells the preview cache remote capacity exists, so only do
    // it while a worker is actually connected.
    if (connectedWorkers === 0) {
      previewCacheService.setRemoteRenderer(null);
      return;
    }
    previewCacheService.setRemoteRenderer(async (request) => {
      const typed = request as RemotePreviewRequest;
      const job = buildPreviewSwarmJob(typed);
      // Ship the footage and expression scripts the comp references; without them the worker
      // would render a frame with missing content, so attachJobFiles failing keeps the job local.
      const withFiles = await attachJobFiles(job, typed.comp, useEditorStore.getState().getFs());
      return swarmUiStore.renderPreviewFrame(withFiles, typed.timeoutMs);
    }, connectedWorkers);
    return () => previewCacheService.setRemoteRenderer(null);
  }, [connectedWorkers]);

  useEffect(() => {
    if (open) void swarmUiStore.start();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const copy = async (value: string | null) => {
    if (!value) return;
    await navigator.clipboard?.writeText(value);
  };
  const label = snapshot.status === "active" && snapshot.workers.length > 0 ? `Workers ${snapshot.workers.filter((w) => w.state === "connected").length}` : "Workers +";

  return (
    <span ref={rootRef} style={{ position: "relative", ...( { WebkitAppRegion: "no-drag" } as React.CSSProperties) }}>
      <button onClick={() => setOpen((value) => !value)} style={triggerStyle(open)}>{label} ▾</button>
      {open && (
        <>
          <div style={backdropStyle} onClick={() => setOpen(false)} />
          <div style={menuStyle} role="dialog" aria-label="Render Workers">
            <div style={{ fontWeight: 600, color: "#ddd", marginBottom: 5 }}>Render Workers</div>
            <div style={{ color: "#999", fontSize: 11, lineHeight: 1.4, marginBottom: 10 }}>Use another device to speed up preview caching and rendering.</div>
            {snapshot.status === "starting" && <div style={mutedStyle}>Creating a worker session…</div>}
            {snapshot.error && <div style={{ color: "#e9a3a3", fontSize: 11, marginBottom: 6 }}>{snapshot.error}<br />Mafter will continue rendering locally.</div>}
            {snapshot.joinUrl && (
              <>
                <button style={secondaryButtonStyle} onClick={() => setShowQr((value) => !value)}>{showQr ? "Hide QR code" : "Show QR code"}</button>
                {showQr && <div style={{ margin: "10px 0" }}><WorkerQr value={snapshot.joinUrl} /></div>}
                <label style={labelStyle}>Worker link</label>
                <div style={copyRowStyle}><span style={valueStyle}>{snapshot.joinUrl}</span><button style={copyButtonStyle} onClick={() => void copy(snapshot.joinUrl)}>Copy</button></div>
                <label style={labelStyle}>Join code</label>
                <div style={copyRowStyle}><span style={{ ...valueStyle, letterSpacing: 2 }}>{snapshot.session?.joinCode}</span><button style={copyButtonStyle} onClick={() => void copy(snapshot.session?.joinCode ?? null)}>Copy</button></div>
              </>
            )}
            {snapshot.pendingWorkers.length > 0 && <div style={{ marginTop: 10 }}><label style={labelStyle}>Waiting for approval</label>{snapshot.pendingWorkers.map((peer) => <div key={peer.peerId} style={pendingStyle}><span style={{ flex: 1 }}>{peer.label} wants to join</span><button style={allowButtonStyle} onClick={() => void swarmUiStore.approveWorker(peer.peerId, true)}>Allow</button><button style={rejectButtonStyle} onClick={() => void swarmUiStore.approveWorker(peer.peerId, false)}>Reject</button></div>)}</div>}
            {snapshot.workers.length > 0 && <div style={{ marginTop: 10 }}><label style={labelStyle}>Connected</label>{snapshot.workers.map((worker) => <WorkerStatusRow key={worker.slotId} worker={worker} />)}</div>}
            {snapshot.session && (
              <div style={computeStyle}>
                <div>Available compute: {snapshot.availableCompute.toFixed(1)}× local</div>
                {snapshot.metrics && (
                  <div style={{ color: "#8a8a8a", marginTop: 3 }}>
                    {/* Adopted, not received: an export can take back every block it sent out. */}
                    Frames used from workers: {snapshot.metrics.adoptedRemoteFrames} of {snapshot.metrics.remoteFrames} received
                    {snapshot.metrics.localFallbackJobs > 0 && ` · fell back locally: ${snapshot.metrics.localFallbackJobs}`}
                    {snapshot.metrics.ineligibleJobs > 0 && ` · kept local: ${snapshot.metrics.ineligibleJobs}`}
                  </div>
                )}
              </div>
            )}
            {snapshot.status === "active" && <button style={{ ...secondaryButtonStyle, marginTop: 10 }} onClick={() => swarmUiStore.stop()}>Stop worker session</button>}
          </div>
        </>
      )}
    </span>
  );
}

const triggerStyle = (open: boolean): React.CSSProperties => ({ background: open ? "#222" : "transparent", border: "none", color: "#bbb", cursor: "pointer", padding: "2px 8px", fontSize: 12, borderRadius: 3, WebkitAppRegion: "no-drag" } as React.CSSProperties);
const backdropStyle: React.CSSProperties = { position: "fixed", inset: 0, zIndex: 9998 };
const menuStyle: React.CSSProperties = { position: "absolute", top: "100%", left: 0, marginTop: 2, zIndex: 9999, width: 330, background: "#1e1e1e", border: "1px solid #444", borderRadius: 4, padding: 12, boxShadow: "0 8px 24px rgba(0,0,0,.6)" };
const labelStyle: React.CSSProperties = { display: "block", color: "#888", fontSize: 10, margin: "8px 0 3px" };
const mutedStyle: React.CSSProperties = { color: "#888", fontSize: 11 };
const valueStyle: React.CSSProperties = { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#bbb", fontSize: 11 };
const copyRowStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 6, border: "1px solid #333", borderRadius: 3, padding: "4px 5px" };
const copyButtonStyle: React.CSSProperties = { background: "#2a2a2a", border: "1px solid #444", borderRadius: 3, color: "#bbb", padding: "2px 6px", fontSize: 10, cursor: "pointer" };
const secondaryButtonStyle: React.CSSProperties = { background: "#292929", border: "1px solid #444", borderRadius: 3, color: "#ccc", padding: "5px 8px", fontSize: 11, cursor: "pointer" };
const pendingStyle: React.CSSProperties = { display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "5px 0" };
const allowButtonStyle: React.CSSProperties = { ...copyButtonStyle, color: "#9fd7aa" };
const rejectButtonStyle: React.CSSProperties = { ...copyButtonStyle, color: "#e9a3a3" };
const computeStyle: React.CSSProperties = { marginTop: 10, paddingTop: 8, borderTop: "1px solid #333", color: "#b8d6f0", fontSize: 11 };
