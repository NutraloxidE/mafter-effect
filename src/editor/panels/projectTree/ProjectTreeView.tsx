import { useCallback, useMemo, useRef, useState, type DragEvent, type MouseEvent } from "react";
import type { AssetEntry, Composition, Project, ProjectTreeEntry } from "../../../core/schema";
import { orderedEntriesForParent } from "../../../core/projectTree";
import { useDragEdgeAutoScroll } from "../../dragEdgeAutoScroll";
import { isBinExpanded, toggleBinExpanded } from "../../projectBinStorage";
import { DRAG_MIME } from "../dragMime";
import { useContextMenuStore, type ContextMenuItem } from "../../contextMenu/contextMenuStore";
import { isSplitAlphaVideoMeta } from "../../../runtime/imageAssetCache";
import {
  entryKey,
  filterMovableEntries,
  keysToEntries,
  parseTreeDragPayload,
  serializeTreeDragPayload,
} from "./projectTreeSelection";
import { PROJECT_TREE_ROW_PAD_RIGHT, projectTreeRowPadLeft } from "./projectTreeLayout";
import { ResourceAddMenu } from "./ResourceAddMenu";
import { toolbarBtn } from "./toolbarStyles";

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
  onDuplicateProjectEntries: (
    entries: ProjectTreeEntry[],
    targetBinId: string | null,
  ) => Promise<ProjectTreeEntry[]>;
  onImportImage: () => void;
  onImportVideo: () => void;
  onImportAudio: () => void;
  onAddTimelineComp: () => void;
  onAddHtmlComp: () => void;
  onAddImageLayer: (assetId: string) => string | null;
  onAddVideoLayer: (assetId: string) => string | null;
  onAddAudioLayer: (assetId: string) => string | null;
  onSelectObjects: (ids: string[]) => void;
  onCreateCompFromAsset: (assetId: string) => void;
  onConvertSplitToPacked: (assetId: string) => void;
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

