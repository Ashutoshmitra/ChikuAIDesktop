import { app, BrowserWindow, shell, ipcMain } from 'electron';
import * as path from 'path';
import Store from 'electron-store';
import * as http from 'http';

class ChikuDesktopApp {
  private mainWindow: BrowserWindow | null = null;
  private store: Store;

  constructor() {
    this.store = new Store();
    this.setupApp();
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
      titleBarStyle: 'default'
    });

    // Enable content protection to prevent screen capture
    this.mainWindow.setContentProtection(true);

    // Load the renderer - always use file to avoid webpack issues
    this.mainWindow.loadFile(path.join(__dirname, '../src/renderer.html'));
    
    const isDev = !app.isPackaged;
    if (isDev) {
      this.mainWindow.webContents.openDevTools();
    }

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });
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