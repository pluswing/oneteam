import { contextBridge, ipcRenderer, webUtils } from "electron";

contextBridge.exposeInMainWorld("oneTeamDesktop", {
  getDroppedPath(file: File): string {
    return webUtils.getPathForFile(file);
  },
  chooseDirectory(): Promise<string | null> {
    return ipcRenderer.invoke("oneteam:choose-directory") as Promise<string | null>;
  }
});
