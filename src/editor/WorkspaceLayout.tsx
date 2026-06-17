import { Fragment, useCallback, useRef, useState } from "react";
import type { LayoutNode, PanelId } from "./layout";
import { EasePanel } from "./panels/EasePanel";
import { InspectorPanel } from "./panels/InspectorPanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { ProjectPanel } from "./panels/ProjectPanel";
import { TimelinePanel } from "./panels/TimelinePanel";

interface WorkspaceLayoutProps {
  node: LayoutNode;
  onSizesChange?: (path: number[], sizes: number[]) => void;
  onTabsChange?: (path: number[], active: number) => void;
}

export function WorkspaceLayout({ node, onSizesChange, onTabsChange }: WorkspaceLayoutProps) {
  return <NodeRenderer node={node} path={[]} onSizesChange={onSizesChange} onTabsChange={onTabsChange} />;
}

function NodeRenderer({
  node,
  path,
  onSizesChange,
  onTabsChange,
}: {
  node: LayoutNode;
  path: number[];
  onSizesChange?: (path: number[], sizes: number[]) => void;
  onTabsChange?: (path: number[], active: number) => void;
}) {
  if (node.type === "panel") return <PanelHost id={node.panel} />;

  if (node.type === "split") {
    return (
      <SplitPane
        dir={node.dir}
        sizes={node.sizes}
        onSizesChange={(s) => onSizesChange?.(path, s)}
      >
        {node.children.map((child, i) => (
          <NodeRenderer
            key={i}
            node={child}
            path={[...path, i]}
            onSizesChange={onSizesChange}
            onTabsChange={onTabsChange}
          />
        ))}
      </SplitPane>
    );
  }

  if (node.type === "tabs") {
    return (
      <TabHost
        panels={node.panels}
        active={node.active}
        onSelect={(active) => onTabsChange?.(path, active)}
      />
    );
  }

  return null;
}

// ---- SplitPane（スプリッタ resize, §19.2）----

function SplitPane({
  dir,
  sizes,
  onSizesChange,
  children,
}: {
  dir: "row" | "col";
  sizes: number[];
  onSizesChange?: (sizes: number[]) => void;
  children: React.ReactNode[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [localSizes, setLocalSizes] = useState(sizes);

  const startDrag = useCallback(
    (splitterIndex: number, e: React.MouseEvent) => {
      e.preventDefault();
      const container = containerRef.current;
      if (!container) return;
      const isRow = dir === "row";
      const totalPx = isRow ? container.offsetWidth : container.offsetHeight;
      const startPos = isRow ? e.clientX : e.clientY;
      const startSizes = [...localSizes];

      const onMove = (ev: MouseEvent) => {
        const delta = (isRow ? ev.clientX : ev.clientY) - startPos;
        const deltaFrac = delta / totalPx;
        const a = splitterIndex;
        const b = splitterIndex + 1;
        const newA = Math.max(0.05, (startSizes[a] ?? 0) + deltaFrac);
        const newB = Math.max(0.05, (startSizes[b] ?? 0) - deltaFrac);
        const next = [...startSizes];
        next[a] = newA;
        next[b] = newB;
        setLocalSizes(next);
        onSizesChange?.(next);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [dir, localSizes, onSizesChange],
  );

  const childArr = Array.isArray(children) ? children : [children];

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: dir === "row" ? "row" : "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {childArr.map((child, i) => (
        <Fragment key={`pane-${i}`}>
          <div
            style={{
              flex: `0 0 ${(localSizes[i] ?? 1 / childArr.length) * 100}%`,
              overflow: "hidden",
              minWidth: 0,
              minHeight: 0,
            }}
          >
            {child}
          </div>
          {i < childArr.length - 1 && (
            <div
              onMouseDown={(e) => startDrag(i, e)}
              style={{
                flex: "0 0 4px",
                background: "#333",
                cursor: dir === "row" ? "col-resize" : "row-resize",
                userSelect: "none",
              }}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// ---- Tab host ----

const PANEL_TAB_LABELS: Partial<Record<PanelId, string>> = {
  inspector: "Inspector",
  ease: "Ease",
};

function TabHost({
  panels,
  active,
  onSelect,
}: {
  panels: PanelId[];
  active: number;
  onSelect?: (active: number) => void;
}) {
  const current = panels[active] ?? panels[0];
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", overflow: "hidden" }}>
      <div style={{ display: "flex", flexShrink: 0, background: "#1a1a1a", borderBottom: "1px solid #333" }}>
        {panels.map((id, i) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect?.(i)}
            style={{
              flex: 1,
              padding: "5px 8px",
              fontSize: 11,
              border: "none",
              borderBottom: i === active ? "2px solid #7fb8f0" : "2px solid transparent",
              background: i === active ? "#222" : "transparent",
              color: i === active ? "#ddd" : "#888",
              cursor: "pointer",
            }}
          >
            {PANEL_TAB_LABELS[id] ?? id}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {current ? <PanelHost id={current} /> : null}
      </div>
    </div>
  );
}

// ---- Panel host ----

function PanelHost({ id }: { id: PanelId }) {
  const style: React.CSSProperties = {
    width: "100%",
    height: "100%",
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
  };
  switch (id) {
    case "preview":
      return (
        <div style={style}>
          <PreviewPanel />
        </div>
      );
    case "timeline":
      return (
        <div style={style}>
          <TimelinePanel />
        </div>
      );
    case "project":
      return (
        <div style={style}>
          <ProjectPanel />
        </div>
      );
    case "inspector":
      return (
        <div style={style}>
          <InspectorPanel />
        </div>
      );
    case "ease":
      return (
        <div style={style}>
          <EasePanel />
        </div>
      );
    case "log":
      return (
        <div style={{ ...style, padding: 8, color: "#aaa", fontSize: 12 }}>
          Log panel
        </div>
      );
  }
}