function parentBinOf(project: Project, entry: ProjectTreeEntry): string | null {
  if (entry.kind === "bin") return binById(project, entry.id)?.parentId ?? null;
  if (entry.kind === "composition") return compById(project, entry.id)?.binId ?? null;
  return assetById(project, entry.id)?.binId ?? null;
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

function collectVisibleEntries(
  project: Project,
  search: string,
  expandedVersion: number,
): ProjectTreeEntry[] {
  void expandedVersion;
  const out: ProjectTreeEntry[] = [];
  const walk = (parentBinId: string | null) => {
    for (const entry of filterEntries(project, orderedEntriesForParent(project, parentBinId), search)) {
      out.push(entry);
      if (entry.kind === "bin") {
        const expanded = search.trim() ? true : isBinExpanded(entry.id);
        if (expanded) walk(entry.id);
      }
    }
  };
  walk(null);
  return out;
}

function rowBackground(selected: boolean, activeComp: boolean, hovered: boolean): string {
  if (selected) return "#354560";
  if (activeComp) return "#2a3a4a";
  if (hovered) return "#262626";
  return "transparent";
}

function isInteractiveChild(target: EventTarget | null): boolean {
  return !!(target as HTMLElement | null)?.closest("button, input");
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
    onDuplicateProjectEntries,
    onImportImage,
    onImportVideo,
    onImportAudio,
    onAddTimelineComp,
    onAddHtmlComp,
    onAddImageLayer,
    onAddVideoLayer,
    onAddAudioLayer,
    onSelectObjects,
    onCreateCompFromAsset,
    onConvertSplitToPacked,
  } = props;
  const openContextMenu = useContextMenuStore((s) => s.openContextMenu);

  const [search, setSearch] = useState("");
  const [renamingBinId, setRenamingBinId] = useState<string | null>(null);
  const [expandVersion, setExpandVersion] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [clipboardEntries, setClipboardEntries] = useState<ProjectTreeEntry[]>([]);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastSelectedKeyRef = useRef<string | null>(null);

  const selectedSet = useMemo(() => new Set(selectedKeys), [selectedKeys]);

  const visibleEntries = useMemo(
    () => collectVisibleEntries(project, search, expandVersion),
    [project, search, expandVersion],
  );

  const rootEntries = useMemo(
    () => filterEntries(project, orderedEntriesForParent(project, null), search),
    [project, search],
  );

  const isTreeDrag = useCallback(
    (e: React.DragEvent) =>
      e.dataTransfer.types.includes(TREE_DRAG_MIME) ||
      e.dataTransfer.types.includes(DRAG_MIME),
    [],
  );
  const edgeScroll = useDragEdgeAutoScroll(scrollRef, { isActive: isTreeDrag });

  const handleEntryClick = useCallback(
    (entry: ProjectTreeEntry, e: MouseEvent) => {
      e.stopPropagation();
      scrollRef.current?.focus();
      const key = entryKey(entry);

      if (e.shiftKey && lastSelectedKeyRef.current) {
        const keys = visibleEntries.map(entryKey);
        const lastIdx = keys.indexOf(lastSelectedKeyRef.current);
        const thisIdx = keys.indexOf(key);
        if (lastIdx >= 0 && thisIdx >= 0) {
          const lo = Math.min(lastIdx, thisIdx);
          const hi = Math.max(lastIdx, thisIdx);
          const range = keys.slice(lo, hi + 1);
          setSelectedKeys([...new Set([...selectedKeys, ...range])]);
          return;
        }
      }

      if (e.ctrlKey || e.metaKey) {
        if (selectedSet.has(key)) {
          setSelectedKeys(selectedKeys.filter((k) => k !== key));
        } else {
          setSelectedKeys([...selectedKeys, key]);
          lastSelectedKeyRef.current = key;
        }
        return;
      }

      setSelectedKeys([key]);
      lastSelectedKeyRef.current = key;

      if (entry.kind === "composition") {
        const comp = compById(project, entry.id);
        if (comp?.kind === "timeline") onSetCurrentComp(comp.id);
      }
    },
    [onSetCurrentComp, project, selectedKeys, selectedSet, visibleEntries],
  );

  const getDragEntries = useCallback(
    (entry: ProjectTreeEntry): ProjectTreeEntry[] => {
      const key = entryKey(entry);
      if (!selectedSet.has(key) || selectedKeys.length <= 1) return [entry];

      const order = new Map(visibleEntries.map((e, i) => [entryKey(e), i]));
      return keysToEntries(selectedKeys).sort(
        (a, b) => (order.get(entryKey(a)) ?? 0) - (order.get(entryKey(b)) ?? 0),
      );
    },
    [selectedKeys, selectedSet, visibleEntries],
  );

  const orderedSelectedEntries = useCallback(
    (fallback?: ProjectTreeEntry): ProjectTreeEntry[] => {
      if (fallback && !selectedSet.has(entryKey(fallback))) return [fallback];
      const selected = keysToEntries(selectedKeys);
      const order = new Map(visibleEntries.map((entry, index) => [entryKey(entry), index]));
      const sorted = selected.sort(
        (a, b) => (order.get(entryKey(a)) ?? Number.MAX_SAFE_INTEGER) - (order.get(entryKey(b)) ?? Number.MAX_SAFE_INTEGER),
      );
      return sorted.length > 0 ? sorted : fallback ? [fallback] : [];
    },
    [selectedKeys, selectedSet, visibleEntries],
  );

  const copyEntries = useCallback((fallback?: ProjectTreeEntry) => {
    const entries = orderedSelectedEntries(fallback);
    if (entries.length > 0) setClipboardEntries(entries);
  }, [orderedSelectedEntries]);

  const pasteEntries = useCallback((targetBinId: string | null) => {
    if (clipboardEntries.length === 0) return;
    void onDuplicateProjectEntries(clipboardEntries, targetBinId).then((pasted) => {
      if (pasted.length === 0) return;
      const keys = pasted.map(entryKey);
      setSelectedKeys(keys);
      lastSelectedKeyRef.current = keys.at(-1) ?? null;
    });
  }, [clipboardEntries, onDuplicateProjectEntries]);

  const contextMenuEntries = useCallback((entry: ProjectTreeEntry): ProjectTreeEntry[] => {
    const entries = orderedSelectedEntries(entry);
    if (!selectedSet.has(entryKey(entry))) {
      setSelectedKeys([entryKey(entry)]);
      lastSelectedKeyRef.current = entryKey(entry);
    }
    return entries;
  }, [orderedSelectedEntries, selectedSet]);

  const copyPasteMenuItems = useCallback(
    (entry: ProjectTreeEntry): ContextMenuItem[] => {
      const entries = contextMenuEntries(entry);
      const pasteTarget = entry.kind === "bin" ? entry.id : parentBinOf(project, entry);
      return [
        {
          kind: "action",
          label: entries.length > 1 ? `コピー (${entries.length})` : "コピー",
          shortcut: "Ctrl+C",
          onSelect: () => setClipboardEntries(entries),
        },
        {
          kind: "action",
          label: "貼り付け",
          shortcut: "Ctrl+V",
          disabled: clipboardEntries.length === 0,
          onSelect: () => pasteEntries(pasteTarget),
        },
      ];
    },
    [clipboardEntries.length, contextMenuEntries, pasteEntries, project],
  );

  const keyboardPasteTarget = useCallback((): string | null => {
    const selected = orderedSelectedEntries();
    if (selected.length === 1 && selected[0]?.kind === "bin") return selected[0].id;
    return selected[0] ? parentBinOf(project, selected[0]) : null;
  }, [orderedSelectedEntries, project]);

  const onTreeDragStart = useCallback(
    (e: DragEvent, entry: ProjectTreeEntry) => {
      const entries = getDragEntries(entry);
      e.dataTransfer.setData(TREE_DRAG_MIME, serializeTreeDragPayload(entries));
      e.dataTransfer.effectAllowed = "move";
    },
    [getDragEntries],
  );

  const onTreeDragEnd = edgeScroll.onDragEnd;

  const onDropOnBin = useCallback(
    (e: DragEvent, targetBinId: string | null) => {
      const raw = e.dataTransfer.getData(TREE_DRAG_MIME);
      const entries = filterMovableEntries(project, parseTreeDragPayload(raw), targetBinId);
      if (entries.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const targetList = orderedEntriesForParent(project, targetBinId);
      onMoveProjectEntries(entries, targetBinId, targetList.length);
    },
    [onMoveProjectEntries, project],
  );

  const renderEntry = (entry: ProjectTreeEntry, depth: number) => {
    const pad = projectTreeRowPadLeft(depth);
    const key = entryKey(entry);
    const selected = selectedSet.has(key);
    const hovered = hoveredKey === key;

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
            onContextMenu={(e) => {
              e.preventDefault();
              openContextMenu(e.clientX, e.clientY, copyPasteMenuItems(entry));
            }}
            onClick={(e) => {
              if (isInteractiveChild(e.target)) return;
              handleEntryClick(entry, e);
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(e) => onDropOnBin(e, entry.id)}
            onMouseEnter={() => setHoveredKey(key)}
            onMouseLeave={() => setHoveredKey((h) => (h === key ? null : h))}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: `3px ${PROJECT_TREE_ROW_PAD_RIGHT}px`,
              paddingLeft: pad,
              cursor: "pointer",
              userSelect: "none",
              background: rowBackground(selected, false, hovered),
              borderLeft: selected ? "2px solid #6a9fd4" : "2px solid transparent",
            }}
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
                onDoubleClick={(e) => { e.stopPropagation(); setRenamingBinId(entry.id); }}
                draggable
                onDragStart={(e) => onTreeDragStart(e, entry)}
                onDragEnd={onTreeDragEnd}
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
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, copyPasteMenuItems(entry));
          }}
          onDragStart={(e) => {
            onTreeDragStart(e, entry);
            if (comp.kind === "timeline") {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "timeline-comp", id: comp.id }));
            } else {
              e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ kind: "html-comp", id: comp.id }));
            }
            e.dataTransfer.effectAllowed = "copyMove";
          }}
          onDragEnd={onTreeDragEnd}
          onClick={renamingCompId === comp.id ? undefined : (e) => handleEntryClick(entry, e)}
          onDoubleClick={() => onSetRenamingCompId(comp.id)}
          title={
            comp.kind === "timeline"
              ? "クリックで選択・アクティブ / Ctrl・Shift で複数選択 / ドラッグで移動・タイムラインへ"
              : "Ctrl・Shift で複数選択 / ドラッグで移動・タイムラインへ配置"
          }
          onMouseEnter={() => setHoveredKey(key)}
          onMouseLeave={() => setHoveredKey((h) => (h === key ? null : h))}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: `3px ${PROJECT_TREE_ROW_PAD_RIGHT}px`,
            paddingLeft: pad,
            background: rowBackground(selected, active && !selected, hovered),
            borderLeft: selected ? "2px solid #6a9fd4" : active ? "2px solid #4a8acf" : "2px solid transparent",
            cursor: "pointer",
          }}
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
    const addFootageLayer = () => {
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
    const canCreateCompFromAsset = asset.kind === "image" || asset.kind === "video";
    const canConvertToPacked = asset.kind === "video" && isSplitAlphaVideoMeta(asset.meta);
    const handleAssetContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const items: ContextMenuItem[] = [...copyPasteMenuItems(entry)];
      if (canCreateCompFromAsset) {
        items.push(
          { kind: "separator" },
          { kind: "action", label: "このファイルでコンポジットを作成", onSelect: () => onCreateCompFromAsset(asset.id) },
        );
      }
      if (canConvertToPacked) {
        items.push({
          kind: "action",
          label: "Packed 化（split alpha を1本の動画に軽量化）",
          onSelect: () => onConvertSplitToPacked(asset.id),
        });
      }
      openContextMenu(e.clientX, e.clientY, items);
    };

    return (
      <div
        key={`asset:${entry.id}`}
        draggable={isFootage}
        onContextMenu={handleAssetContextMenu}
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
        onDragEnd={onTreeDragEnd}
        title={
          isFootage
            ? "クリックで選択 / ダブルクリックでタイムラインへ / Ctrl・Shift で複数選択 / ドラッグで移動・配置"
            : undefined
        }
        onClick={(e) => handleEntryClick(entry, e)}
        onDoubleClick={() => { if (isFootage) addFootageLayer(); }}
        onMouseEnter={() => setHoveredKey(key)}
        onMouseLeave={() => setHoveredKey((h) => (h === key ? null : h))}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: `3px ${PROJECT_TREE_ROW_PAD_RIGHT}px`,
          paddingLeft: pad,
          cursor: isFootage ? "pointer" : "default",
          background: rowBackground(selected, false, hovered),
          borderLeft: selected ? "2px solid #6a9fd4" : "2px solid transparent",
        }}
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
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 4, alignItems: "center", minHeight: 18 }}>
          <button type="button" onClick={() => onCreateBin(null)} style={toolbarBtn} title="新規フォルダ">
            📁+ Folder
          </button>
          <ResourceAddMenu
            onAddTimelineComp={onAddTimelineComp}
            onAddHtmlComp={onAddHtmlComp}
            onImportImage={onImportImage}
            onImportVideo={onImportVideo}
            onImportAudio={onImportAudio}
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        style={{ flex: 1, overflow: "auto", outline: "none" }}
        onCopy={(e) => {
          const entries = orderedSelectedEntries();
          if (entries.length === 0) return;
          e.preventDefault();
          copyEntries();
        }}
        onPaste={(e) => {
          if (clipboardEntries.length === 0) return;
          e.preventDefault();
          pasteEntries(keyboardPasteTarget());
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openContextMenu(e.clientX, e.clientY, [
            {
              kind: "action",
              label: "貼り付け",
              shortcut: "Ctrl+V",
              disabled: clipboardEntries.length === 0,
              onSelect: () => pasteEntries(null),
            },
          ]);
        }}
        onDragOverCapture={edgeScroll.onDragOverCapture}
        onDragLeave={edgeScroll.onDragLeave}
        onClick={(e) => {
          if (e.target === e.currentTarget) {
            setSelectedKeys([]);
            e.currentTarget.focus();
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(TREE_DRAG_MIME)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
          }
        }}
        onDrop={(e) => {
          edgeScroll.onDrop();
          onDropOnBin(e, null);
        }}
      >
        {rootEntries.length === 0 && (
          <div
            style={{ padding: "8px 10px", color: "#444", fontSize: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
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
