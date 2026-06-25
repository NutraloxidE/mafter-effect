import { useRef, useState } from "react";
import { ExportDialog } from "../ExportDialog";
import { useEditorStore } from "../store";
import { exportZip, importZip, type ZipExportProgress } from "../../fs/zip";
import { globalPluginRegistry } from "../../runtime/pluginRegistry";
import type { CompositionMeta, Project } from "../../core/schema";

// Project パネル → Timeline パネル D&D 用 MIME 型。両ファイルで共通文字列を使う。
export const DRAG_MIME = "application/x-mafter-item";

export function ProjectPanel() {
  const project = useEditorStore((s) => s.project);
  const compId = useEditorStore((s) => s.currentCompId);
  const addHtmlComp = useEditorStore((s) => s.addHtmlComp);
  const addTimelineComp = useEditorStore((s) => s.addTimelineComp);
  const removeComposition = useEditorStore((s) => s.removeComposition);
  const renameComposition = useEditorStore((s) => s.renameComposition);
  const setCurrentComp = useEditorStore((s) => s.setCurrentComp);
  const importAudioAsset = useEditorStore((s) => s.importAudioAsset);
  const addAudioLayer = useEditorStore((s) => s.addAudioLayer);
  const importImageAsset = useEditorStore((s) => s.importImageAsset);
  const addImageLayer = useEditorStore((s) => s.addImageLayer);
  const importVideoAsset = useEditorStore((s) => s.importVideoAsset);
  const addVideoLayer = useEditorStore((s) => s.addVideoLayer);
  const removeAsset = useEditorStore((s) => s.removeAsset);
  const selectObjects = useEditorStore((s) => s.selectObjects);
  const newProject = useEditorStore((s) => s.newProject);
  const loadFromFs = useEditorStore((s) => s.loadFromFs);
  const saveToFs = useEditorStore((s) => s.saveToFs);
  const getFs = useEditorStore((s) => s.getFs);
  const installSamplePlugin = useEditorStore((s) => s.installSamplePlugin);
  const togglePlugin = useEditorStore((s) => s.togglePlugin);
  const addPluginObject = useEditorStore((s) => s.addPluginObject);
  // pluginsVersion で subscribe し、registry が更新されたら component を再レンダーする
  const pluginsVersion = useEditorStore((s) => s.pluginsVersion);
  const fileInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  const [showExport, setShowExport] = useState(false);
  const [showNewConfirm, setShowNewConfirm] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteAssetId, setDeleteAssetId] = useState<string | null>(null);
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipBusy, setZipBusy] = useState(false);
  const [zipStatus, setZipStatus] = useState<string | null>(null);

  const registeredComponents = pluginsVersion >= 0 ? globalPluginRegistry.getComponentDefs() : [];

  const formatZipProgress = (p: ZipExportProgress): string => {
    switch (p.phase) {
      case "list":
        return `ファイル一覧を取得中 (${p.total} 件)…`;
      case "read":
        return `ファイルを読み込み中 (${p.current}/${p.total})…`;
      case "pack":
        return `ZIP を圧縮中 (${p.message})…`;
    }
  };

  const onExportZip = async () => {
    if (zipBusy) return;
    setZipError(null);
    setZipBusy(true);
    setZipStatus("プロジェクトを保存中…");
    try {
      await saveToFs();
      const bytes = await exportZip(getFs(), "", (p) => {
        setZipStatus(formatZipProgress(p));
      });
      const blob = new Blob([bytes as unknown as BlobPart], { type: "application/zip" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mafter-project.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setZipError(msg);
    } finally {
      setZipBusy(false);
      setZipStatus(null);
    }
  };

  // §20.4b: 新規プロジェクト時の保存確認ダイアログの 3 ボタン挙動。
  const onNewSaveThenCreate = async () => {
    // web 版: zip ダウンロードで保存。
    // TODO(desktop): デスクトップ版では OS のファイルダイアログで保存先を指定して
    //   書き出す（File System Access API / Electron）。現状は web と同じ zip 経路に
    //   フォールバックする（§20.4b）。
    await onExportZip();
    newProject();
    setShowNewConfirm(false);
  };
  const onNewDiscardThenCreate = () => {
    newProject();
    setShowNewConfirm(false);
  };

  const onImportZip = async (file: File) => {
    const buf = await file.arrayBuffer();
    await importZip(getFs(), buf);
    await loadFromFs();
  };

  const onImportAudio = async (file: File) => {
    const assetId = await importAudioAsset(file);
    if (assetId) {
      const layerId = addAudioLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
      if (layerId) selectObjects([layerId]);
    }
  };

  const onImportImage = async (file: File) => {
    const assetId = await importImageAsset(file);
    if (assetId) {
      const layerId = addImageLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
      if (layerId) selectObjects([layerId]);
    }
  };

  const onImportVideo = async (file: File) => {
    const assetId = await importVideoAsset(file);
    if (assetId) {
      const layerId = addVideoLayer(assetId, file.name.replace(/\.[^.]+$/, ""));
      if (layerId) selectObjects([layerId]);
    }
  };

  const comps = project?.compositions ?? [];
  const timelineComps = comps.filter((c) => c.kind === "timeline");
  const htmlComps = comps.filter((c) => c.kind === "html");
  const assets = project?.assets ?? [];
  const deleteAsset = deleteAssetId ? assets.find((a) => a.id === deleteAssetId) : undefined;
  const deleteAssetRefCount = deleteAssetId && project
    ? countAssetReferences(project, deleteAssetId)
    : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: "#1c1c1c", color: "#ccc", fontSize: 12, userSelect: "none" }}>
      {/* header — project actions */}
      <div style={{ padding: "6px 8px", background: "#222", borderBottom: "1px solid #333", flexShrink: 0 }}>
        <div style={{ fontWeight: "bold", color: "#ddd", marginBottom: 4 }}>
          {project?.meta.name ?? "No project"}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          <button onClick={() => setShowNewConfirm(true)} disabled={zipBusy} style={btnStyleDisabled(zipBusy)}>New</button>
          <button onClick={() => void saveToFs()} disabled={zipBusy} style={btnStyleDisabled(zipBusy)}>Save</button>
          <button onClick={() => void loadFromFs()} disabled={zipBusy} style={btnStyleDisabled(zipBusy)}>Reload</button>
          <button onClick={() => void onExportZip()} disabled={zipBusy} style={btnStyleDisabled(zipBusy)}>
            {zipBusy ? "⬇ 準備中…" : "⬇ zip"}
          </button>
          {zipBusy && zipStatus && (
            <span style={{ color: "#c9a227", fontSize: 10, width: "100%" }}>
              {zipStatus}
            </span>
          )}
          {zipError && (
            <span style={{ color: "#f88", fontSize: 10, width: "100%" }} title={zipError}>
              zip 失敗: {zipError}
            </span>
          )}
          <button onClick={() => fileInput.current?.click()} disabled={zipBusy} style={btnStyleDisabled(zipBusy)}>⬆ zip</button>
          <input ref={fileInput} type="file" accept=".zip" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportZip(f); e.target.value = ""; }} />
        </div>
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

      {/* scrollable item tree */}
      <div style={{ flex: 1, overflow: "auto" }}>
        {/* Compositions section */}
        <SectionHeader label="Compositions">
          <button onClick={() => { const id = addTimelineComp(); if (id) selectObjects([]); }} style={miniBtn} title="新規 timeline コンポを作成">+ Comp</button>
          <button onClick={() => { void addHtmlComp(); }} style={miniBtn} title="新規 HTML コンポを作成">+ HTML</button>
        </SectionHeader>

        {timelineComps.map((c) => {
          const active = c.id === compId;
          return (
            <CompRow
              key={c.id}
              comp={c}
              active={active}
              icon="▦"
              iconColor="#7fb8f0"
              renaming={renamingId === c.id}
              title="クリックでアクティブ切替 / ドラッグで別コンプにプリコンプレイヤーとして配置"
              onClick={() => setCurrentComp(c.id)}
              onStartRename={() => setRenamingId(c.id)}
              onCommitRename={(name) => { if (name.trim()) renameComposition(c.id, name.trim()); setRenamingId(null); }}
              onCancelRename={() => setRenamingId(null)}
              onDelete={timelineComps.length > 1 ? () => removeComposition(c.id) : undefined}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "timeline-comp", id: c.id }));
                e.dataTransfer.effectAllowed = "copy";
              }}
            />
          );
        })}

        {htmlComps.map((c) => (
          <CompRow
            key={c.id}
            comp={c}
            active={false}
            icon="◇"
            iconColor="#8a8"
            renaming={renamingId === c.id}
            title="ドラッグでアクティブ comp のタイムラインに配置"
            onClick={() => { /* DnD専用: クリックでは追加しない */ }}
            onStartRename={() => setRenamingId(c.id)}
            onCommitRename={(name) => { if (name.trim()) renameComposition(c.id, name.trim()); setRenamingId(null); }}
            onCancelRename={() => setRenamingId(null)}
            onDelete={() => removeComposition(c.id)}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "html-comp", id: c.id }));
              e.dataTransfer.effectAllowed = "copy";
            }}
          />
        ))}

        {/* Footage / Assets section */}
        <SectionHeader label="Footage">
          <button onClick={() => imageInput.current?.click()} style={miniBtn} title="画像ファイルをインポート">+ Image</button>
          <button onClick={() => videoInput.current?.click()} style={miniBtn} title="動画ファイルをインポート">+ Video</button>
          <button onClick={() => audioInput.current?.click()} style={miniBtn} title="音声ファイルをインポート">+ Audio</button>
          <input ref={imageInput} type="file" accept="image/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportImage(f); e.target.value = ""; }} />
          <input ref={videoInput} type="file" accept="video/*,.mp4,.webm,.mov,.m4v" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportVideo(f); e.target.value = ""; }} />
          <input ref={audioInput} type="file" accept="audio/*" style={{ display: "none" }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void onImportAudio(f); e.target.value = ""; }} />
        </SectionHeader>
        {assets.length === 0 && <div style={{ padding: "4px 10px", color: "#444", fontSize: 10 }}>No footage</div>}
        {assets.map((a) => {
          const isFootage = a.kind === "audio" || a.kind === "image" || a.kind === "video";
          const onFootageClick = () => {
            if (a.kind === "audio") {
              const id = addAudioLayer(a.id);
              if (id) selectObjects([id]);
            } else if (a.kind === "image") {
              const id = addImageLayer(a.id);
              if (id) selectObjects([id]);
            } else if (a.kind === "video") {
              const id = addVideoLayer(a.id);
              if (id) selectObjects([id]);
            }
          };
          return (
          <div
            key={a.id}
            title={isFootage ? "クリック or ドラッグでアクティブ comp に配置" : undefined}
            onClick={() => { if (isFootage) onFootageClick(); }}
            draggable={isFootage}
            onDragStart={(e) => {
              if (a.kind === "audio") {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "audio-asset", id: a.id }));
                e.dataTransfer.effectAllowed = "copy";
              } else if (a.kind === "image") {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "image-asset", id: a.id }));
                e.dataTransfer.effectAllowed = "copy";
              } else if (a.kind === "video") {
                e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "video-asset", id: a.id }));
                e.dataTransfer.effectAllowed = "copy";
              } else {
                e.preventDefault();
              }
            }}
            style={{ display: "flex", alignItems: "center", gap: 6, padding: "3px 10px", cursor: isFootage ? "pointer" : "default" }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#262626")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <span style={{ color: a.kind === "audio" ? "#a88" : a.kind === "image" ? "#8a8" : a.kind === "video" ? "#88a" : "#888" }}>
              {a.kind === "audio" ? "♪" : a.kind === "image" ? "🖼" : a.kind === "video" ? "▶" : "▭"}
            </span>
            <span style={{ flex: 1, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {a.path.split("/").pop() ?? a.id}
            </span>
            <span style={{ color: "#555", fontSize: 10 }}>{a.kind}</span>
            {isFootage && (
              <button
                onClick={(e) => { e.stopPropagation(); setDeleteAssetId(a.id); }}
                style={{ ...miniBtn, padding: "0 4px", color: "#f44", border: "none" }}
                title="Footage を削除"
              >×</button>
            )}
          </div>
          );
        })}

        {/* Plugins section */}
        <SectionHeader label="Plugins">
          <button
            onClick={() => { void installSamplePlugin(); }}
            disabled={!project}
            style={miniBtn}
            title="サンプル plugin (gradient-rect) を FS にインストール"
          >
            + Sample
          </button>
        </SectionHeader>
        {(project?.pluginRefs ?? []).length === 0 && (
          <div style={{ padding: "4px 10px", color: "#444", fontSize: 10 }}>No plugins installed</div>
        )}
        {(project?.pluginRefs ?? []).map((ref) => (
          <div key={ref.id} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 11, padding: "2px 10px" }}>
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
        {registeredComponents.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", padding: "4px 10px" }}>
            {registeredComponents.map((def) => (
              <button
                key={def.type}
                onClick={() => { const id = addPluginObject(def.type); if (id) selectObjects([id]); }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "plugin-component", componentType: def.type }));
                  e.dataTransfer.effectAllowed = "copy";
                }}
                style={{ ...miniBtn, color: "#cca", borderColor: "#665533" }}
                title={`Add ${def.label} to active comp（ドラッグ可）`}
              >
                + {def.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Export Dialog */}
      {showExport && project && (
        <ExportDialog
          project={project}
          compId={compId}
          onClose={() => setShowExport(false)}
        />
      )}

      {/* §20.4b: 新規プロジェクト保存確認ダイアログ */}
      {showNewConfirm && (
        <NewProjectConfirm
          projectName={project?.meta.name ?? "Untitled"}
          zipBusy={zipBusy}
          zipStatus={zipStatus}
          onSave={() => { void onNewSaveThenCreate(); }}
          onDiscard={onNewDiscardThenCreate}
          onCancel={() => setShowNewConfirm(false)}
        />
      )}

      {deleteAsset && (
        <DeleteFootageConfirm
          name={deleteAsset.path.split("/").pop() ?? deleteAsset.id}
          refCount={deleteAssetRefCount}
          onConfirm={() => { removeAsset(deleteAsset.id); setDeleteAssetId(null); }}
          onCancel={() => setDeleteAssetId(null)}
        />
      )}
    </div>
  );
}

