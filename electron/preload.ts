import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("mafterDesktop", {
  isElectron: true,
  minimize: () => ipcRenderer.send("win:minimize"),
  toggleMaximize: () => ipcRenderer.send("win:toggleMaximize"),
  close: () => ipcRenderer.send("win:close"),
  isMaximized: () => ipcRenderer.invoke("win:isMaximized") as Promise<boolean>,
  onMaximizeChange: (cb: (maximized: boolean) => void) => {
    const listener = (_event: unknown, maximized: boolean) => cb(maximized);
    ipcRenderer.on("win:maximizeChanged", listener);
    return () => ipcRenderer.removeListener("win:maximizeChanged", listener);
  },
  postFeedback: (payload: unknown) => ipcRenderer.invoke("feedback:post", payload) as Promise<boolean>,
});
