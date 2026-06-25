import { useCallback, useMemo, useState, type DragEvent } from "react";
import type { AssetEntry, Composition, Project, ProjectTreeEntry } from "../../../core/schema";
import { orderedEntriesForParent } from "../../../core/projectTree";
import { isBinExpanded, toggleBinExpanded } from "../../projectBinStorage";
import { DRAG_MIME } from "../dragMime";

export const TREE_DRAG_MIME = "application/x-mafter-project-tree";

export interface ProjectTreeViewProps {
  project: Project;
  compId: string | null;
  renamingCompId: string | null;
  onSetRenamingCompId: (id: string | null) => void;
  onSetDeleteAssetId: (id: string | null) => void;
  onSetCurrentComp: (id: string) => void;
  onRenameComposition: (id: string, name: string) => void;
  onRemoveComposition: (id: string) => void;
  onCreateBin: (parentBinId?: string | null) => void;
  onRenameBin: (id: string, name: string) => void;
  onDeleteBin: (id: string) => void;
  onMoveProjectEntries: (
    entries: ProjectTreeEntry[],
    targetBinId: string | null,
    index: number,
  ) => void;
  onImportImage: () => void;
  onImportVideo: () => void;
  onImportAudio: () => void;
  onAddTimelineComp: () => void;
  onAddHtmlComp: () => void;
  onAddImageLayer: (assetId: string) => string | null;
  onAddVideoLayer: (assetId: string) => string | null;
  onAddAudioLayer: (assetId: string) => string | null;
  onSelectObjects: (ids: string[]) => void;
}

function matchesSearch(name: string, query: string): boolean {
  return name.toLowerCase().includes(query.toLowerCase());
}

function binById(project: Project, id: string) {
  return (project.bins ?? []).find((b) => b.id === id);
}

function compById(project: Project, id: string): Composition | undefined {
  return project.compositions.find((c) => c.id === id);
}

function assetById(project: Project, id: string): AssetEntry | undefined {
  return project.assets.find((a) => a.id === id);
}

function entryLabel(project: Project, entry: ProjectTreeEntry): string {
  switch (entry.kind) {
    case "bin":
      return binById(project, entry.id)?.name ?? entry.id;
    case "composition":
      return compById(project, entry.id)?.name ?? entry.id;
    case "asset": {
      const a = assetById(project, entry.id);
      return a?.path.split("/").pop() ?? entry.id;
    }
  }
}

/** 検索時: マッチする行またはマッチする子孫を持つ bin を表示。 */
function filterEntries(
  project: Project,
  entries: ProjectTreeEntry[],
  query: string,
): ProjectTreeEntry[] {
  if (!query.trim()) return entries;
  const q = query.trim();
  const out: ProjectTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "bin") {
      const children = orderedEntriesForParent(project, entry.id);
      const childFiltered = filterEntries(project, children, q);
      if (childFiltered.length > 0 || matchesSearch(entryLabel(project, entry), q)) {
        out.push(entry);
      }
    } else if (matchesSearch(entryLabel(project, entry), q)) {
      out.push(entry);
    }
  }
  return out;
}

