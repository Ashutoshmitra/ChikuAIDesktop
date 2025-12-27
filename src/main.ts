import { app, BrowserWindow, shell, ipcMain, net, Tray, Menu, nativeImage, desktopCapturer, screen } from 'electron';
import { autoUpdater } from 'electron-updater';
import * as path from 'path';
import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';

// Data Models - copied from webapp
interface IInterviewSession {
  _id?: string;
  sessionId: string;
  userId: string;
  company: string;
  position: string;
  status: 'active' | 'completed' | 'expired';
  createdAt: Date;
  startedAt?: Date;
  endedAt?: Date;
  duration: number;
  transcription: string;
  sessionType?: 'free' | 'paid';
  maxDuration?: number;
}

interface IUser {
  _id: string;
  email: string;
  name: string;
  subscriptionTier: 'free' | 'starter' | 'standard' | 'pro';
  subscriptionStatus: 'active' | 'expired' | 'cancelled';
  remainingMinutes: number;
  totalMinutesUsed: number;
}

// API Response Types
interface AssemblyAITokenResponse {
  token: string;
}

interface ChatResponse {
  response: string;
}

interface ScreenAnalysisResponse {
  question: string;
  isCoding?: boolean;
}

class ChikuDesktopApp {
  private mainWindow: BrowserWindow | null = null;
  private collapsedWindow: BrowserWindow | null = null;
  private aiResponseWindow: BrowserWindow | null = null;
  private store: Store;
  private isInterviewMode: boolean = false;
  private isCollapsed: boolean = false;
  private originalBounds: any = null;
  private windowReadyForIPC: boolean = false;
  
  // Session tracking properties
  private currentSessionId: string | null = null;
  private sessionStartTime: Date | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private timerSessionId: string | null = null;
  private sessionStartingMinutes: number = 0; // Track starting minutes for this session
  
  // Simple countdown timer properties
  private currentRemainingSeconds: number = 0; // Track countdown seconds
  private lastServerSyncTime: number = 0; // Track when we last synced with server
  
  // Webapp backend configuration
  private readonly WEBAPP_BASE_URL = process.env.WEBAPP_BASE_URL || 'https://www.chiku-ai.in';

  constructor() {
    this.store = new Store({
      name: 'chiku-ai-desktop',
      clearInvalidConfig: true,
      // Use explicit config location for better consistency across environments
      cwd: app.getPath('userData'),
      fileExtension: 'json',
      serialize: JSON.stringify,
      deserialize: JSON.parse,
      defaults: {
        user: null,
        cachedRemainingMinutes: 0,
        appVersion: app.getVersion() // Track app version for debugging
      }
    });
    
    // Debug store location and contents for packaged app issues
    if (app.isPackaged) {
      console.log(`[PACKAGED DEBUG] Store path: ${this.store.path}`);
      console.log(`[PACKAGED DEBUG] Store contents:`, this.store.store);
    }
    
    this.setupApp();
  }
  
  private getAuthToken(): string | null {
    const user = this.store.get('user') as any;
    const token = user?.token || null;
    
    // Validate token is not expired for packaged app
    if (token && app.isPackaged) {
      try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        const now = Math.floor(Date.now() / 1000);
        if (payload.exp && payload.exp < now) {
          console.log('[PACKAGED DEBUG] Token expired, clearing user data');
          this.store.delete('user');
          this.store.delete('cachedRemainingMinutes');
          return null;
        }
      } catch (error) {
        console.log('[PACKAGED DEBUG] Invalid token, clearing user data');
        this.store.delete('user');
        this.store.delete('cachedRemainingMinutes');
        return null;
      }
    }
    
