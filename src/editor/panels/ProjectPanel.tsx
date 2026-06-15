import { useEditorStore } from "../store";
import { currentTimelineComp } from "../store";
import { IndexedDbFs } from "../../fs/IndexedDbFs";
import { exportZip, importZip } from "../../fs/zip";
import { useRef } from "react";

const fs = new IndexedDbFs("mafter-effect-fs");

export function ProjectPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const addSolid = useEditorStore((s) => s.addSolid);
  const addText = useEditorStore((s) => s.addText);
  const removeObject = useEditorStore((s) => s.removeObject);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const newProject = useEditorStore((s) => s.newProject);
  const loadFromFs = useEditorStore((s) => s.loadFromFs);
  const saveToFs = useEditorStore((s) => s.saveToFs);
  const fileInput = useRef<HTMLInputElement>(null);

  const comp = currentTimelineComp(project, compId);

  const onExportZip = async () => {
    const bytes = await exportZip(fs);
    const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "mafter-project.zip"; a.click();
    URL.revokeObjectURL(url);
  };

  const onImportZip = async (file: File) => {
    const buf = await file.arrayBuffer();
    await importZip(fs, buf);
    await loadFromFs();
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12 }}>
      {/* header */}
      <div style={{ padding: "6px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <div style={{ fontWeight: "bold", color: "#ddd", marginBottom: 4 }}>
          {project?.meta.name ?? "No project"}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button onClick={newProject} style={btnStyle}>New</button>
          <button onClick={() => void saveToFs()} style={btnStyle}>Save</button>
          <button onClick={() => void loadFromFs()} style={btnStyle}>Reload</button>
          <button onClick={() => void onExportZip()} style={btnStyle}>⬇ zip</button>
          <button onClick={() => fileInput.current?.click()} style={btnStyle}>⬆ zip</button>
          <input ref={fileInput} type="file" accept=".zip" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportZip(f); e.target.value = ""; }} />
        </div>
      </div>

      {/* add object */}
      <div style={{ padding: "4px 8px", background: "#1e1e1e", borderBottom: "1px solid #2a2a2a", flexShrink: 0, display: "flex", gap: 4 }}>
        <button onClick={() => { const id = addSolid(); if (id) selectObjects([id]); }} style={btnStyle}>+ Solid</button>
        <button onClick={() => { const id = addText(); if (id) selectObjects([id]); }} style={btnStyle}>+ Text</button>
      </div>

      {/* object list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!comp && <div style={{ padding: 12, color: "#444" }}>No composition</div>}
        {comp?.objects.map((obj) => {
          const isSelected = selectedIds.includes(obj.id);
          return (
            <div
              key={obj.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 4,
                padding: "4px 8px",
                background: isSelected ? "#2a3a4a" : "transparent",
                cursor: "pointer",
                borderBottom: "1px solid #1a1a1a",
              }}
              onClick={() => selectObjects(isSelected ? [] : [obj.id])}
            >
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: isSelected ? "#7fb8f0" : "#bbb" }}>
                {obj.name}
              </span>
              <span style={{ color: "#555", fontSize: 10 }}>{obj.components[0]?.type ?? ""}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }}
                style={{ ...btnStyle, padding: "1px 5px", color: "#f44", border: "none" }}
              >×</button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "2px 7px",
  cursor: "pointer",
  fontSize: 11,
};
