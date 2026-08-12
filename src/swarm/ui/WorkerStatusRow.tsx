import type { WorkerSnapshot } from "../core/types";

export function WorkerStatusRow({ worker }: { worker: WorkerSnapshot }) {
  const ready = worker.state === "ready";
  const dot = ready ? "●" : worker.state === "reconnecting" ? "◌" : "○";
  const color = ready ? "#6fd18b" : worker.state === "reconnecting" ? "#e8c66c" : "#777";
  const state = ready && worker.available === false ? "Background"
    : ready ? (worker.health === "probing" ? "Probing" : worker.health === "degraded" ? "Degraded" : "Ready")
      : worker.state === "reconnecting" ? "Reconnecting…" : worker.state === "incompatible" ? "Incompatible" : worker.state === "authenticating" ? "Authenticating" : worker.state === "syncing" ? "Syncing" : "Offline";
  const transport = worker.transport === "direct" ? "Direct" : worker.transport === "relay" ? "Relay" : "…";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 11 }}>
      <span style={{ color }}>{dot}</span>
      <span style={{ flex: 1, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worker.label}</span>
      <span style={{ color: "#888" }}>{transport}</span>
      <span style={{ color: state === "Ready" ? "#9fd7aa" : "#aaa" }}>{state}</span>
    </div>
  );
}
