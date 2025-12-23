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
  private store: Store;
  private isInterviewMode: boolean = false;
  private originalBounds: any = null;
  private windowReadyForIPC: boolean = false;
  
  // Session tracking properties
  private currentSessionId: string | null = null;
  private sessionStartTime: Date | null = null;
  private sessionTimer: NodeJS.Timeout | null = null;
  private timerSessionId: string | null = null;
  
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
      height: 650,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, 'preload.js'),
        webSecurity: true
      },
      resizable: false,
      title: 'Chiku AI Desktop',
      titleBarStyle: 'default',
      transparent: false,
      frame: true,
      skipTaskbar: false,
      alwaysOnTop: false
    });

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
    
    console.log(`[DEBUG] Interview window created. Initial opacity: ${this.mainWindow.getOpacity()}`);

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
      console.log('[DEBUG] DOM ready, window state:', {
        isVisible: this.mainWindow?.isVisible(),
        isMinimized: this.mainWindow?.isMinimized(),
        opacity: this.mainWindow?.getOpacity(),
        bounds: this.mainWindow?.getBounds()
      });
      
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
          
          console.log('[DEBUG] Mode changed sent, window state:', {
            isVisible: this.mainWindow.isVisible(),
            isMinimized: this.mainWindow.isMinimized(),
            opacity: this.mainWindow.getOpacity()
          });
          
          // Mark window as ready for IPC and start timer
          this.windowReadyForIPC = true;
          this.startSessionTimer();
        }
      }, 500); // 500ms delay to ensure previous callbacks are complete
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
        const elapsed = Math.floor((new Date().getTime() - this.sessionStartTime.getTime()) / 1000 / 60); // minutes
        
        // Check if session time limit reached (10 min for free, 60 for paid)
        const user = this.store.get('user') as any;
        const maxDuration = user?.subscriptionTier === 'free' ? 10 : 60;
        
        if (elapsed >= maxDuration) {
          console.log('Session time limit reached, ending session');
          this.endCurrentSession();
          return;
        }
        
        // Send timer update to renderer (with comprehensive safety checks)
        if (this.windowReadyForIPC && this.mainWindow && !this.mainWindow.isDestroyed() && 
            this.mainWindow.webContents && !this.mainWindow.webContents.isDestroyed()) {
          try {
            this.mainWindow.webContents.send('session-timer-update', {
              elapsed: elapsed,
              remaining: maxDuration - elapsed
            });
          } catch (error) {
            console.log('Timer update skipped - window communication error:', error.message);
            // If we consistently can't communicate with window, clear the timer
            if (error.message.includes('disposed') || error.message.includes('destroyed')) {
              console.log('Clearing timer due to window disposal');
              this.clearSessionTimer();
            }
          }
        }
      } else {
        // No valid session data, clear the timer
        console.log('No valid session data, clearing timer');
        this.clearSessionTimer();
      }
    }, 1000);
  }
  
  private clearSessionTimer() {
    this.windowReadyForIPC = false;
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
    } catch (error) {
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

    // Show in dock/taskbar again
    if (process.platform === 'darwin') {
      app.dock.show();
    }

    // Recreate as normal dashboard window
    this.mainWindow.destroy();
    this.mainWindow = new BrowserWindow({
      width: 450,
      height: 650,
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
      titleBarStyle: 'default',
      transparent: false,
      frame: true,
      skipTaskbar: false,
      alwaysOnTop: false
    });

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

    // Focus the window
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
      this.store.delete('user');
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
        console.log(`[DEBUG] setWindowOpacity called with opacity: ${opacity}`);
        if (this.mainWindow && this.isInterviewMode) {
          // Clamp opacity between 0.1 and 1.0
          const clampedOpacity = Math.max(0.1, Math.min(1.0, opacity));
          console.log(`[DEBUG] Setting window opacity to: ${clampedOpacity}`);
          this.mainWindow.setOpacity(clampedOpacity);
          return { success: true, opacity: clampedOpacity };
        }
        console.log(`[DEBUG] Window not available for opacity change. Window exists: ${!!this.mainWindow}, Interview mode: ${this.isInterviewMode}`);
        return { success: false, error: 'Window not available or not in interview mode' };
      } catch (error) {
        console.error('Error setting window opacity:', error);
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
        const response = await this.makeAuthenticatedRequest('/api/chat', {
          method: 'POST',
          body: JSON.stringify(data)
        }) as ChatResponse;
        
        return { success: true, response: response.response };
      } catch (error: any) {
        console.error('Error getting AI response from webapp backend:', error);
        return { success: false, error: 'Failed to get AI response from webapp backend' };
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

      // Store user data
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