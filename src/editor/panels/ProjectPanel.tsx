import { useRef, useState } from "react";
import { ExportDialog } from "../ExportDialog";
import { currentTimelineComp, useEditorStore } from "../store";
import { IndexedDbFs } from "../../fs/IndexedDbFs";
import { exportZip, importZip } from "../../fs/zip";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";

const fs = new IndexedDbFs("mafter-effect-fs");

export function ProjectPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const selectedIds = useEditorStore((s) => s.selectedObjectIds);
  const addSolid = useEditorStore((s) => s.addSolid);
  const addText = useEditorStore((s) => s.addText);
  const addHtmlComp = useEditorStore((s) => s.addHtmlComp);
  const addHtmlInstance = useEditorStore((s) => s.addHtmlInstance);
  const importAudioAsset = useEditorStore((s) => s.importAudioAsset);
  const addAudioLayer = useEditorStore((s) => s.addAudioLayer);
  const removeObject = useEditorStore((s) => s.removeObject);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const newProject = useEditorStore((s) => s.newProject);
  const loadFromFs = useEditorStore((s) => s.loadFromFs);
  const saveToFs = useEditorStore((s) => s.saveToFs);
  const installSamplePlugin = useEditorStore((s) => s.installSamplePlugin);
  const togglePlugin = useEditorStore((s) => s.togglePlugin);
  const addPluginObject = useEditorStore((s) => s.addPluginObject);
  // pluginsVersion で subscribe し、registry が更新されたら component を再レンダーする
  const pluginsVersion = useEditorStore((s) => s.pluginsVersion);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);

  const [showExport, setShowExport] = useState(false);

  // pluginsVersion が変化したら registry から最新の component 一覧を取得
  const registeredComponents = pluginsVersion >= 0 ? globalPluginRegistry.getComponentDefs() : [];

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

  const onImportAudio = async (file: File) => {
    const assetId = await importAudioAsset(file);
    if (assetId) {
      const layerId = addAudioLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
      if (layerId) selectObjects([layerId]);
    }
  };

  // audio assets in project
  const audioAssets = project?.assets.filter((a) => a.kind === "audio") ?? [];

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
        {/* Export video button */}
        <div style={{ marginTop: 4 }}>
          <button
            onClick={() => setShowExport(true)}
            disabled={!project || !compId}
            style={{ ...btnStyle, background: "#2a4a3a", color: "#8da", borderColor: "#4a7a5a", width: "100%" }}
          >
            ▶ Export Video…
          </button>
        </div>
      </div>

      {/* add object */}
      <div style={{ padding: "4px 8px", background: "#1e1e1e", borderBottom: "1px solid #2a2a2a", flexShrink: 0, display: "flex", gap: 4, flexWrap: "wrap" }}>
        <button onClick={() => { const id = addSolid(); if (id) selectObjects([id]); }} style={btnStyle}>+ Solid</button>
        <button onClick={() => { const id = addText(); if (id) selectObjects([id]); }} style={btnStyle}>+ Text</button>
        <button onClick={() => { void addHtmlComp(); }} style={btnStyle}>+ HTML Comp</button>
        <button onClick={() => audioInput.current?.click()} style={btnStyle}>+ Audio</button>
        <input ref={audioInput} type="file" accept="audio/*" style={{ display: "none" }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportAudio(f); e.target.value = ""; }} />
      </div>

      {/* HTML comp 一覧 */}
      {project && project.compositions.some((c) => c.kind === "html") && (
        <div style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
          <div style={{ color: "#666", fontSize: 10, marginBottom: 2 }}>HTML Compositions（クリックでタイムラインへ配置）</div>
          {project.compositions.filter((c) => c.kind === "html").map((c) => (
            <div
              key={c.id}
              title="クリックして現タイムラインに配置"
              onClick={() => { const id = addHtmlInstance(c.id); if (id) selectObjects([id]); }}
              style={{ color: "#8a8", fontSize: 11, padding: "2px 4px", cursor: "pointer", borderRadius: 3 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#243024")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              ◇ {c.name} <span style={{ color: "#566" }}>＋</span>
            </div>
          ))}
        </div>
      )}

      {/* Audio assets 一覧 */}
      {audioAssets.length > 0 && (
        <div style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
          <div style={{ color: "#666", fontSize: 10, marginBottom: 2 }}>Audio Assets（クリックでレイヤー追加）</div>
          {audioAssets.map((a) => (
            <div
              key={a.id}
              title="クリックしてタイムラインに配置"
              onClick={() => { const id = addAudioLayer(a.id); if (id) selectObjects([id]); }}
              style={{ color: "#a88", fontSize: 11, padding: "2px 4px", cursor: "pointer", borderRadius: 3 }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#302424")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >
              ♪ {a.path.split("/").pop() ?? a.id} <span style={{ color: "#665" }}>＋</span>
            </div>
          ))}
        </div>
      )}

      {/* §12 Plugin セクション */}
      <div style={{ padding: "4px 8px", borderBottom: "1px solid #2a2a2a", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ color: "#666", fontSize: 10 }}>Plugins</span>
          <button
            onClick={() => { void installSamplePlugin(); }}
            disabled={!project}
            style={{ ...btnStyle, fontSize: 10, padding: "1px 5px" }}
            title="サンプル plugin (gradient-rect) を FS にインストール"
          >
            + Sample
          </button>
        </div>
        {(project?.pluginRefs ?? []).length === 0 && (
          <div style={{ color: "#444", fontSize: 10 }}>No plugins installed</div>
        )}
        {(project?.pluginRefs ?? []).map((ref) => (
          <div key={ref.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, marginBottom: 2 }}>
            <input
              type="checkbox"
              checked={ref.enabled}
              onChange={(e) => togglePlugin(ref.id, e.target.checked)}
              style={{ cursor: "pointer" }}
            />
            <span style={{ flex: 1, color: ref.enabled ? "#aaa" : "#555", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {ref.id}
            </span>
            <span style={{ color: "#555", fontSize: 10 }}>{ref.version}</span>
          </div>
        ))}
        {/* 登録済み component ごとに「+ Add」ボタンを表示 */}
        {registeredComponents.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
            {registeredComponents.map((def) => (
              <button
                key={def.type}
                onClick={() => { const id = addPluginObject(def.type); if (id) selectObjects([id]); }}
                style={{ ...btnStyle, fontSize: 10, padding: "1px 5px", color: "#cca", borderColor: "#665533" }}
                title={`Add ${def.label} component`}
              >
                + {def.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* object list */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {!comp && <div style={{ padding: 12, color: "#444" }}>No composition</div>}
        {comp?.objects.map((obj) => {
          const isSelected = selectedIds.includes(obj.id);
          const ctype = obj.components[0]?.type ?? "";
          const typeColor = ctype === "audio" ? "#a88" : ctype === "html" ? "#8a8" : "#555";
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
                {ctype === "audio" ? "♪ " : ""}{obj.name}
              </span>
              <span style={{ color: typeColor, fontSize: 10 }}>{ctype}</span>
              <button
                onClick={(e) => { e.stopPropagation(); removeObject(obj.id); }}
                style={{ ...btnStyle, padding: "1px 5px", color: "#f44", border: "none" }}
              >×</button>
            </div>
          );
        })}
      </div>

      {/* Export Dialog */}
      {showExport && project && (
        <ExportDialog
          project={project}
          compId={compId}
          onClose={() => setShowExport(false)}
        />
      )}
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