    return token;
  }
  
  private extractSubscriptionTier(token: string | null): string {
    if (!token) return 'free';
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      return payload.subscriptionTier || 'free';
    } catch (error) {
      return 'free';
    }
  }
  
  private async makeAuthenticatedRequest(endpoint: string, options: any = {}): Promise<any> {
    const token = this.getAuthToken();
    
    if (!token) {
      throw new Error('User not authenticated');
    }

    const url = `${this.WEBAPP_BASE_URL}${endpoint}`;
    
    return new Promise((resolve, reject) => {
      const request = net.request({
        method: options.method || 'GET',
        url: url
      });

      request.setHeader('Content-Type', 'application/json');
      request.setHeader('User-Agent', 'ChikuAI-Desktop/1.0');
      request.setHeader('Authorization', `Bearer ${token}`);

      // Add custom headers if provided
      if (options.headers) {
        Object.keys(options.headers).forEach(key => {
          request.setHeader(key, options.headers[key]);
        });
      }

      let responseData = '';

      request.on('response', (response) => {
        response.on('data', (chunk) => {
          responseData += chunk;
        });

        response.on('end', () => {
          try {
            if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
              const jsonData = JSON.parse(responseData);
              resolve(jsonData);
            } else {
              reject(new Error(`HTTP ${response.statusCode}: ${responseData}`));
            }
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error}`));
          }
        });
      });

      request.on('error', (error) => {
        reject(error);
      });

      // Send request body if provided
      if (options.body) {
        request.write(options.body);
      }

      request.end();
    });
  }

  private setupApp() {
    // Set app name and bundle ID for better protocol handling
    app.setName('Chiku AI Desktop');
    app.setAppUserModelId('com.chiku-ai.desktop');
    
    // Force set the app name for protocol registration
    // Note: Icon loading removed to prevent errors in packaged app

    // Enable single instance lock
    const gotTheLock = app.requestSingleInstanceLock();
    
    if (!gotTheLock) {
      app.quit();
      return;
    }

    // Register custom protocol for webapp authentication
    // Handle development mode properly - force override existing handlers
    let protocolRegistered = false;
    
    // Force remove any existing protocol handlers
    app.removeAsDefaultProtocolClient('chiku-ai-interview-assistant');
    
    if (process.defaultApp) {
      if (process.argv.length >= 2) {
        protocolRegistered = app.setAsDefaultProtocolClient(
          'chiku-ai-interview-assistant', 
          process.execPath, 
          [path.resolve(process.argv[1])]
        );
      }
    } else {
      protocolRegistered = app.setAsDefaultProtocolClient('chiku-ai-interview-assistant');
    }
    

    // Set up protocol handler before ready event
    app.on('will-finish-launching', () => {
      
      // Protocol handler for macOS
      app.on('open-url', (event, url) => {
        event.preventDefault();
        this.handleAuthCallback(url);
      });
    });

    app.whenReady().then(() => {
      this.setupPermissionHandlers();
      this.createMainWindow();
      this.setupIPC();
      this.setupAutoUpdater();
    });

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') {
        app.quit();
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        this.createMainWindow();
      }
    });

    // Handle Windows/Linux protocol calls
    app.on('second-instance', (event, commandLine) => {
      const protocolUrl = commandLine.find(arg => arg.startsWith('chiku-ai-interview-assistant://'));
      if (protocolUrl) {
        this.handleAuthCallback(protocolUrl);
      }
      
      // Focus main window
      if (this.mainWindow) {
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
      }
    });
  }

  private setupPermissionHandlers() {
    const { session, systemPreferences } = require('electron');
    
    // Permission handler that properly handles screen recording permission dialogs
    session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
      
      if (permission === 'media') {
        // Check if this is a screen capture request (empty mediaTypes array)
        if (details.mediaTypes && details.mediaTypes.length === 0) {
          
          // For screen capture on macOS, check if permission is already granted
          if (process.platform === 'darwin') {
            const screenAccess = systemPreferences.getMediaAccessStatus('screen');
            
            if (screenAccess === 'granted') {
              callback(true);
            } else if (screenAccess === 'denied') {
              callback(false);
            } else {
              // Status is 'not-determined' - let the system show the permission dialog
              callback(true);
            }
          } else {
            // Non-macOS platforms
            callback(true);
          }
        } else {
          // Regular media (microphone/camera) request
          callback(true);
        }
      } else if (permission === 'notifications') {
        callback(true);
      } else {
        callback(false);
      }
    });
  }


  private createMainWindow() {
    // Check auth status to determine proper window size
    const user = this.store.get('user') as any;
    const isAuthenticated = !!user;
    
    // Debug auth status for packaged app
    if (app.isPackaged) {
      console.log(`[PACKAGED DEBUG] Creating window - isAuthenticated: ${isAuthenticated}, user:`, user);
    }
    
    this.mainWindow = new BrowserWindow({
      width: 450,
      height: isAuthenticated ? 240 : 420, // Dashboard size if authenticated, login size if not
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      },
      resizable: false,
      title: 'Chiku AI Desktop',
      transparent: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true
    });

    // Set maximum always on top level like interview mode
    this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Hide from dock completely like interview mode
    if (process.platform === 'darwin') {
      app.dock.hide();
    }

    // Enable content protection to prevent screen capture
    this.mainWindow.setContentProtection(true);

    // Load the renderer - always use file to avoid webpack issues
    this.mainWindow.loadFile(path.join(__dirname, 'index.html'));
    
    const isDev = !app.isPackaged;

    // Add ready event listener for packaged app debugging
    this.mainWindow.webContents.once('dom-ready', () => {
      const user = this.store.get('user');
      const isAuthenticated = !!user;
      
      if (app.isPackaged) {
        console.log(`[PACKAGED DEBUG] Main window ready - auth: ${isAuthenticated}`);
      }
      
      // Send initial auth status
      this.mainWindow.webContents.send('auth-status-changed', { 
        isAuthenticated: isAuthenticated,
        user: user 
      });
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
  }

  private async transformToInterviewMode(sessionData: any) {
    if (!this.mainWindow || this.isInterviewMode) return;

    // Generate session ID and start tracking time
    this.currentSessionId = uuidv4();
    this.sessionStartTime = new Date();
    
    // Fetch current user data to get starting minutes
    try {
      const userDataResponse = await this.makeAuthenticatedRequest('/api/desktop-user');
      if (userDataResponse.success && userDataResponse.user) {
        this.sessionStartingMinutes = Number(userDataResponse.user.remainingMinutes) || 0;
        
        // Cache for paid users
        const user = this.store.get('user') as any;
        const subscriptionTier = user?.subscriptionTier || this.extractSubscriptionTier(user?.token);
        if (subscriptionTier !== 'free') {
          this.store.set('cachedRemainingMinutes', this.sessionStartingMinutes);
        }
      }
    } catch (error) {
      // Fallback to default minutes based on tier
      const user = this.store.get('user') as any;
      const subscriptionTier = user?.subscriptionTier || this.extractSubscriptionTier(user?.token);
      this.sessionStartingMinutes = subscriptionTier === 'free' ? 10 : 0;
    }
    
    try {
      // Create session via webapp backend API
      const sessionDoc = {
        company: sessionData.company,
        position: sessionData.position,
        sessionType: sessionData.sessionType || 'free'
      };
      
      const response = await this.makeAuthenticatedRequest('/api/desktop-sessions/create', {
        method: 'POST',
        body: JSON.stringify(sessionDoc)
      });
      
      // Use the sessionId returned by the webapp backend
      if (response.sessionId) {
        this.currentSessionId = response.sessionId;
      }
    } catch (error) {
      // Continue anyway for offline functionality
    }

    // Clear any existing timer before destroying window
    this.clearSessionTimer();

    // Store original window settings
    this.originalBounds = this.mainWindow.getBounds();
    
    // Completely recreate window as frameless overlay
    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const screenWidth = primaryDisplay.workAreaSize.width;
    const margin = 20;

    // Hide current window
    this.mainWindow.hide();
    
    // Hide from dock completely
    if (process.platform === 'darwin') {
      app.dock.hide();
    }

    // Recreate as frameless transparent overlay
    this.mainWindow.destroy();
    this.mainWindow = new BrowserWindow({
      width: 750,
      height: 120,
      x: screenWidth - 750 - margin,
      y: margin,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      }
    });
    
    // Set maximum always on top level
    this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Enable content protection
    this.mainWindow.setContentProtection(true);

    // Load the renderer
    this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Handle close event
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Wait for window to be ready then send mode change
    this.mainWindow.webContents.once('dom-ready', () => {
      
      // Add a small delay to ensure previous timer callbacks are done
      setTimeout(async () => {
        if (this.mainWindow && !this.mainWindow.isDestroyed() && this.mainWindow.webContents) {
          this.mainWindow.webContents.send('mode-changed', { 
            mode: 'interview',
            sessionData: {
              ...sessionData,
              sessionId: this.currentSessionId,
              startTime: this.sessionStartTime
            }
          });
          
          
          // Mark window as ready for IPC first, then start timer
          this.windowReadyForIPC = true;
          await this.startSessionTimer();
        }
      }, 100); // Reduced delay to minimize dashboard flash
    });

    this.isInterviewMode = true;
  }

  private async initializeCountdown() {
    const user = this.store.get('user') as any;
    
    // Extract subscription tier from JWT token if not in user object
    let subscriptionTier = user?.subscriptionTier;
    if (!subscriptionTier && user?.token) {
      try {
        const payload = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64').toString());
        subscriptionTier = payload.subscriptionTier;
      } catch (error) {
      }
    }
    
    const userTier = subscriptionTier || 'free';
    
    if (userTier === 'free') {
      // Free users: start with their allocated minutes
      this.currentRemainingSeconds = this.sessionStartingMinutes * 60;
    } else {
      // Paid users: start with their account minutes
      const cachedRemainingMinutes = Number(this.store.get('cachedRemainingMinutes')) || 0;
      this.currentRemainingSeconds = cachedRemainingMinutes * 60;
    }
    
    this.lastServerSyncTime = Date.now();
  }

  private async startSessionTimer() {
    // Clear any existing timer first
    this.clearSessionTimer();
    
    // Initialize countdown
    await this.initializeCountdown();
    
    // Store which session this timer belongs to
    this.timerSessionId = this.currentSessionId;
    
    this.sessionTimer = setInterval(async () => {
      // Check if this timer is still valid for the current session
      if (this.timerSessionId !== this.currentSessionId) {
        this.clearSessionTimer();
        return;
      }
      
      if (this.sessionStartTime && this.currentSessionId) {
        // Decrement countdown by 1 second
        this.currentRemainingSeconds = Math.max(0, this.currentRemainingSeconds - 1);
        
        const user = this.store.get('user') as any;
        let subscriptionTier = user?.subscriptionTier;
        if (!subscriptionTier && user?.token) {
          try {
            const payload = JSON.parse(Buffer.from(user.token.split('.')[1], 'base64').toString());
            subscriptionTier = payload.subscriptionTier;
          } catch (error) {
          }
        }
        
        const userTier = subscriptionTier || 'free';
        
        // Send timer update to renderer
        if (this.windowReadyForIPC && this.mainWindow && !this.mainWindow.isDestroyed() && 
            this.mainWindow.webContents && !this.mainWindow.webContents.isDestroyed()) {
          try {
            const remainingMinutes = Math.floor(this.currentRemainingSeconds / 60);
            const remainingSecs = this.currentRemainingSeconds % 60;
            
            const timerData = {
              type: userTier,
              elapsed: Math.floor((Date.now() - this.sessionStartTime.getTime()) / 1000 / 60),
              remaining: remainingMinutes,
              remainingSeconds: this.currentRemainingSeconds,
              display: `${remainingMinutes}:${remainingSecs.toString().padStart(2, '0')}`
            };
            
            this.mainWindow.webContents.send('session-timer-update', timerData);
            
            // End session when time is up
            if (this.currentRemainingSeconds <= 0) {
              this.endCurrentSession();
              return;
            }
            
            // Sync with server every 30 seconds for all users
            const timeSinceSync = Date.now() - this.lastServerSyncTime;
            if (timeSinceSync >= 30000) { // 30 seconds
              await this.syncWithServer();
            }
            
          } catch (error) {
            // If we consistently can't communicate with window, clear the timer
            if (error.message.includes('disposed') || error.message.includes('destroyed')) {
              this.clearSessionTimer();
            }
          }
        }
      } else {
        // No valid session data, clear the timer
        this.clearSessionTimer();
      }
    }, 1000);
  }
  
  private async syncWithServer() {
    try {
      const elapsedSeconds = Math.floor((Date.now() - this.sessionStartTime.getTime()) / 1000);
      const minutesUsedSoFar = Math.floor(elapsedSeconds / 60);
      
      // Skip sync if no minutes used yet
      if (minutesUsedSoFar <= 0) {
        this.lastServerSyncTime = Date.now();
        return;
      }
      
      // Update user's remaining minutes in DB
      const updateResponse = await this.makeAuthenticatedRequest('/api/desktop-sessions/update-realtime', {
        method: 'POST',
        body: JSON.stringify({
          sessionId: this.currentSessionId,
          minutesUsed: minutesUsedSoFar
        })
      });
      
      if (updateResponse.success && updateResponse.user) {
        // Just update cached value for reference, don't reset countdown
        const serverRemainingMinutes = updateResponse.user.remainingMinutes || 0;
        this.store.set('cachedRemainingMinutes', Number(serverRemainingMinutes) || 0);
        
        // End session when server says no minutes remaining
        if (serverRemainingMinutes <= 0) {
          this.endCurrentSession();
          return;
        }
      } else {
        // If update-realtime endpoint fails, try the regular update endpoint
        await this.makeAuthenticatedRequest('/api/desktop-sessions/update', {
          method: 'POST',
          body: JSON.stringify({
            sessionId: this.currentSessionId,
            minutesUsed: minutesUsedSoFar
          })
        });
      }
      
      this.lastServerSyncTime = Date.now();
    } catch (error) {
      // Continue with current countdown if sync fails
      this.lastServerSyncTime = Date.now(); // Still update sync time to avoid spam
    }
  }
  
  private clearSessionTimer() {
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.timerSessionId = null;
    this.currentRemainingSeconds = 0;
    this.lastServerSyncTime = 0;
  }

  private createAIResponseWindow() {
    if (this.aiResponseWindow) {
      // Focus existing window
      this.aiResponseWindow.focus();
      return;
    }

    const { screen } = require('electron');
    const primaryDisplay = screen.getPrimaryDisplay();
    const screenWidth = primaryDisplay.workAreaSize.width;
    const screenHeight = primaryDisplay.workAreaSize.height;
    const margin = 20;

    this.aiResponseWindow = new BrowserWindow({
      width: 500,
      height: 600,
      x: screenWidth - 500 - margin - 750 - margin, // Position to the left of main interview window
      y: margin,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: true,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      }
    });

    // Set maximum always on top level
    this.aiResponseWindow.setAlwaysOnTop(true, 'screen-saver');
    this.aiResponseWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Enable content protection
    this.aiResponseWindow.setContentProtection(true);

    // Create AI response HTML content
    const aiResponseHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
          }
          body {
            background: rgba(0, 0, 0, 0.95);
            color: white;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            border-radius: 12px;
            overflow: hidden;
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 255, 255, 0.2);
          }
          .ai-window-header {
            background: rgba(255, 255, 255, 0.1);
            border-bottom: 1px solid rgba(255, 255, 255, 0.2);
            padding: 12px 20px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            cursor: move;
            -webkit-app-region: drag;
          }
          .ai-window-title {
            color: white;
            font-size: 14px;
            font-weight: 600;
          }
          .ai-close-btn {
            background: rgba(255, 255, 255, 0.1);
            border: 1px solid rgba(255, 255, 255, 0.2);
            color: white;
            border-radius: 4px;
            padding: 4px 8px;
            font-size: 12px;
            cursor: pointer;
            -webkit-app-region: no-drag;
          }
          .ai-close-btn:hover {
            background: rgba(255, 255, 255, 0.2);
          }
          .ai-content {
            padding: 20px;
            max-height: calc(100vh - 60px);
            overflow-y: auto;
            font-size: 14px;
            line-height: 1.6;
          }
          .ai-content::-webkit-scrollbar {
            width: 6px;
          }
          .ai-content::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.1);
          }
          .ai-content::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.3);
            border-radius: 3px;
          }
          .ai-loading {
            display: flex;
            align-items: center;
            gap: 8px;
            color: rgba(255, 255, 255, 0.7);
          }
          .ai-loading-spinner {
            width: 16px;
            height: 16px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-top: 2px solid white;
            border-radius: 50%;
            animation: spin 1s linear infinite;
          }
          @keyframes spin {
            0% { transform: rotate(0deg); }
            100% { transform: rotate(360deg); }
          }
        </style>
      </head>
      <body>
        <div class="ai-window-header">
          <div class="ai-window-title">AI Response</div>
          <button class="ai-close-btn" onclick="closeAIWindow()">✕</button>
        </div>
        <div class="ai-content" id="aiContent">
          <div class="ai-loading">
            <div class="ai-loading-spinner"></div>
            Processing your request...
          </div>
        </div>
        <script>
          function closeAIWindow() {
            if (window.electronAPI && window.electronAPI.closeAIResponseWindow) {
              window.electronAPI.closeAIResponseWindow();
            }
          }
          
          if (window.electronAPI) {
            window.electronAPI.onAIResponseChunk((content) => {
              const aiContent = document.getElementById('aiContent');
              if (aiContent) {
                aiContent.innerHTML = content;
              }
            });
          }
        </script>
      </body>
      </html>
    `;

    // Write temp HTML file for AI response window
    const fs = require('fs');
    const tempAIPath = path.join(__dirname, 'ai-response.html');
    fs.writeFileSync(tempAIPath, aiResponseHTML);
    this.aiResponseWindow.loadFile(tempAIPath);

    // Handle close event
    this.aiResponseWindow.on('closed', () => {
      this.aiResponseWindow = null;
    });

    return this.aiResponseWindow;
  }

  private closeAIResponseWindow() {
    if (this.aiResponseWindow) {
      this.aiResponseWindow.close();
      this.aiResponseWindow = null;
    }
  }
  
  private async endCurrentSession() {
    if (this.currentSessionId && this.sessionStartTime) {
      const elapsedSeconds = Math.floor((new Date().getTime() - this.sessionStartTime.getTime()) / 1000); // seconds
      const elapsedMinutes = Math.floor(elapsedSeconds / 60); // minutes
      // Ensure minimum 1 minute to satisfy webapp backend validation
      const minutesToSend = Math.max(1, elapsedMinutes);
      
      try {
        // Update session in database and user's remaining minutes
        await this.updateSessionMinutes(this.currentSessionId, minutesToSend, elapsedSeconds);
      } catch (error) {
        // Debug auth errors in packaged app
        if (app.isPackaged && error.message && error.message.includes('401')) {
          console.log('[PACKAGED DEBUG] Auth error during session end, but preserving user session');
        }
      }
      
      // Clear timer and session data
      this.clearSessionTimer();
      this.currentSessionId = null;
      this.sessionStartTime = null;
    }
    
    // Return to dashboard mode (preserve auth state)
    this.transformToDashboardMode();
  }
  
  private async updateSessionMinutes(sessionId: string, minutesUsed: number, durationSeconds?: number) {
    try {
      // Always update session status and endTime, regardless of minutes used
      if (app.isPackaged) {
        console.log(`[PACKAGED DEBUG] Updating session: ${sessionId}, minutes: ${minutesUsed}, duration: ${durationSeconds}s`);
      }
      
      await this.makeAuthenticatedRequest('/api/desktop-sessions/update', {
        method: 'POST',
        body: JSON.stringify({
          sessionId,
          minutesUsed,
          duration: durationSeconds, // Send actual duration in seconds for display
          endedAt: new Date().toISOString(),
          status: 'completed'
        })
      });
      
      if (app.isPackaged) {
        console.log('[PACKAGED DEBUG] Session update successful');
      }
    } catch (error: any) {
      // Handle specific error cases
      if (app.isPackaged) {
        console.log(`[PACKAGED DEBUG] Session update error: ${error.message}`);
      }
      
      if (error.message && error.message.includes('403')) {
        // For free users who exhaust their minutes, we still consider the session successfully ended
        return;
      }
      
      // Don't clear user auth for other errors
      if (error.message && (error.message.includes('401') || error.message.includes('Invalid token'))) {
        if (app.isPackaged) {
          console.log('[PACKAGED DEBUG] Auth token issue but preserving user session');
        }
      }
    }
  }

  private transformToDashboardMode() {
    if (!this.mainWindow || !this.isInterviewMode) return;
    
    // End current session if still active
    if (this.currentSessionId) {
      this.endCurrentSession();
      return; // endCurrentSession will call this method again
    }

    // Clear any session timer and mark window as not ready for IPC
    this.clearSessionTimer();

    // Hide current frameless window
    this.mainWindow.hide();

    // Keep hidden from dock/taskbar like interview mode
    if (process.platform === 'darwin') {
      app.dock.hide();
    }

    // Check if user is still authenticated before setting window size
    const user = this.store.get('user');
    const isAuthenticated = !!user;
    
    // Recreate window with appropriate size based on auth status
    this.mainWindow.destroy();
    this.mainWindow = new BrowserWindow({
      width: 450,
      height: isAuthenticated ? 240 : 420, // Dashboard size if authenticated, login size if not
      x: this.originalBounds?.x || 100,
      y: this.originalBounds?.y || 100,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      },
      resizable: false,
      title: 'Chiku AI Desktop',
      transparent: false,
      frame: false,
      skipTaskbar: true,
      alwaysOnTop: true
    });

    // Set maximum always on top level like interview mode
    this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
    this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Enable content protection
    this.mainWindow.setContentProtection(true);

    // Load the renderer
    this.mainWindow.loadFile(path.join(__dirname, 'index.html'));

    // Handle close event
    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Wait for window to be ready then send mode change
    this.mainWindow.webContents.once('dom-ready', () => {
      // Check auth status and send appropriate mode
      const user = this.store.get('user');
      const isAuthenticated = !!user;
      
      this.mainWindow.webContents.send('mode-changed', { 
        mode: 'dashboard' 
      });
      
      // Send auth status to ensure UI is correct
      this.mainWindow.webContents.send('auth-status-changed', { 
        isAuthenticated: isAuthenticated,
        user: user 
      });
    });

    this.isInterviewMode = false;

    // Focus the window while staying hidden from dock
    this.mainWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }

  }

  private setupIPC() {
    // Handle login request
    ipcMain.handle('login', async () => {
      const loginUrl = 'https://www.chiku-ai.in/auth/signin?callbackUrl=/desktop-auth';
      await shell.openExternal(loginUrl);
    });

    // Auto-updater IPC handlers
    ipcMain.handle('check-for-updates', async () => {
      try {
        return await autoUpdater.checkForUpdates();
      } catch (error) {
        return null;
      }
    });
    
    ipcMain.handle('quit-and-install', () => {
      autoUpdater.quitAndInstall();
    });
    
    // Handle logout
    ipcMain.handle('logout', async () => {
      // Clear all user-related data including cached cooldown information
      this.store.delete('user');
      this.store.delete('cachedRemainingMinutes');
      
      // Clear any active session data
      this.currentSessionId = null;
      this.sessionStartTime = null;
      this.sessionStartingMinutes = 0;
      this.clearSessionTimer();
      
      if (this.mainWindow) {
        this.mainWindow.webContents.send('auth-status-changed', { isAuthenticated: false });
      }
    });

    // Get current auth status
    ipcMain.handle('get-auth-status', () => {
      const user = this.store.get('user');
      return {
        isAuthenticated: !!user,
        user: user || null
      };
    });

    // Get app version from package.json
    ipcMain.handle('get-app-version', () => {
      const packageJson = require('../package.json');
      return packageJson.version;
    });

    // Open external URL
    ipcMain.handle('open-external', async (_, url) => {
      await shell.openExternal(url);
    });

    // Fetch user's interview sessions
    ipcMain.handle('fetch-sessions', async () => {
      try {
        const response = await this.makeAuthenticatedRequest('/api/desktop-sessions');
        return response;
      } catch (error) {
        // Return empty sessions when API fails
        return {
          success: false,
          sessions: []
        };
      }
    });

    // Fetch user credits/remaining minutes
    ipcMain.handle('fetch-user-data', async () => {
      try {
        const response = await this.makeAuthenticatedRequest('/api/desktop-user');
        return response;
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });

    // Fetch user's resumes
    ipcMain.handle('fetch-resumes', async () => {
      try {
        const response = await this.makeAuthenticatedRequest('/api/desktop-resumes');
        return response;
      } catch (error) {
        // Return empty resumes when API fails
        return {
          success: false,
          resumes: []
        };
      }
    });

    // Fetch specific resume by ID
    ipcMain.handle('fetch-resume-by-id', async (event, resumeId) => {
      try {
        if (!resumeId) {
          return { success: false, error: 'Resume ID is required' };
        }
        const response = await this.makeAuthenticatedRequest(`/api/desktop-resume/${resumeId}`);
        return response;
      } catch (error) {
        return {
          success: false,
          error: error.message
        };
      }
    });

    // Start interview session (transform window)
    ipcMain.handle('start-interview-session', async (event, sessionData) => {
      try {
        await this.transformToInterviewMode(sessionData);
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // End interview session (restore to dashboard)
    ipcMain.handle('end-interview-session', async () => {
      try {
        this.transformToDashboardMode();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Set window opacity
    ipcMain.handle('set-window-opacity', async (event, opacity) => {
      try {
        if (this.mainWindow && this.isInterviewMode) {
          // Clamp opacity between 0.1 and 1.0
          const clampedOpacity = Math.max(0.1, Math.min(1.0, opacity));
          this.mainWindow.setOpacity(clampedOpacity);
          return { success: true, opacity: clampedOpacity };
        }
        return { success: false, error: 'Window not available or not in interview mode' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Collapse to logo
    ipcMain.handle('collapse-to-logo', async () => {
      try {
        this.collapseToLogo();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Expand from logo
    ipcMain.handle('expand-from-logo', async () => {
      try {
        this.expandFromLogo();
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Resize window for different screens
    ipcMain.handle('resize-window', async (event, width, height) => {
      try {
        if (this.mainWindow && !this.isInterviewMode) {
          this.mainWindow.setSize(width, height, true);
          return { success: true };
        }
        return { success: false, error: 'Window not available or in interview mode' };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // Permission Management APIs
    ipcMain.handle('request-microphone-permission', async () => {
      try {
        // This will be handled by the permission handler we'll set up
        return { success: true };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });



    ipcMain.handle('get-desktop-sources', async () => {
      try {
        
        // Get both screen and window sources
        const sources = await desktopCapturer.getSources({
          types: ['screen', 'window'],
          thumbnailSize: { width: 500, height: 500 }
        });
        
        // Filter out our own app window
        const filteredSources = sources.filter(source => 
          !source.name.toLowerCase().includes('chiku') && 
          !source.name.toLowerCase().includes('electron')
        );
        
        return { 
          success: true, 
          sources: filteredSources.map(source => ({
            id: source.id,
            name: source.name,
            thumbnail: source.thumbnail.toDataURL(),
            type: source.id.includes('screen:') ? 'screen' : 'window'
          }))
        };
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('capture-screen', async () => {
      try {
        
        // Get screen sources to get the source ID
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 150, height: 150 } // Small thumbnail, we don't need it
        });
        
        
        if (sources.length === 0) {
          return { success: false, error: 'No screen sources available' };
        }
        
        // Use the first (primary) screen
        const source = sources[0];
        
        // Return the source ID so renderer can capture with getUserMedia
        return { 
          success: true, 
          sourceId: source.id,
          sourceName: source.name
        };
        
      } catch (error) {
        return { success: false, error: error.message };
      }
    });

    // AssemblyAI Token API - Use webapp backend
    ipcMain.handle('get-assemblyai-token', async () => {
      try {
        const response = await this.makeAuthenticatedRequest('/api/assemblyai-token') as AssemblyAITokenResponse;
        return { success: true, token: response.token };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // OpenAI Chat API - Use webapp backend
    ipcMain.handle('generate-ai-response', async (event, data) => {
      try {
        
        const response = await this.makeAuthenticatedRequest('/api/chat', {
          method: 'POST',
          body: JSON.stringify(data)
        }) as ChatResponse;
        
        
        return { success: true, response: response.response };
      } catch (error: any) {
        return { success: false, error: 'Failed to get AI response from webapp backend' };
      }
    });

    // OpenAI Chat API with streaming - Use webapp backend
    ipcMain.handle('generate-ai-response-stream', async (event, data) => {
      try {
        
        const token = this.getAuthToken();
        if (!token) {
          throw new Error('User not authenticated');
        }

        const url = `${this.WEBAPP_BASE_URL}/api/chat`;
        const requestData = { ...data, stream: true };
        
        return new Promise((resolve, reject) => {
          const request = net.request({
            method: 'POST',
            url: url
          });

          request.setHeader('Content-Type', 'application/json');
          request.setHeader('User-Agent', 'ChikuAI-Desktop/1.0');
          request.setHeader('Authorization', `Bearer ${token}`);

          let responseData = '';

          request.on('response', (response) => {
            response.on('data', (chunk) => {
              responseData += chunk;
              
              // Parse streaming data
              const lines = responseData.split('\n');
              responseData = lines.pop() || ''; // Keep incomplete line for next chunk
              
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  const data = line.slice(6);
                  if (data === '[DONE]') {
                    resolve({ success: true });
                    return;
                  }
                  try {
                    const parsed = JSON.parse(data);
                    if (parsed.content) {
                      // Send streaming chunk to renderer
                      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                        this.mainWindow.webContents.send('ai-response-chunk', parsed.content);
                      }
                    }
                  } catch (e) {
                    // Ignore parsing errors
                  }
                }
              }
            });

            response.on('end', () => {
              resolve({ success: true });
            });
          });

          request.on('error', (error) => {
            reject(error);
          });

          request.write(JSON.stringify(requestData));
          request.end();
        });
        
      } catch (error: any) {
        return { success: false, error: 'Failed to get streaming AI response' };
      }
    });

    // Screen Analysis API - Use webapp backend
    ipcMain.handle('analyze-screen-content', async (event, imageData) => {
      try {
        
        if (!imageData) {
          return { success: false, error: 'Screen image data is required' };
        }


        const response = await this.makeAuthenticatedRequest('/api/analyze-screen', {
          method: 'POST',
          body: JSON.stringify({ imageData })
        }) as ScreenAnalysisResponse;
        
        
        return { 
          success: true,
          question: response.question,
          isCoding: response.isCoding || false
        };
      } catch (error: any) {
        return { success: false, error: 'Failed to analyze screen content via webapp backend' };
      }
    });

    // Debug relay from renderer
    ipcMain.handle('debug-log', (event, message) => {
      console.log('[RENDERER]', message);
    });

    // Check cooldown status for free users - always fetch fresh data from server
    ipcMain.handle('check-cooldown-status', async () => {
      try {
        const user = this.store.get('user') as any;
        if (!user) {
          return { 
            success: false, 
            error: 'User not authenticated',
            isInCooldown: false,
            cooldownInfo: null 
          };
        }

        // Always fetch fresh user data from server for cooldown checks
        const response = await this.makeAuthenticatedRequest('/api/desktop-user');
        if (response.success && response.user) {
          const userData = response.user;
          
          // Only apply cooldown logic for free tier users
          if (userData.subscriptionTier !== 'free') {
            return { 
              success: true, 
              isInCooldown: false,
              cooldownInfo: null,
              remainingMinutes: userData.remainingMinutes || 0
            };
          }
          
          // Check if free user is in cooldown based on webapp logic
          const now = new Date();
          const freeMinutesResetAt = userData.freeMinutesResetAt ? new Date(userData.freeMinutesResetAt) : null;
          const isInCooldown = freeMinutesResetAt && now < freeMinutesResetAt;
          
          let cooldownInfo = null;
          if (isInCooldown && freeMinutesResetAt) {
            const remainingCooldownMs = freeMinutesResetAt.getTime() - now.getTime();
            const remainingCooldownMinutes = Math.ceil(remainingCooldownMs / (1000 * 60));
            const remainingCooldownSeconds = Math.ceil(remainingCooldownMs / 1000) % 60;
            
            cooldownInfo = {
              resetAt: freeMinutesResetAt.toISOString(),
              remainingMs: remainingCooldownMs,
              remainingMinutes: remainingCooldownMinutes,
              remainingSeconds: remainingCooldownSeconds,
              display: `${remainingCooldownMinutes}:${remainingCooldownSeconds.toString().padStart(2, '0')}`
            };
          }
          
          return {
            success: true,
            isInCooldown,
            cooldownInfo,
            remainingMinutes: userData.remainingMinutes || 0
          };
        }
        
        return { 
          success: false, 
          error: 'Failed to fetch user data',
          isInCooldown: false,
          cooldownInfo: null 
        };
      } catch (error: any) {
        return { 
          success: false, 
          error: error.message,
          isInCooldown: false,
          cooldownInfo: null 
        };
      }
    });

    // Session Management APIs - Use webapp backend
    ipcMain.handle('update-session-minutes', async (event, sessionId, minutesUsed) => {
      try {
        await this.updateSessionMinutes(sessionId, minutesUsed);
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('save-transcript', async (event, sessionId, transcript) => {
      try {
        await this.makeAuthenticatedRequest('/api/desktop-sessions/transcript', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            transcript
          })
        });

        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // AI Response Window Management
    ipcMain.handle('open-ai-response-window', async () => {
      try {
        this.createAIResponseWindow();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('close-ai-response-window', async () => {
      try {
        this.closeAIResponseWindow();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('send-ai-response-content', async (event, content) => {
      try {
        if (this.aiResponseWindow && !this.aiResponseWindow.isDestroyed()) {
          this.aiResponseWindow.webContents.send('ai-response-content', content);
          return { success: true };
        }
        return { success: false, error: 'AI response window not available' };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // Resize interview window
    ipcMain.handle('resize-interview-window', async (event, width, height) => {
      try {
        if (this.mainWindow && this.isInterviewMode) {
          // Just resize without changing position
          this.mainWindow.setSize(width, height, true);
          return { success: true };
        }
        return { success: false, error: 'Window not available or not in interview mode' };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });
  }

  private collapseToLogo() {
    if (!this.mainWindow || this.isCollapsed) return;

    // Store original window bounds
    this.originalBounds = this.mainWindow.getBounds();

    // Hide main window
    this.mainWindow.hide();

    // Create collapsed window with logo
    this.collapsedWindow = new BrowserWindow({
      width: 100,
      height: 100,
      x: 50,
      y: 50,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      }
    });

    // Set maximum always on top level for visibility
    this.collapsedWindow.setAlwaysOnTop(true, 'screen-saver');
    this.collapsedWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    // Enable content protection to prevent screen capture like main window
    this.collapsedWindow.setContentProtection(true);

    // Create HTML file for collapsed window and load it like main window
    const logoHTML = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { 
            margin: 0; 
            padding: 0; 
            background: transparent; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            height: 100vh;
            cursor: pointer;
          }
          .logo-container {
            width: 80px;
            height: 80px;
            border-radius: 50%;
            background-image: url('hero_image.png');
            background-size: cover;
            background-position: center;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
            transition: transform 0.2s;
          }
          .logo-container:hover {
            transform: scale(1.1);
            box-shadow: 0 6px 25px rgba(0, 0, 0, 0.4);
          }
        </style>
      </head>
      <body>
        <div class="logo-container" onclick="expandFromLogo()"></div>
        <script>
          function expandFromLogo() {
            if (window.electronAPI && window.electronAPI.expandFromLogo) {
              window.electronAPI.expandFromLogo();
            }
          }
        </script>
      </body>
      </html>
    `;

    // Write temp HTML file and load it to access hero_image.png properly
    const fs = require('fs');
    const tempLogoPath = path.join(__dirname, 'collapsed-logo.html');
    fs.writeFileSync(tempLogoPath, logoHTML);
    this.collapsedWindow.loadFile(tempLogoPath);

    // Handle close event
    this.collapsedWindow.on('closed', () => {
      this.collapsedWindow = null;
      this.isCollapsed = false;
    });

    this.isCollapsed = true;
  }

  private expandFromLogo() {
    if (!this.collapsedWindow || !this.isCollapsed) return;

    // Close collapsed window
    this.collapsedWindow.close();
    this.collapsedWindow = null;

    // Show and restore main window with always-on-top behavior
    if (this.mainWindow) {
      this.mainWindow.show();
      if (this.originalBounds) {
        this.mainWindow.setBounds(this.originalBounds);
      }
      // Ensure it remains always on top
      this.mainWindow.setAlwaysOnTop(true, 'screen-saver');
      this.mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      this.mainWindow.focus();
      if (process.platform === 'darwin') {
        app.focus({ steal: true });
      }
    }

    this.isCollapsed = false;
  }

  private handleAuthCallback(url: string) {
    if (app.isPackaged) {
      console.log(`[PACKAGED DEBUG] Auth callback received: ${url}`);
    }
    
    if (url.includes('auth/success')) {
      if (app.isPackaged) {
        console.log('[PACKAGED DEBUG] Processing successful auth');
      }
      
      // Parse user data from URL
      let user: any = {
        id: Date.now().toString(),
        email: 'user@chiku-ai.in',
        name: 'Desktop User',
        authenticated: true,
        timestamp: Date.now()
      };

      try {
        const urlObj = new URL(url);
        const userParam = urlObj.searchParams.get('user');
        if (userParam) {
          const userData = JSON.parse(decodeURIComponent(userParam));
          user = {
            id: userData.id || user.id,
            email: userData.email || user.email,
            name: userData.name || user.name,
            image: userData.image,
            token: userData.token, // Store JWT token
            authenticated: true,
            timestamp: Date.now()
          };
        }
      } catch (error) {
      }

      // Clear any previous user's cached data before storing new user
      this.store.delete('cachedRemainingMinutes');
      
      // Clear any active session data from previous user
      this.currentSessionId = null;
      this.sessionStartTime = null;
      this.sessionStartingMinutes = 0;
      this.clearSessionTimer();
      
      // Store new user data
      this.store.set('user', user);

      if (app.isPackaged) {
        console.log('[PACKAGED DEBUG] User data stored successfully');
      }

      // Show the main window and bring it to front
      if (this.mainWindow) {
        // Resize window to dashboard size since user is now authenticated
        this.mainWindow.setSize(450, 240, true);
        this.mainWindow.show();
        if (this.mainWindow.isMinimized()) this.mainWindow.restore();
        this.mainWindow.focus();
        this.mainWindow.moveTop();
        
        // Force window to front on macOS
        app.focus({ steal: true });
        
        // Notify renderer about auth success
        this.mainWindow.webContents.send('auth-status-changed', { 
          isAuthenticated: true, 
          user 
        });
      } else {
        this.createMainWindow();
      }
    } else {
    }
  }
  
  private setupAutoUpdater() {
    // Always configure for public repos - no token needed
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: 'Ashutoshmitra',
      repo: 'ChikuAIDesktop'
    });
    
    // Enable automatic downloads and installation
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    
    // Start checking for updates automatically
    autoUpdater.checkForUpdatesAndNotify();
    
    // Set up periodic checks every 5 minutes
    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 5 * 60 * 1000);
    
    autoUpdater.on('checking-for-update', () => {
    });
    
    autoUpdater.on('update-available', (info) => {
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update-available', info);
      }
    });
    
    autoUpdater.on('update-not-available', (info) => {
    });
    
    autoUpdater.on('error', (err) => {
    });
    
    autoUpdater.on('download-progress', (progressObj) => {
      if (this.mainWindow) {
        this.mainWindow.webContents.send('download-progress', progressObj);
      }
    });
    
    autoUpdater.on('update-downloaded', (info) => {
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update-downloaded', info);
      }
      // Automatically install after download
      autoUpdater.quitAndInstall();
    });
  }
}

// Create app instance
new ChikuDesktopApp();