import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  login: () => ipcRenderer.invoke('login'),
  logout: () => ipcRenderer.invoke('logout'),
  getAuthStatus: () => ipcRenderer.invoke('get-auth-status'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  quitAndInstall: () => ipcRenderer.invoke('quit-and-install'),
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  fetchSessions: () => ipcRenderer.invoke('fetch-sessions'),
  fetchUserData: () => ipcRenderer.invoke('fetch-user-data'),
  fetchResumes: () => ipcRenderer.invoke('fetch-resumes'),
  fetchResumeById: (resumeId: string) => ipcRenderer.invoke('fetch-resume-by-id', resumeId),
  startInterviewSession: (sessionData: any) => ipcRenderer.invoke('start-interview-session', sessionData),
  endInterviewSession: () => ipcRenderer.invoke('end-interview-session'),
  setWindowOpacity: (opacity: number) => ipcRenderer.invoke('set-window-opacity', opacity),
  collapseToLogo: () => ipcRenderer.invoke('collapse-to-logo'),
  expandFromLogo: () => ipcRenderer.invoke('expand-from-logo'),
  resizeWindow: (width: number, height: number) => ipcRenderer.invoke('resize-window', width, height),
  debugLog: (message: string) => ipcRenderer.invoke('debug-log', message),
  
  // Permission and Capture APIs
  requestMicrophonePermission: () => ipcRenderer.invoke('request-microphone-permission'),
  getDesktopSources: () => ipcRenderer.invoke('get-desktop-sources'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  
  // Transcription APIs
  getAssemblyAIToken: () => ipcRenderer.invoke('get-assemblyai-token'),
  
  // AI Chat APIs
  generateAIResponse: (data: any) => ipcRenderer.invoke('generate-ai-response', data),
  generateAIResponseStream: (data: any) => ipcRenderer.invoke('generate-ai-response-stream', data),
  analyzeScreenContent: (imageData: string) => ipcRenderer.invoke('analyze-screen-content', imageData),
  
  // Session Management APIs
  updateSessionMinutes: (sessionId: string, minutesUsed: number) => ipcRenderer.invoke('update-session-minutes', sessionId, minutesUsed),
  saveTranscript: (sessionId: string, transcript: string) => ipcRenderer.invoke('save-transcript', sessionId, transcript),
  checkCooldownStatus: () => ipcRenderer.invoke('check-cooldown-status'),
  
  // Listen for auth status changes
  onAuthStatusChanged: (callback: (data: any) => void) => {
    ipcRenderer.on('auth-status-changed', (event, data) => callback(data));
  },
  
  // Listen for mode changes (dashboard/interview)
  onModeChanged: (callback: (data: any) => void) => {
    ipcRenderer.on('mode-changed', (event, data) => callback(data));
  },
  
  // Listen for audio data
  onAudioData: (callback: (data: ArrayBuffer) => void) => {
    ipcRenderer.on('audio-data', (event, data) => callback(data));
  },
  
  // Listen for transcript updates
  onTranscriptUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('transcript-update', (event, data) => callback(data));
  },
  
  // Listen for session timer updates
  onSessionTimerUpdate: (callback: (data: any) => void) => {
    ipcRenderer.on('session-timer-update', (event, data) => callback(data));
  },
  
  // Listen for AI response chunks (streaming)
  onAIResponseChunk: (callback: (chunk: string) => void) => {
    ipcRenderer.on('ai-response-chunk', (event, chunk) => callback(chunk));
  },
  
  // Auto-updater event listeners (temporary debug)
  onUpdateAvailable: (callback: (info: any) => void) => {
    ipcRenderer.on('update-available', (event, info) => callback(info));
  },
  
  onUpdateDownloaded: (callback: (info: any) => void) => {
    ipcRenderer.on('update-downloaded', (event, info) => callback(info));
  },
  
  onDownloadProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('download-progress', (event, progress) => callback(progress));
  }
});