const { app, BrowserWindow, ipcMain, systemPreferences, shell } = require('electron')
const path = require('path')
const fs = require('fs')

const OpenAI = require('openai')

const http = require('http')
const url = require('url')
const tmp = require('tmp');

// Global variables
let mainWindow = null
let recording = null
let isRecording = false
let currentTranscript = ''
let answerDebounceTimer = null
let currentUser = null
let userResume = null; // New: Global variable to store user's resume
// Add a variable to store the user-provided OpenAI key
let userOpenAIKey = null;

// Define path for user profile data
const userProfilePath = path.join(app.getPath('userData'), 'userProfile.json');

// Create a backup of window position and size for restoring
let windowState = {
  width: 500,
  height: 400,
  x: null,
  y: null
};

// Add this to track if we're in screen sharing mode
let isInScreenSharingMode = false;

// Initialize OpenAI client with simple configuration
// Remove the global openai instance

// Add this near the top with other platform-specific code
const isWindows = process.platform === 'win32';

// Update the createWindow function
function createWindow() {
  console.log('Creating main window...');
  // Configure window options with screen sharing compatibility in mind
  const windowOptions = {
    width: 500,
    height: 400,
    alwaysOnTop: true,
    transparent: false,
    frame: true,
    skipTaskbar: false,
    icon: path.join(__dirname, isWindows ? 'assets/icons/icon.ico' : 'assets/icons/icon.png'),
    backgroundColor: '#FFFFFF',
    titleBarStyle: 'default',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      webSecurity: true,
      show: true
    }
  };
  
  // Create the window
  mainWindow = new BrowserWindow(windowOptions);
  console.log('Main window created with options:', windowOptions);
  
  // Load the HTML file
  mainWindow.loadFile('index.html');
  
  // Set up window for screen exclusion compatibility
  if (process.platform === 'darwin') {
    mainWindow.once('ready-to-show', () => {
      console.log('Window ready-to-show on macOS');
      mainWindow.show();
      
      // Initialize with properties that make exclusion work better
      mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setWindowButtonVisibility(true);
      
      // Move to front to establish window layering
      app.dock.show();
      mainWindow.moveTop();
      
      // Ensure always on top is set
      mainWindow.setAlwaysOnTop(true, "floating", 1);
      
      console.log('Window setup complete on macOS');
    });
  } else if (isWindows) {
    // Windows-specific setup
    console.log('Setting up Windows-specific window properties');
    mainWindow.setSkipTaskbar(false);
    app.setAppUserModelId('com.lazyjobseeker.angel');
    
    // Ensure always on top is set for Windows
    mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
    
    console.log('Windows window setup complete');
  }
  
  console.log('Main window created');

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Remove recognizeStream, speechClient, and all related variables and functions
// Remove all code in ipcMain.on('toggle-recording') and ipcMain.on('stream-audio-chunk') related to streaming
// Only keep the logic for handling full audio in ipcMain.on('audio-data')

// In ipcMain.on('audio-data', ...):
//   - When audio is received, send it to OpenAI Whisper
//   - When Whisper returns, send the transcript to the renderer and then to OpenAI for the answer
//   - Show errors if Whisper fails

// Remove all code for loading/saving user profiles from disk
// ... existing code ...


app.whenReady().then(() => {
  // On app start, show a modal (via IPC) to request the resume from the user
  // Store the resume in memory for the session only
  // Only allow the assistant/chat UI to work after the resume is provided
  // Remove any references to the Google Cloud credentials JSON file
  // Remove all IPC handlers related to sign-in, check-auth, sign-out, and user profile persistence
  // Remove all code that references or uses firebase-config.js
  // Load user profile from disk on app start
  try {
    if (fs.existsSync(userProfilePath)) {
      const data = fs.readFileSync(userProfilePath, 'utf8');
      const profile = JSON.parse(data);
      if (profile.resume) {
        userResume = profile.resume;
        console.log('User resume loaded from disk.');
        // Send initial profile status to renderer if window exists
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('profile-status', true);
        }
      }
    }
  } catch (error) {
    console.error('Failed to load user profile:', error);
  }
  
  createWindow();
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error)
})

process.on('unhandledRejection', (error) => {
  console.error('Unhandled Rejection:', error)
})

// Add IPC handler to receive and update the API key from the renderer
ipcMain.on('set-openai-key', (event, key) => {
  userOpenAIKey = key && key.trim() ? key.trim() : null;
  console.log('Received new OpenAI API key from UI:', userOpenAIKey ? '[REDACTED]' : '[empty]');
});