function countAssetReferences(project: Project, assetId: string): number {
  let count = 0;
  for (const comp of project.compositions) {
    if (comp.kind !== "timeline") continue;
    for (const obj of comp.objects) {
      if (obj.components.some(
        (cmp) =>
          (cmp.type === "audio" || cmp.type === "image" || cmp.type === "video") &&
          cmp.props["asset"] === assetId,
      )) count++;
    }
  }
  return count;
}

function DeleteFootageConfirm({
  name, refCount, onConfirm, onCancel,
}: {
  name: string;
  refCount: number;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={confirmOverlay}
      onClick={onCancel}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
    >
      <div style={confirmDialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: "bold", fontSize: 13, color: "#ddd", marginBottom: 8 }}>
          Footage を削除
        </div>
        <div style={{ color: "#bbb", lineHeight: 1.6, marginBottom: 16 }}>
          「{name}」をプロジェクトから削除しますか？
          {refCount > 0 && (
            <>
              <br />
              この素材は {refCount} レイヤーで使用中です。削除するとレイヤーも削除されます。
            </>
          )}
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onConfirm} style={confirmDangerBtn} autoFocus>削除</button>
          <button onClick={onCancel} style={confirmBtn}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

// §20.4b: New 押下時の「保存しますか？」モーダル。ExportDialog と同じ overlay スタイル。
function NewProjectConfirm({
  projectName, zipBusy, zipStatus, onSave, onDiscard, onCancel,
}: {
  projectName: string;
  zipBusy: boolean;
  zipStatus: string | null;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      style={confirmOverlay}
      onClick={zipBusy ? undefined : onCancel}
      onKeyDown={(e) => { if (!zipBusy && e.key === "Escape") onCancel(); }}
    >
      <div style={confirmDialog} onClick={(e) => e.stopPropagation()}>
        <div style={{ fontWeight: "bold", fontSize: 13, color: "#ddd", marginBottom: 8 }}>
          新規プロジェクト
        </div>
        <div style={{ color: "#bbb", lineHeight: 1.6, marginBottom: 16 }}>
          現在のプロジェクト「{projectName}」を保存しますか？<br />
          保存しない変更は失われます。
        </div>
        {zipBusy && zipStatus && (
          <div style={{ color: "#c9a227", fontSize: 11, marginBottom: 12 }}>
            {zipStatus}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onSave} disabled={zipBusy} style={confirmPrimaryBtnDisabled(zipBusy)} autoFocus>
            {zipBusy ? "保存中…" : "はい（保存）"}
          </button>
          <button onClick={onDiscard} disabled={zipBusy} style={confirmBtnDisabled(zipBusy)}>いいえ</button>
          <button onClick={onCancel} disabled={zipBusy} style={confirmBtnDisabled(zipBusy)}>キャンセル</button>
        </div>
      </div>
    </div>
  );
}

const confirmOverlay: React.CSSProperties = {
  position: "fixed", inset: 0, background: "rgba(0,0,0,.6)", display: "flex",
  alignItems: "center", justifyContent: "center", zIndex: 9999,
};

const confirmDialog: React.CSSProperties = {
  background: "#1e1e1e", border: "1px solid #444", borderRadius: 6,
  padding: 16, width: 340, maxWidth: "90vw", color: "#ccc", fontSize: 12,
  boxShadow: "0 8px 32px rgba(0,0,0,.6)",
};

const confirmBtn: React.CSSProperties = {
  background: "#2a2a2a", border: "1px solid #444", color: "#bbb",
  borderRadius: 3, padding: "5px 12px", cursor: "pointer", fontSize: 11,
};

const confirmPrimaryBtn: React.CSSProperties = {
  ...confirmBtn, background: "#2a4a3a", color: "#8da", borderColor: "#4a7a5a",
};

const confirmDangerBtn: React.CSSProperties = {
  ...confirmBtn, background: "#4a2a2a", color: "#faa", borderColor: "#7a4a4a",
};

function SectionHeader({ label, children }: { label: string; children?: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "5px 8px 3px", background: "#1e1e1e", borderBottom: "1px solid #2a2a2a", borderTop: "1px solid #2a2a2a", position: "sticky", top: 0 }}>
      <span style={{ color: "#888", fontSize: 10, textTransform: "uppercase", letterSpacing: 1, fontWeight: "bold" }}>{label}</span>
      <span style={{ display: "flex", gap: 4 }}>{children}</span>
    </div>
  );
}

