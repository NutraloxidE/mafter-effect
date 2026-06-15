import { useCallback, useEffect, useRef, useState } from "react";
import { createProject } from "./core/createProject";
import { loadProject, saveProject } from "./core/projectFs";
import { serializeProject } from "./core/serialize";
import type { Project } from "./core/schema";
import { IndexedDbFs } from "./fs/IndexedDbFs";
import { exportZip, importZip } from "./fs/zip";

const fs = new IndexedDbFs();

export function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [json, setJson] = useState<string>("");
  const fileInput = useRef<HTMLInputElement>(null);

  const appendLog = useCallback((msg: string) => {
    setLog((prev) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...prev]);
  }, []);

  const refreshView = useCallback((p: Project) => {
    setProject(p);
    setJson(serializeProject(p));
  }, []);

  // 起動時に既存プロジェクトがあれば読み込む。
  useEffect(() => {
    (async () => {
      try {
        if (await fs.exists("project.json")) {
          const { project: p, warnings } = await loadProject(fs);
          refreshView(p);
          appendLog(`loaded existing project (${warnings.length} warnings)`);
        }
      } catch (e) {
        appendLog(`load error: ${String(e)}`);
      }
    })();
  }, [appendLog, refreshView]);

  const onCreate = useCallback(async () => {
    const p = createProject({ name: "Untitled" });
    refreshView(p);
    appendLog(`created project (root comp ${p.rootComposition})`);
  }, [appendLog, refreshView]);

  const onSave = useCallback(async () => {
    if (!project) return;
    await saveProject(fs, project);
    appendLog("saved project.json to IndexedDbFs");
  }, [appendLog, project]);

  const onReload = useCallback(async () => {
    try {
      const { project: p, warnings } = await loadProject(fs);
      const before = json;
      refreshView(p);
      const after = serializeProject(p);
      appendLog(
        `reloaded — byte-equal to in-memory: ${before === after ? "YES" : "NO"} (${warnings.length} warnings)`,
      );
    } catch (e) {
      appendLog(`reload error: ${String(e)}`);
    }
  }, [appendLog, json, refreshView]);

  const onExportZip = useCallback(async () => {
    const bytes = await exportZip(fs);
    // Uint8Array<ArrayBufferLike> ↔ BlobPart の lib 型差を吸収（実体は通常の Uint8Array）。
    const blob = new Blob([bytes as unknown as BlobPart], {
      type: "application/zip",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "mafter-project.zip";
    a.click();
    URL.revokeObjectURL(url);
    appendLog(`exported zip (${bytes.length} bytes)`);
  }, [appendLog]);

  const onImportZip = useCallback(
    async (file: File) => {
      try {
        const buf = await file.arrayBuffer();
        await importZip(fs, buf);
        const { project: p, warnings } = await loadProject(fs);
        refreshView(p);
        appendLog(`imported zip + reloaded (${warnings.length} warnings)`);
      } catch (e) {
        appendLog(`import error: ${String(e)}`);
      }
    },
    [appendLog, refreshView],
  );

  return (
    <div style={{ fontFamily: "system-ui, sans-serif", padding: 24, maxWidth: 900 }}>
      <h1 style={{ marginBottom: 4 }}>Mafter Effect</h1>
      <p style={{ color: "#666", marginTop: 0 }}>M0 Foundations — project.json / IndexedDbFs / zip</p>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        <button onClick={onCreate}>New Project</button>
        <button onClick={onSave} disabled={!project}>Save</button>
        <button onClick={onReload}>Reload from FS</button>
        <button onClick={onExportZip}>Export .zip</button>
        <button onClick={() => fileInput.current?.click()}>Import .zip</button>
        <input
          ref={fileInput}
          type="file"
          accept=".zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onImportZip(f);
            e.target.value = "";
          }}
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <section>
          <h3>project.json (canonical)</h3>
          <pre
            style={{
              background: "#f5f5f5",
              padding: 12,
              borderRadius: 6,
              fontSize: 12,
              maxHeight: 480,
              overflow: "auto",
            }}
          >
            {json || "(no project — click New Project)"}
          </pre>
        </section>
        <section>
          <h3>Log</h3>
          <ul style={{ fontSize: 13, paddingLeft: 16 }}>
            {log.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