ipcMain.on('audio-data', async (event, base64Audio) => {
  try {
    if (!userOpenAIKey) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'Please set your OpenAI API key using the gear icon.');
      }
      return;
    }
    // Use the user-provided key for all OpenAI requests
    const OpenAI = require('openai');
    const openai = new OpenAI({
      apiKey: userOpenAIKey,
      maxRetries: 3,
      timeout: 60000
    });
    if (!base64Audio) {
      console.error('No audio data received');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'Error: No audio data received');
      }
      return;
    }
    const audioBuffer = Buffer.from(base64Audio, 'base64');
    console.log('Received audio data from renderer, size:', audioBuffer.length);
    if (audioBuffer.length < 100) {
      console.error('Audio buffer too small, likely empty recording');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
      return;
    }
    // Write buffer to temp file and send as stream to Whisper
    let response;
    const tmpFile = tmp.fileSync({ postfix: '.webm' });
    fs.writeFileSync(tmpFile.name, audioBuffer);
    try {
      console.log('Sending audio to OpenAI Whisper API...');
      response = await openai.audio.transcriptions.create({
        file: fs.createReadStream(tmpFile.name),
        model: "whisper-1",
        language: "en",
        response_format: "text"
      });
      console.log('Whisper API response:', response);
    } catch (error) {
      console.error('OpenAI Whisper API error:', error);
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'Transcription failed: ' + error.message);
      }
      tmpFile.removeCallback();
      return;
    }
    tmpFile.removeCallback();
    const transcription = response;
    console.log('Transcription result:', transcription);
    if (transcription && transcription.trim()) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Sending transcript to renderer...');
        mainWindow.webContents.send('transcript', transcription);
      }
      // Now get the answer from OpenAI
      try {
        if (!userResume) {
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer', 'Please provide your resume first.');
          }
          return;
        }
        const systemPrompt = `You are in the interview and your profile is: ${userResume}\n\nSo you are getting questions from the interviewer so answer them like you are in interview. Make sure you are giving answers as per the profile given above. If any question asks, reply like a real candidate in an interview. Use very basic simple english, don\'t use perfect sentences, use normal sentences, give human type of response. If interviewer asks you to elaborate more then elaborate more, try to keep answer short as long as interviewer ask to elaborate. Also while you get a coding question make sure you give the code and explain every line side of the code by commenting, I mean every single line explain it so user can retype it in IDE or somewhere wherever interviewer asked and also it will be easy for him to explain code.`;
        console.log('Sending transcript to OpenAI for answer...');
        const completion = await openai.chat.completions.create({
          model: 'gpt-4o-mini',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: transcription }
          ],
          temperature: 0.3,
          max_tokens: 300
        });
        const answer = completion.choices?.[0]?.message?.content || '';
        console.log('OpenAI answer:', answer);
        if (mainWindow && !mainWindow.isDestroyed()) {
          console.log('Sending answer to renderer...');
          mainWindow.webContents.send('answer', answer);
        }
      } catch (error) {
        console.error('OpenAI answer error:', error);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('answer', 'Error generating answer: ' + error.message);
        }
      }
    } else {
      console.log('No transcription available or empty result');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
    }
  } catch (error) {
    console.error('Error processing audio:', error);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('transcript', `Error: ${error.message || 'Unknown error'}`);
    }
  }
});

ipcMain.on('toggle-screen-sharing-mode', (event, isScreenSharing) => {
  console.log(`Toggle screen sharing mode called with: ${isScreenSharing}`);
  if (!mainWindow) {
    console.error('Main window is null when trying to toggle screen sharing mode');
    return;
  }
  // Get current window position and size if not in sharing mode already
  if (!isInScreenSharingMode) {
    const position = mainWindow.getPosition();
    const size = mainWindow.getSize();
    windowState = {
      width: size[0],
      height: size[1],
      x: position[0],
      y: position[1]
    };
    console.log('Saved window state:', windowState);
  }
  isInScreenSharingMode = isScreenSharing;
  try {
    if (isScreenSharing) {
      console.log('Enabling screen sharing protection...');
      if (process.platform === 'darwin') {
        mainWindow.setContentProtection(true);
        mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        mainWindow.setAlwaysOnTop(true, "floating", 1);
        mainWindow.setWindowButtonVisibility(false);
        mainWindow.setOpacity(0.99);
        // Force window redraw
        const bounds = mainWindow.getBounds();
        mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
        setTimeout(() => {
          mainWindow.setBounds(bounds);
          mainWindow.setVibrancy('popover');
          setTimeout(() => {
            mainWindow.setVibrancy(null);
          }, 50);
        }, 10);
        app.dock.hide();
      } else if (process.platform === 'win32') {
        mainWindow.setContentProtection(true);
        mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
        mainWindow.setSkipTaskbar(true);
        // Force window redraw
        const bounds = mainWindow.getBounds();
        mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
        setTimeout(() => {
          mainWindow.setBounds(bounds);
        }, 10);
      }
      mainWindow.webContents.send('screen-sharing-active', true);
      console.log('Screen sharing protection enabled');
    } else {
      console.log('Disabling screen sharing protection...');
      if (process.platform === 'darwin') {
        mainWindow.setOpacity(1.0);
        mainWindow.setWindowButtonVisibility(true);
        mainWindow.setVisibleOnAllWorkspaces(false);
        app.dock.show();
        mainWindow.setAlwaysOnTop(true, "floating", 1);
      } else if (process.platform === 'win32') {
        mainWindow.setSkipTaskbar(false);
        mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
      }
      mainWindow.setContentProtection(false);
      // Force window redraw
      const bounds = mainWindow.getBounds();
      mainWindow.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width + 1, height: bounds.height });
      setTimeout(() => {
        mainWindow.setBounds(bounds);
      }, 10);
      mainWindow.webContents.send('screen-sharing-active', false);
      console.log('Screen sharing protection disabled');
    }
  } catch (error) {
    console.error('Error toggling screen sharing mode:', error);
    // Attempt to restore window state
    try {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setContentProtection(false);
      if (process.platform === 'darwin') {
        app.dock.show();
      } else if (process.platform === 'win32') {
        mainWindow.setSkipTaskbar(false);
      }
    } catch (restoreError) {
      console.error('Failed to restore window state:', restoreError);
    }
  }
});