function CompRow({
  comp, active, icon, iconColor, renaming, title,
  onClick, onStartRename, onCommitRename, onCancelRename, onDelete, onDragStart,
}: {
  comp: CompositionMeta;
  active: boolean;
  icon: string;
  iconColor: string;
  renaming: boolean;
  title?: string;
  onClick: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete?: () => void;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  return (
    <div
      title={title}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onClick={renaming ? undefined : onClick}
      onDoubleClick={onStartRename}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "3px 10px",
        background: active ? "#2a3a4a" : "transparent",
        borderLeft: active ? "2px solid #4a8acf" : "2px solid transparent",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#262626"; }}
      onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
    >
      <span style={{ color: iconColor }}>{icon}</span>
      {renaming ? (
        <input
          autoFocus
          defaultValue={comp.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => onCommitRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCommitRename(e.currentTarget.value);
            if (e.key === "Escape") onCancelRename();
          }}
          style={{ flex: 1, background: "#2a2a2a", border: "1px solid #4a8acf", color: "#fff", borderRadius: 3, padding: "1px 4px", fontSize: 11, userSelect: "text" }}
        />
      ) : (
        <span style={{ flex: 1, color: active ? "#cfe6ff" : "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {comp.name}
        </span>
      )}
      <span style={{ color: "#555", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
        {comp.width}×{comp.height}·{comp.fps}f
      </span>
      {onDelete && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          style={{ ...miniBtn, padding: "0 4px", color: "#f44", border: "none" }}
          title="コンポを削除"
        >×</button>
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

function btnStyleDisabled(disabled: boolean): React.CSSProperties {
  return disabled ? { ...btnStyle, opacity: 0.5, cursor: "default" } : btnStyle;
}

function confirmBtnDisabled(disabled: boolean): React.CSSProperties {
  return disabled ? { ...confirmBtn, opacity: 0.5, cursor: "default" } : confirmBtn;
}

function confirmPrimaryBtnDisabled(disabled: boolean): React.CSSProperties {
  return disabled ? { ...confirmPrimaryBtn, opacity: 0.5, cursor: "default" } : confirmPrimaryBtn;
}

const miniBtn: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "1px 5px",
  cursor: "pointer",
  fontSize: 10,
};
