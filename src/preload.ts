import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  
  // Listen for auth status changes
  onAuthStatusChanged: (callback) => {
    ipcRenderer.on('auth-status-changed', (event, data) => callback(data));
  }
});