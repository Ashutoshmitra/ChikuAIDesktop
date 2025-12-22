import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  fetchSessions: () => ipcRenderer.invoke('fetch-sessions'),
  fetchUserData: () => ipcRenderer.invoke('fetch-user-data'),
  fetchResumes: () => ipcRenderer.invoke('fetch-resumes'),
  startInterviewSession: (sessionData: any) => ipcRenderer.invoke('start-interview-session', sessionData),
  endInterviewSession: () => ipcRenderer.invoke('end-interview-session'),
  setWindowOpacity: (opacity: number) => ipcRenderer.invoke('set-window-opacity', opacity),
  
  // Listen for auth status changes
  onAuthStatusChanged: (callback) => {
    ipcRenderer.on('auth-status-changed', (event, data) => callback(data));
  },
  
  // Listen for mode changes (dashboard/interview)
  onModeChanged: (callback: (data: any) => void) => {
    ipcRenderer.on('mode-changed', (event, data) => callback(data));
  }
});