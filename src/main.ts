import { app, BrowserWindow, shell, ipcMain, net, Tray, Menu, nativeImage, desktopCapturer, screen } from 'electron';
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
  
  // Webapp backend configuration
  private readonly WEBAPP_BASE_URL = process.env.WEBAPP_BASE_URL || 'https://www.chiku-ai.in';

  constructor() {
    this.store = new Store();
    this.setupApp();
  }
  
  private getAuthToken(): string | null {
    const user = this.store.get('user') as any;
    return user?.token || null;
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
    
    console.log(`[MAIN] Protocol registration result: ${protocolRegistered}`);

    // Set up protocol handler before ready event
    app.on('will-finish-launching', () => {
      console.log('[MAIN] will-finish-launching - setting up protocol handler');
      
      // Protocol handler for macOS
      app.on('open-url', (event, url) => {
        console.log('[MAIN] ✅ open-url event received:', url);
        event.preventDefault();
        this.handleAuthCallback(url);
      });
    });

    app.whenReady().then(() => {
      this.createMainWindow();
      this.setupIPC();
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

  private createMainWindow() {
    this.mainWindow = new BrowserWindow({
      width: 450,
      height: 240,
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
    if (isDev) {
      this.mainWindow.webContents.openDevTools();
    }

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
        console.log(`[SESSION DEBUG] Starting session with ${this.sessionStartingMinutes} minutes available`);
        
        // Cache for paid users
        const user = this.store.get('user') as any;
        const subscriptionTier = user?.subscriptionTier || this.extractSubscriptionTier(user?.token);
        if (subscriptionTier !== 'free') {
          this.store.set('cachedRemainingMinutes', this.sessionStartingMinutes);
        }
      }
    } catch (error) {
      console.log('Error fetching initial user data for session:', error);
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
        console.log('Session created via webapp backend:', this.currentSessionId);
      }
    } catch (error) {
      console.error('Failed to create session via webapp backend:', error);
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
      width: 1000,
      height: 650,
      x: screenWidth - 1000 - margin,
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
      setTimeout(() => {
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
          this.startSessionTimer();
        }
      }, 100); // Reduced delay to minimize dashboard flash
    });

    this.isInterviewMode = true;
    console.log('Window transformed to interview mode');
  }

  private startSessionTimer() {
    // Clear any existing timer first
    this.clearSessionTimer();
    
    // Store which session this timer belongs to
    this.timerSessionId = this.currentSessionId;
    
    this.sessionTimer = setInterval(async () => {
      // Check if this timer is still valid for the current session
      if (this.timerSessionId !== this.currentSessionId) {
        console.log('Timer session mismatch, clearing timer');
        this.clearSessionTimer();
        return;
      }
      
      if (this.sessionStartTime && this.currentSessionId) {
        const elapsedSeconds = Math.floor((new Date().getTime() - this.sessionStartTime.getTime()) / 1000);
        const elapsed = Math.floor(elapsedSeconds / 60); // minutes
        
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
        
        // Send timer update to renderer (with comprehensive safety checks)
        
        if (this.windowReadyForIPC && this.mainWindow && !this.mainWindow.isDestroyed() && 
            this.mainWindow.webContents && !this.mainWindow.webContents.isDestroyed()) {
          try {
            // Use extracted subscription tier, default to free if unknown
            const userTier = subscriptionTier || 'free';
            
            if (userTier === 'free') {
              // Free users: countdown from their starting minutes
              const sessionTimeLimitSeconds = this.sessionStartingMinutes * 60; // starting minutes in seconds
              const remainingSeconds = Math.max(0, sessionTimeLimitSeconds - elapsedSeconds);
              const remainingMinutes = Math.floor(remainingSeconds / 60);
              const remainingSecs = remainingSeconds % 60;
              
              const timerData = {
                type: 'free',
                elapsed: elapsed,
                remaining: remainingSeconds / 60, // in minutes for compatibility
                remainingSeconds: remainingSeconds,
                display: `${remainingMinutes}:${remainingSecs.toString().padStart(2, '0')}`
              };
              this.mainWindow.webContents.send('session-timer-update', timerData);
              
              // End session when time is up
              if (remainingSeconds <= 0) {
                console.log(`Free session time limit (${this.sessionStartingMinutes} minutes) reached, ending session`);
                this.endCurrentSession();
                return;
              }
            } else {
              // Paid users: Update remaining minutes in real-time
              // Update DB every 30 seconds to avoid too many API calls, but show real-time countdown
              const shouldUpdateDB = elapsedSeconds % 30 === 0 && elapsedSeconds > 0;
              
              if (shouldUpdateDB) {
                try {
                  // Calculate minutes used in this session so far
                  const minutesUsedSoFar = Math.floor(elapsedSeconds / 60);
                  
                  // Update user's remaining minutes in DB
                  const updateResponse = await this.makeAuthenticatedRequest('/api/desktop-sessions/update-realtime', {
                    method: 'POST',
                    body: JSON.stringify({
                      sessionId: this.currentSessionId,
                      minutesUsed: minutesUsedSoFar
                    })
                  });
                  
                  if (updateResponse.success && updateResponse.user) {
                    // Update cached remaining minutes with latest from DB
                    const newRemainingMinutes = updateResponse.user.remainingMinutes || 0;
                    this.store.set('cachedRemainingMinutes', Number(newRemainingMinutes) || 0);
                    
                    // End session when no minutes remaining
                    if (newRemainingMinutes <= 0) {
                      console.log('Paid user minutes exhausted, ending session');
                      this.endCurrentSession();
                      return;
                    }
                  }
                } catch (error) {
                  console.log('Error updating real-time session minutes:', error);
                  // Continue with cached data for countdown display
                }
              }
              
              // For paid users, show remaining account time minus elapsed session time (in seconds)
              const cachedRemainingMinutes = Number(this.store.get('cachedRemainingMinutes')) || 0;
              const totalAccountSeconds = cachedRemainingMinutes * 60; // Convert account minutes to seconds
              const remainingSeconds = Math.max(0, totalAccountSeconds - elapsedSeconds); // Subtract elapsed seconds
              const remainingMins = Math.floor(remainingSeconds / 60);
              const remainingSecs = remainingSeconds % 60;
              
              const timerData = {
                type: 'paid',
                elapsed: elapsed,
                remaining: remainingMins, // remaining minutes for compatibility
                remainingSeconds: remainingSeconds,
                display: `${remainingMins}:${remainingSecs.toString().padStart(2, '0')} left`
              };
              this.mainWindow.webContents.send('session-timer-update', timerData);
              
              // End session when no time remaining
              if (remainingSeconds <= 0) {
                console.log('Paid user minutes exhausted during session, ending session');
                this.endCurrentSession();
                return;
              }
            }
          } catch (error) {
            console.log('Timer update skipped - window communication error:', error.message);
            // If we consistently can't communicate with window, clear the timer
            if (error.message.includes('disposed') || error.message.includes('destroyed')) {
              console.log('Clearing timer due to window disposal');
              this.clearSessionTimer();
            }
          }
        } else {
        }
      } else {
        // No valid session data, clear the timer
        console.log('No valid session data, clearing timer');
        this.clearSessionTimer();
      }
    }, 1000);
  }
  
  private clearSessionTimer() {
    // Only set windowReadyForIPC to false when actually ending session, not when restarting timer
    // this.windowReadyForIPC = false; // REMOVED - this was causing the bug
    if (this.sessionTimer) {
      clearInterval(this.sessionTimer);
      this.sessionTimer = null;
    }
    this.timerSessionId = null;
  }
  
  private async endCurrentSession() {
    if (this.currentSessionId && this.sessionStartTime) {
      const elapsed = Math.floor((new Date().getTime() - this.sessionStartTime.getTime()) / 1000 / 60); // minutes
      
      try {
        // Update session in database and user's remaining minutes
        await this.updateSessionMinutes(this.currentSessionId, elapsed);
        console.log(`Session ${this.currentSessionId} ended. Duration: ${elapsed} minutes`);
      } catch (error) {
        console.error('Error ending session:', error);
      }
      
      // Clear timer and session data
      this.clearSessionTimer();
      this.currentSessionId = null;
      this.sessionStartTime = null;
    }
    
    // Return to dashboard mode
    this.transformToDashboardMode();
  }
  
  private async updateSessionMinutes(sessionId: string, minutesUsed: number) {
    try {
      // Only update if we actually have minutes used (webapp doesn't accept 0)
      if (minutesUsed > 0) {
        await this.makeAuthenticatedRequest('/api/desktop-sessions/update', {
          method: 'POST',
          body: JSON.stringify({
            sessionId,
            minutesUsed,
            endedAt: new Date().toISOString(),
            status: 'completed'
          })
        });
        
        console.log(`Session ${sessionId} updated via webapp backend. Minutes used: ${minutesUsed}`);
      } else {
        console.log(`Session ${sessionId} ended with 0 minutes - skipping update`);
      }
    } catch (error: any) {
      // Handle specific error cases
      if (error.message && error.message.includes('403')) {
        console.log(`Session ${sessionId} update failed - user has insufficient minutes remaining. This is expected when free users exhaust their time.`);
        // For free users who exhaust their minutes, we still consider the session successfully ended
        return;
      }
      console.error('Error updating session minutes via webapp backend:', error);
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

    // Recreate as always-on-top dashboard window
    this.mainWindow.destroy();
    this.mainWindow = new BrowserWindow({
      width: 450,
      height: 240,
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
      this.mainWindow.webContents.send('mode-changed', { 
        mode: 'dashboard' 
      });
    });

    this.isInterviewMode = false;

    // Focus the window while staying hidden from dock
    this.mainWindow.focus();
    if (process.platform === 'darwin') {
      app.focus({ steal: true });
    }

    console.log('Window transformed to dashboard mode');
  }

  private setupIPC() {
    // Handle login request
    ipcMain.handle('login', async () => {
      const loginUrl = 'https://www.chiku-ai.in/auth/signin?callbackUrl=/desktop-auth';
      await shell.openExternal(loginUrl);
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
        console.error('Error fetching sessions:', error);
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
        console.error('Error fetching user data:', error);
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
        console.error('Error fetching resumes:', error);
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
        console.error('Error fetching resume by ID:', error);
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
        console.error('Error starting interview session:', error);
        return { success: false, error: error.message };
      }
    });

    // End interview session (restore to dashboard)
    ipcMain.handle('end-interview-session', async () => {
      try {
        this.transformToDashboardMode();
        return { success: true };
      } catch (error) {
        console.error('Error ending interview session:', error);
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
        console.error('Error setting window opacity:', error);
        return { success: false, error: error.message };
      }
    });

    // Collapse to logo
    ipcMain.handle('collapse-to-logo', async () => {
      try {
        this.collapseToLogo();
        return { success: true };
      } catch (error) {
        console.error('Error collapsing to logo:', error);
        return { success: false, error: error.message };
      }
    });

    // Expand from logo
    ipcMain.handle('expand-from-logo', async () => {
      try {
        this.expandFromLogo();
        return { success: true };
      } catch (error) {
        console.error('Error expanding from logo:', error);
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
        console.error('Error resizing window:', error);
        return { success: false, error: error.message };
      }
    });

    // Screen and Audio Capture APIs
    ipcMain.handle('request-permissions', async () => {
      try {
        // Request microphone access by trying to get sources
        await desktopCapturer.getSources({ types: ['screen'] });
        return { success: true };
      } catch (error) {
        console.error('Error requesting permissions:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('start-screen-capture', async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources.length > 0) {
          return { success: true, sourceId: sources[0].id };
        }
        return { success: false, error: 'No screen sources available' };
      } catch (error) {
        console.error('Error starting screen capture:', error);
        return { success: false, error: error.message };
      }
    });

    ipcMain.handle('capture-screen', async () => {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 }
        });
        
        if (sources.length > 0) {
          const source = sources[0];
          const dataUrl = source.thumbnail.toDataURL();
          return { success: true, imageData: dataUrl };
        }
        return { success: false, error: 'No screen sources available' };
      } catch (error) {
        console.error('Error capturing screen:', error);
        return { success: false, error: error.message };
      }
    });

    // AssemblyAI Token API - Use webapp backend
    ipcMain.handle('get-assemblyai-token', async () => {
      try {
        const response = await this.makeAuthenticatedRequest('/api/assemblyai-token') as AssemblyAITokenResponse;
        return { success: true, token: response.token };
      } catch (error: any) {
        console.error('Error getting AssemblyAI token from webapp backend:', error);
        return { success: false, error: error.message };
      }
    });

    // OpenAI Chat API - Use webapp backend
    ipcMain.handle('generate-ai-response', async (event, data) => {
      try {
        console.log('[AI RESPONSE DEBUG] Making request with data:', JSON.stringify(data, null, 2));
        
        const response = await this.makeAuthenticatedRequest('/api/chat', {
          method: 'POST',
          body: JSON.stringify(data)
        }) as ChatResponse;
        
        console.log('[AI RESPONSE DEBUG] Got response from backend:', JSON.stringify(response, null, 2));
        
        return { success: true, response: response.response };
      } catch (error: any) {
        console.error('[AI RESPONSE DEBUG] Error getting AI response from webapp backend:', error);
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
            console.error('Request error:', error);
            reject(error);
          });

          request.write(JSON.stringify(requestData));
          request.end();
        });
        
      } catch (error: any) {
        console.error('Error getting streaming AI response:', error);
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
        console.error('Screen analysis error from webapp backend:', error);
        return { success: false, error: 'Failed to analyze screen content via webapp backend' };
      }
    });

    // Debug relay from renderer
    ipcMain.handle('debug-log', (event, message) => {
      console.log(`[RENDERER] ${message}`);
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
        console.error('Error checking cooldown status:', error);
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
        console.error('Error updating session minutes:', error);
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
        console.error('Error saving transcript via webapp backend:', error);
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

    // Create HTML content for the collapsed window with logo
    const logoImagePath = path.join(__dirname, '..', 'public', 'hero_image.png').replace(/\\/g, '/');
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
            background-image: url('file://${logoImagePath}');
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

    // Write HTML to temp file and load it
    const tempHtmlPath = path.join(__dirname, 'collapsed-logo.html');
    require('fs').writeFileSync(tempHtmlPath, logoHTML);
    this.collapsedWindow.loadFile(tempHtmlPath);

    // Handle close event
    this.collapsedWindow.on('closed', () => {
      this.collapsedWindow = null;
      this.isCollapsed = false;
    });

    this.isCollapsed = true;
    console.log('Window collapsed to logo');
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
    console.log('Window expanded from logo');
  }

  private handleAuthCallback(url: string) {
    console.log('[AUTH] 🔔 Custom protocol callback received:', url);
    console.log('[AUTH] URL analysis:', {
      fullUrl: url,
      includesAuthSuccess: url.includes('auth/success'),
      protocol: url.split('://')[0],
      path: url.split('://')[1]
    });
    
    if (url.includes('auth/success')) {
      console.log('[AUTH] ✅ Processing auth success callback');
      
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
          console.log('[AUTH] 📋 Parsed user data from URL:', userData);
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
        console.log('[AUTH] ⚠️ Could not parse user data from URL, using defaults:', error);
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
      console.log('[AUTH] ✅ User data stored:', user);

      // Show the main window and bring it to front
      if (this.mainWindow) {
        console.log('[AUTH] 📱 Focusing existing main window');
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
        console.log('[AUTH] ✅ Auth status notification sent to renderer');
      } else {
        console.log('[AUTH] 🆕 Creating new main window');
        this.createMainWindow();
      }
    } else {
      console.log('[AUTH] ❌ URL does not contain auth/success - ignoring');
    }
  }
}

// Create app instance
new ChikuDesktopApp();