function parseTreeDrag(data: string): ProjectTreeEntry | null {
  try {
    const parsed = JSON.parse(data) as ProjectTreeEntry;
    if (parsed.kind === "bin" || parsed.kind === "composition" || parsed.kind === "asset") {
      return parsed;
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function ProjectTreeView(props: ProjectTreeViewProps) {
  const {
    project,
    compId,
    renamingCompId,
    onSetRenamingCompId,
    onSetDeleteAssetId,
    onSetCurrentComp,
    onRenameComposition,
    onRemoveComposition,
    onCreateBin,
    onRenameBin,
    onDeleteBin,
    onMoveProjectEntries,
    onImportImage,
    onImportVideo,
    onImportAudio,
    onAddTimelineComp,
    onAddHtmlComp,
    onAddImageLayer,
    onAddVideoLayer,
    onAddAudioLayer,
    onSelectObjects,
  } = props;

  const [search, setSearch] = useState("");
  const [renamingBinId, setRenamingBinId] = useState<string | null>(null);
  const [expandVersion, setExpandVersion] = useState(0);

  const rootEntries = useMemo(
    () => filterEntries(project, orderedEntriesForParent(project, null), search),
    [project, search],
  );

  const onTreeDragStart = useCallback((e: DragEvent, entry: ProjectTreeEntry) => {
    e.dataTransfer.setData(TREE_DRAG_MIME, JSON.stringify(entry));
    e.dataTransfer.effectAllowed = "move";
  }, []);

  const onDropOnBin = useCallback(
    (e: DragEvent, targetBinId: string | null) => {
      const raw = e.dataTransfer.getData(TREE_DRAG_MIME);
      const entry = parseTreeDrag(raw);
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      if (entry.kind === "bin" && entry.id === targetBinId) return;
      const targetList = orderedEntriesForParent(project, targetBinId);
      onMoveProjectEntries([entry], targetBinId, targetList.length);
    },
    [onMoveProjectEntries, project],
  );

  const renderEntry = (entry: ProjectTreeEntry, depth: number) => {
    const pad = 10 + depth * 14;

    if (entry.kind === "bin") {
      const bin = binById(project, entry.id);
      if (!bin) return null;
      const expanded = search.trim() ? true : isBinExpanded(entry.id);
      const children = filterEntries(
        project,
        orderedEntriesForParent(project, entry.id),
        search,
      );
      return (
        <div key={`bin:${entry.id}`}>
          <div
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => onDropOnBin(e, entry.id)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: `3px ${pad}px 3px 6px`,
              cursor: "pointer",
              userSelect: "none",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = "#262626")}
            onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
          >
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (!search.trim()) {
                  toggleBinExpanded(entry.id);
                  setExpandVersion((v) => v + 1);
                }
              }}
              style={chevronBtn}
              title={expanded ? "折りたたむ" : "展開"}
            >
              {expanded ? "▾" : "▸"}
            </button>
            <span style={{ color: "#c9a227" }}>📁</span>
            {renamingBinId === entry.id ? (
              <input
                autoFocus
                defaultValue={bin.name}
                onClick={(e) => e.stopPropagation()}
                onBlur={(e) => {
                  const v = e.currentTarget.value.trim();
                  if (v) onRenameBin(entry.id, v);
                  setRenamingBinId(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    const v = e.currentTarget.value.trim();
                    if (v) onRenameBin(entry.id, v);
                    setRenamingBinId(null);
                  }
                  if (e.key === "Escape") setRenamingBinId(null);
                }}
                style={renameInput}
              />
            ) : (
              <span
                style={{ flex: 1, color: "#ccc", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                onDoubleClick={() => setRenamingBinId(entry.id)}
                draggable
                onDragStart={(e) => onTreeDragStart(e, entry)}
              >
                {bin.name}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onCreateBin(entry.id); }}
              style={miniBtn}
              title="サブフォルダを作成"
            >
              +
            </button>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onDeleteBin(entry.id); }}
              style={{ ...miniBtn, color: "#f88", border: "none" }}
              title="フォルダを削除（中身は親へ移動）"
            >
              ×
            </button>
          </div>
          {expanded && children.map((child) => renderEntry(child, depth + 1))}
        </div>
      );
    }

    if (entry.kind === "composition") {
      const comp = compById(project, entry.id);
      if (!comp) return null;
      const active = comp.kind === "timeline" && comp.id === compId;
      const icon = comp.kind === "timeline" ? "▦" : "◇";
      const iconColor = comp.kind === "timeline" ? "#7fb8f0" : "#8a8";
      const timelineCount = project.compositions.filter((c) => c.kind === "timeline").length;
      return (
        <div
          key={`comp:${entry.id}`}
          draggable
          onDragStart={(e) => {
            onTreeDragStart(e, entry);
            if (comp.kind === "timeline") {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "timeline-comp", id: comp.id }));
            } else {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "html-comp", id: comp.id }));
            }
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onClick={renamingCompId === comp.id ? undefined : () => {
            if (comp.kind === "timeline") onSetCurrentComp(comp.id);
          }}
          onDoubleClick={() => onSetRenamingCompId(comp.id)}
          title={
            comp.kind === "timeline"
              ? "クリックでアクティブ / ドラッグでタイムラインへ"
              : "ドラッグでタイムラインへ配置"
          }
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: `3px ${pad}px`,
            paddingLeft: pad,
            background: active ? "#2a3a4a" : "transparent",
            borderLeft: active ? "2px solid #4a8acf" : "2px solid transparent",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => { if (!active) e.currentTarget.style.background = "#262626"; }}
          onMouseLeave={(e) => { if (!active) e.currentTarget.style.background = "transparent"; }}
        >
          <span style={{ color: iconColor }}>{icon}</span>
          {renamingCompId === comp.id ? (
            <input
              autoFocus
              defaultValue={comp.name}
              onClick={(e) => e.stopPropagation()}
              onBlur={(e) => {
                const v = e.currentTarget.value.trim();
                if (v) onRenameComposition(comp.id, v);
                onSetRenamingCompId(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const v = e.currentTarget.value.trim();
                  if (v) onRenameComposition(comp.id, v);
                  onSetRenamingCompId(null);
                }
                if (e.key === "Escape") onSetRenamingCompId(null);
              }}
              style={renameInput}
            />
          ) : (
            <span style={{ flex: 1, color: active ? "#cfe6ff" : "#bbb", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {comp.name}
            </span>
          )}
          <span style={{ color: "#555", fontSize: 9, fontVariantNumeric: "tabular-nums" }}>
            {comp.width}×{comp.height}·{comp.fps}f
          </span>
          {(comp.kind !== "timeline" || timelineCount > 1) && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemoveComposition(comp.id); }}
              style={{ ...miniBtn, padding: "0 4px", color: "#f44", border: "none" }}
              title="コンポを削除"
            >
              ×
            </button>
          )}
        </div>
      );
    }

    const asset = assetById(project, entry.id);
    if (!asset) return null;
    const isFootage = asset.kind === "audio" || asset.kind === "image" || asset.kind === "video";
    const onFootageClick = () => {
      if (asset.kind === "audio") {
        const id = onAddAudioLayer(asset.id);
        if (id) onSelectObjects([id]);
      } else if (asset.kind === "image") {
        const id = onAddImageLayer(asset.id);
        if (id) onSelectObjects([id]);
      } else if (asset.kind === "video") {
        const id = onAddVideoLayer(asset.id);
        if (id) onSelectObjects([id]);
      }
    };
    const icon =
      asset.kind === "audio" ? "♪" : asset.kind === "image" ? "🖼" : asset.kind === "video" ? "▶" : "▭";
    const iconColor =
      asset.kind === "audio" ? "#a88" : asset.kind === "image" ? "#8a8" : asset.kind === "video" ? "#88a" : "#888";

    return (
      <div
        key={`asset:${entry.id}`}
        draggable={isFootage}
        onDragStart={(e) => {
          onTreeDragStart(e, entry);
          if (asset.kind === "audio") {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "audio-asset", id: asset.id }));
          } else if (asset.kind === "image") {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "image-asset", id: asset.id }));
          } else if (asset.kind === "video") {
            e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "video-asset", id: asset.id }));
          }
          e.dataTransfer.effectAllowed = "copyMove";
        }}
        title={isFootage ? "クリック or ドラッグでアクティブ comp に配置" : undefined}
        onClick={() => { if (isFootage) onFootageClick(); }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `3px ${pad}px`,
          paddingLeft: pad,
          cursor: isFootage ? "pointer" : "default",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "#262626")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ color: iconColor }}>{icon}</span>
        <span style={{ flex: 1, color: "#aaa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {asset.path.split("/").pop() ?? asset.id}
        </span>
        <span style={{ color: "#555", fontSize: 10 }}>{asset.kind}</span>
        {isFootage && (
          <button
            onClick={(e) => { e.stopPropagation(); onSetDeleteAssetId(asset.id); }}
            style={{ ...miniBtn, padding: "0 4px", color: "#f44", border: "none" }}
            title="Footage を削除"
          >
            ×
          </button>
        )}
      </div>
    );
  };

  void expandVersion;

  return (
    <>
      <div style={toolbar}>
        <input
          type="search"
          placeholder="検索…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={searchInput}
        />
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" onClick={() => onCreateBin(null)} style={miniBtn} title="新規フォルダ">
            📁+ Folder
          </button>
          <button type="button" onClick={onAddTimelineComp} style={miniBtn}>+ Comp</button>
          <button type="button" onClick={() => void onAddHtmlComp()} style={miniBtn}>+ HTML</button>
          <button type="button" onClick={onImportImage} style={miniBtn}>+ Image</button>
          <button type="button" onClick={onImportVideo} style={miniBtn}>+ Video</button>
          <button type="button" onClick={onImportAudio} style={miniBtn}>+ Audio</button>
        </div>
      </div>
      <div
        style={{ flex: 1, overflow: "auto" }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => onDropOnBin(e, null)}
      >
        {rootEntries.length === 0 && (
          <div style={{ padding: "8px 10px", color: "#444", fontSize: 10 }}>
            {search.trim() ? "一致するアイテムがありません" : "プロジェクトは空です"}
          </div>
        )}
        {rootEntries.map((entry) => renderEntry(entry, 0))}
      </div>
    </>
  );
}

const toolbar: React.CSSProperties = {
  padding: "6px 8px",
  background: "#1e1e1e",
  borderBottom: "1px solid #2a2a2a",
  flexShrink: 0,
};

const searchInput: React.CSSProperties = {
  width: "100%",
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#ddd",
  borderRadius: 3,
  padding: "3px 6px",
  fontSize: 11,
  userSelect: "text",
};

const miniBtn: React.CSSProperties = {
  background: "#2a2a2a",
  border: "1px solid #444",
  color: "#bbb",
  borderRadius: 3,
  padding: "1px 5px",
  cursor: "pointer",
  fontSize: 10,
};

const chevronBtn: React.CSSProperties = {
  ...miniBtn,
  padding: "0 4px",
  minWidth: 18,
  border: "none",
  background: "transparent",
  color: "#888",
};

const renameInput: React.CSSProperties = {
  flex: 1,
  background: "#2a2a2a",
  border: "1px solid #4a8acf",
  color: "#fff",
  borderRadius: 3,
  padding: "1px 4px",
  fontSize: 11,
  userSelect: "text",
};
