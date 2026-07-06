import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";

// FEEDBACK_TOKEN: VITE_FEEDBACK_TOKEN と同じトークンを desktop 起動時にも渡す想定
// （.env.example 参照）。未設定なら feedback:post は常に false を返し、
// レンダラ側の retry queue に積まれる（Web と同じ失敗時挙動）。
const FEEDBACK_TOKEN = process.env.MAFTER_FEEDBACK_TOKEN ?? process.env.VITE_FEEDBACK_TOKEN;
const FEEDBACK_ORIGIN = process.env.MAFTER_FEEDBACK_ORIGIN ?? "https://maftereffect.gycp.party";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    backgroundColor: "#111111",
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void mainWindow.loadURL(devUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }

  mainWindow.on("maximize", () => mainWindow?.webContents.send("win:maximizeChanged", true));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("win:maximizeChanged", false));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.on("win:minimize", () => mainWindow?.minimize());
ipcMain.on("win:toggleMaximize", () => {
  if (!mainWindow) return;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
});
ipcMain.on("win:close", () => mainWindow?.close());
ipcMain.handle("win:isMaximized", () => mainWindow?.isMaximized() ?? false);

// レンダラは file:// / 別オリジンから起動するため直接 fetch すると
// Authorization ヘッダ付き POST が CORS プリフライトで弾かれる
// （scripts/mafter_http_server.py は OPTIONS 未対応）。
// メインプロセス（Node fetch、CORS 制約なし）経由で送ることで回避する。
ipcMain.handle("feedback:post", async (_event, payload: unknown) => {
  if (!FEEDBACK_TOKEN) return false;
  try {
    const res = await fetch(`${FEEDBACK_ORIGIN}/api/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${FEEDBACK_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    return res.ok;
  } catch {
    return false;
  }
});
