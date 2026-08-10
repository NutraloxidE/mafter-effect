import type { WorkerSnapshot } from "../core/types";

export function WorkerStatusRow({ worker }: { worker: WorkerSnapshot }) {
  const dot = worker.state === "connected" ? "●" : worker.state === "reconnecting" ? "◌" : "○";
  const color = worker.state === "connected" ? "#6fd18b" : worker.state === "reconnecting" ? "#e8c66c" : "#777";
  const state = worker.state === "connected" ? "Active" : worker.state === "reconnecting" ? "Reconnecting…" : worker.state === "incompatible" ? "Incompatible" : "Offline";
  const transport = worker.transport === "unknown" ? "Direct" : worker.transport === "direct" ? "Direct" : "Relay";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 0", fontSize: 11 }}>
      <span style={{ color }}>{dot}</span>
      <span style={{ flex: 1, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{worker.label}</span>
      <span style={{ color: "#888" }}>{transport}</span>
      <span style={{ color: state === "Active" ? "#9fd7aa" : "#aaa" }}>{state}</span>
    </div>
  );
}
