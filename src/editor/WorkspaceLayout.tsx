import { useCallback, useRef, useState } from "react";
import type { LayoutNode, PanelId } from "./layout";
import { InspectorPanel } from "./panels/InspectorPanel";
import { PreviewPanel } from "./panels/PreviewPanel";
import { ProjectPanel } from "./panels/ProjectPanel";
import { TimelinePanel } from "./panels/TimelinePanel";

interface WorkspaceLayoutProps {
  node: LayoutNode;
  onSizesChange?: (path: number[], sizes: number[]) => void;
}

export function WorkspaceLayout({ node, onSizesChange }: WorkspaceLayoutProps) {
  return <NodeRenderer node={node} path={[]} onSizesChange={onSizesChange} />;
}

function NodeRenderer({
  node,
  path,
  onSizesChange,
}: {
  node: LayoutNode;
  path: number[];
  onSizesChange?: (path: number[], sizes: number[]) => void;
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
          />
        ))}
      </SplitPane>
    );
  }

  // tabs: MVP は active panel のみ表示
  if (node.type === "tabs") {
    const active = node.panels[node.active];
    return active ? <PanelHost id={active} /> : null;
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
        <>
          <div
            key={`child-${i}`}
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
              key={`splitter-${i}`}
              onMouseDown={(e) => startDrag(i, e)}
              style={{
                flex: "0 0 4px",
                background: "#333",
                cursor: dir === "row" ? "col-resize" : "row-resize",
                userSelect: "none",
              }}
            />
          )}
        </>
      ))}
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
    case "log":
      return (
        <div style={{ ...style, padding: 8, color: "#aaa", fontSize: 12 }}>
          Log panel
        </div>
      );
  }
}
