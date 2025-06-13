const { app, BrowserWindow, ipcMain, systemPreferences, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const speech = require('@google-cloud/speech')
const record = require('node-record-lpcm16')
const textToSpeech = require('@google-cloud/text-to-speech')
const OpenAI = require('openai')
const { auth, checkUserPlan, getGoogleAuthDetails, signInWithCredential, GoogleAuthProvider } = require('./firebase-config')
const http = require('http')
const url = require('url')

// Global variables
let mainWindow = null
let recording = null
let isRecording = false
let recognizeStream = null
let currentTranscript = ''
let answerDebounceTimer = null
let currentUser = null
let userResume = null; // New: Global variable to store user's resume

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
const openai = new OpenAI({
  apiKey: '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', // Replace with your actual key before using
  maxRetries: 3, // Add retry logic
  timeout: 60000 // 60 second timeout for the overall client, not per request
});

// Add this near the top with other platform-specific code
const isWindows = process.platform === 'win32';

// Function to get credentials path that works in both dev and production
function getCredentialsPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  } else {
    return path.join(__dirname, 'lazy-job-seeker-4b29b-eb0b308d0ba7.json')
  }
}

// Initialize Google clients
const speechClient = new speech.SpeechClient({
  keyFilename: getCredentialsPath()
})

const ttsClient = new textToSpeech.TextToSpeechClient({
  keyFilename: getCredentialsPath()
})

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

function createRecognizeStream() {
  const request = {
    config: {
      encoding: 'WEBM_OPUS',  // Changed to match browser's MediaRecorder format
      sampleRateHertz: 48000, // Changed to match browser's MediaRecorder format (48kHz)
      languageCode: 'en-US',
      enableAutomaticPunctuation: true,
      model: 'default',
      useEnhanced: true,
      metadata: {
        interactionType: 'DISCUSSION',
        microphoneDistance: 'NEARFIELD',
        originalMediaType: 'AUDIO'
      },
      enableVoiceActivityDetection: false,
      maxAlternatives: 1
    },
    singleUtterance: false,
    interimResults: true
  }

  return speechClient
    .streamingRecognize(request)
    .on('error', error => {
      console.error('Error:', error)
      if (error.code === 11 && isRecording) {
        console.log('Stream timeout, creating new stream while preserving transcript')
        if (recognizeStream) {
          recognizeStream = createRecognizeStream()
        }
      }
      if (mainWindow) {
        mainWindow.webContents.send('transcript', currentTranscript)
      }
    })
    .on('data', data => {
      if (data.results[0]) {
        const result = data.results[0]
        const transcript = result.alternatives[0].transcript
        
        if (result.isFinal) {
          // For final results, append to the running transcript
          currentTranscript = (currentTranscript + ' ' + transcript).trim()
          if (mainWindow) {
            mainWindow.webContents.send('transcript', currentTranscript)
            // Removed automatic answer generation here
          }
        } else {
          // For interim results, show the current transcript plus the interim result
          // This gives the live transcription feel without modifying currentTranscript yet
          if (mainWindow) {
            const interimTranscript = (currentTranscript + ' ' + transcript).trim()
            mainWindow.webContents.send('transcript', interimTranscript)
            
            // Removed debounced answer generation here
          }
        }
      }
    })
}

// Update the toggle-recording handler to provide immediate feedback
ipcMain.on('toggle-recording', async (event, isStarting) => {
  // Clear timeout if there's any pending
  if (answerDebounceTimer) {
    clearTimeout(answerDebounceTimer);
    answerDebounceTimer = null;
  }

  // Handle recording start/stop based on explicit parameter
  if (isStarting) {
    // Starting a new recording session
    console.log('Starting new recording session');
    isRecording = true;
    // Reset transcript when starting a new recording
    currentTranscript = '';
    recognizeStream = createRecognizeStream();
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-started');
      // Send empty transcript to UI
      mainWindow.webContents.send('transcript', '');
    }
  } else {
    // Stopping recording - this should be fast
    console.log('Stopping recording and generating answer');
    isRecording = false;
    
    // Close the stream properly
    if (recognizeStream) {
      try {
        recognizeStream.end();
        recognizeStream = null;
      } catch (error) {
        console.error('Error ending recognizeStream:', error);
      }
    }
    
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('recording-stopped');
      
      // Get answer immediately for the current transcript
      if (currentTranscript && currentTranscript.trim().length > 0) {
        try {
          // Send a preliminary status message
          mainWindow.webContents.send('answer-status', 'Generating answer...');
          
          // Generate answer with shorter timeout
          await getOpenAIAnswer(currentTranscript);
        } catch (error) {
          console.error('Error generating answer:', error);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('answer', 'Error generating answer. Please try again.');
          }
        }
      } else {
        mainWindow.webContents.send('answer', 'No speech detected. Please try again.');
      }
    }
  }
});

// Add this handler for stream audio chunks with proper error handling
ipcMain.on('stream-audio-chunk', async (event, audioChunk) => {
  try {
    // Skip processing if we're not recording
    if (!isRecording) return;
    
    // Create recognizeStream if it doesn't exist
    if (!recognizeStream || recognizeStream.destroyed) {
      recognizeStream = createRecognizeStream();
      isRecording = true;
    }
    
    // Write the chunk to the stream
    if (recognizeStream && !recognizeStream.destroyed) {
      // Convert base64 audio chunk to buffer
      const audioBuffer = Buffer.from(audioChunk, 'base64');
      
      try {
        recognizeStream.write(audioBuffer);
      } catch (error) {
        console.error('Stream write error:', error);
        // Don't recreate the stream here to avoid infinite loops
        // Just log the error and let the next chunk attempt to fix if needed
      }
    }
  } catch (error) {
    console.error('Error processing audio chunk:', error);
  }
});

// Optimize the OpenAI answer function for speed
async function getOpenAIAnswer(transcript) {
  try {
    if (!transcript || transcript.trim().length === 0) {
      console.log('Empty transcript, not sending to OpenAI');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'I couldn\'t hear anything. Please try again.');
      }
      return;
    }

    console.log('Sending to OpenAI:', transcript);
    
    // Send status update
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('answer-status', 'Generating answer...');
    }

    // Try with faster model first
    const models = [
      'gpt-3.5-turbo', // Fall back to more reliable model
      'gpt-4o-mini'    // Try this first
    ];
    
    let completion = null;
    let modelIndex = 1; // Start with gpt-4o-mini
    let error = null;
    
    // New: Check if userResume is available
    if (!userResume) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('answer', 'Please provide your resume first by clicking the profile icon.');
        mainWindow.webContents.send('answer-status', 'Resume required');
      }
      return; // Exit function if no resume
    }

    const systemPrompt = `You are in the interview and your profile is: ${userResume}

    So you are getting questions from the interviewer so answer them like you are in interview. Make sure you are giving answers as per the profile given above. If any question asks, reply like a real candidate in an interview. Use very basic simple english, don\'t use perfect sentences, use normal sentences, give human type of response. If interviewer asks you to elaborate more then elaborate more, try to keep answer short as long as interviewer ask to elaborate. Also while you get a coding question make sure you give the code and explain every line side of the code by commenting, I mean every single line explain it so user can retype it in IDE or somewhere wherever interviewer asked and also it will be easy for him to explain code.`;
    
    while (!completion && modelIndex >= 0) {
      try {
        const model = models[modelIndex];
        console.log(`Trying model: ${model}`);
        
        completion = await openai.chat.completions.create({
          model: model,
          messages: [
            {
              role: 'system', 
              content: systemPrompt
            },
            {
              role: 'user',
              content: transcript
            }
          ],
          temperature: 0.3, // Lower temperature for more predictable outputs
          max_tokens: 100,  // Reduce token count for faster responses
          presence_penalty: 0,
          frequency_penalty: 0
        });
        
      } catch (err) {
        console.error(`Error with model ${models[modelIndex]}:`, err);
        error = err;
        modelIndex--; // Try the next model in the list
      }
    }

    if (completion?.choices?.[0]?.message?.content) {
      const answer = completion.choices[0].message.content;
      console.log('Received answer from OpenAI:', answer);
      
      // Explicitly send answer to UI
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('Sending answer to UI');
        mainWindow.webContents.send('answer', answer);
      } else {
        console.error('Main window not available for sending answer');
      }
    } else {
      console.error('No answer content in OpenAI response');
      
      // Send appropriate error message
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (error) {
          mainWindow.webContents.send('answer', `Sorry, I couldn\'t generate an answer: ${error.message}`);
        } else {
          mainWindow.webContents.send('answer', 'Could not generate an answer. Please try again.');
        }
      }
    }
  } catch (error) {
    console.error('OpenAI API error:', error);
    
    // Provide more specific error message
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
        mainWindow.webContents.send('answer', 'The connection to the AI service timed out. Please try again.');
      } else {
        mainWindow.webContents.send('answer', `Sorry, I couldn\'t generate an answer: ${error.message}`);
      }
    }
  }
}

// Add a new IPC event handler for stopping the stream
ipcMain.on('stop-audio-stream', () => {
  if (recognizeStream && !recognizeStream.destroyed) {
    isRecording = false;
    recognizeStream.end();
    recognizeStream = null;
  }
});

// Add this new function to reset transcript without creating a new chat
ipcMain.on('reset-transcript', () => {
  currentTranscript = '';
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('transcript', '');
  }
});

// Completely rework the IPC handler for toggling screen sharing mode
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
  
  // Update tracking variable
  isInScreenSharingMode = isScreenSharing;
  
  try {
    if (isScreenSharing) {
      console.log('Enabling screen sharing protection...');
      
      if (process.platform === 'darwin') {
        // macOS specific sequence
        mainWindow.setContentProtection(true);  // Changed from setExcludedFromCapture
          mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
          mainWindow.setAlwaysOnTop(true, "floating", 1);
          mainWindow.setWindowButtonVisibility(false);
          mainWindow.setOpacity(0.99);
          
        // Force window redraw
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
          
          setTimeout(() => {
            mainWindow.setBounds(bounds);
          mainWindow.setVibrancy('popover');
          setTimeout(() => {
            mainWindow.setVibrancy(null);
          }, 50);
        }, 10);
        
        app.dock.hide();
      } else if (process.platform === 'win32') {
        // Windows specific sequence
        mainWindow.setContentProtection(true);  // Changed from setExcludedFromCapture
          mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
        mainWindow.setSkipTaskbar(true);
        
        // Force window redraw on Windows
        const bounds = mainWindow.getBounds();
        mainWindow.setBounds({ 
          x: bounds.x, 
          y: bounds.y, 
          width: bounds.width + 1, 
          height: bounds.height 
        });
        
        setTimeout(() => {
          mainWindow.setBounds(bounds);
        }, 10);
      }
      
      mainWindow.webContents.send('screen-sharing-active', true);
      console.log('Screen sharing protection enabled');
      
    } else {
      console.log('Disabling screen sharing protection...');
      
      if (process.platform === 'darwin') {
        // macOS specific cleanup
        mainWindow.setOpacity(1.0);
          mainWindow.setWindowButtonVisibility(true);
          mainWindow.setVisibleOnAllWorkspaces(false);
        app.dock.show();
        mainWindow.setAlwaysOnTop(true, "floating", 1);
      } else if (process.platform === 'win32') {
        // Windows specific cleanup
        mainWindow.setSkipTaskbar(false);
        mainWindow.setAlwaysOnTop(true, "screen-saver", 1);
      }
      
      mainWindow.setContentProtection(false);  // Changed from setExcludedFromCapture
      
      // Force window redraw
          const bounds = mainWindow.getBounds();
          mainWindow.setBounds({ 
            x: bounds.x, 
            y: bounds.y, 
            width: bounds.width + 1, 
            height: bounds.height 
          });
      
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
      mainWindow.setContentProtection(false);  // Changed from setExcludedFromCapture
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

ipcMain.on('get-answer', async (event, transcript) => {
  await getOpenAIAnswer(transcript || currentTranscript)
})

ipcMain.on('new-chat', () => {
  currentTranscript = ''
  if (isRecording) {
    isRecording = false
    if (recording) {
      record.stop()
      recording = null
    }
    if (recognizeStream) {
      recognizeStream.end()
      recognizeStream = null
    }
    if (mainWindow) {
      mainWindow.webContents.send('recording-stopped')
    }
  }
  if (mainWindow) {
    mainWindow.webContents.send('transcript', '')
  }
})

ipcMain.on('recording-stopped', () => {
  if (mainWindow) {
    mainWindow.webContents.send('update-recording-status', false)
  }
})

// Handle audio data from renderer process
ipcMain.on('audio-data', async (event, base64Audio) => {
  try {
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

    // Convert audio to LINEAR16 format
    const request = {
      config: {
        encoding: 'WEBM_OPUS',  // Updated to match the browser's MediaRecorder format
        sampleRateHertz: 48000, // Updated to match MediaRecorder's default 48kHz
        languageCode: 'en-US',
        enableAutomaticPunctuation: true,
        model: 'default',
        useEnhanced: true,
      },
      audio: {
        content: audioBuffer
      }
    };

    console.log('Sending audio to Google Speech-to-Text...');
    // Process audio with Google Speech-to-Text
    const [response] = await speechClient.recognize(request);
    
    if (!response || !response.results || response.results.length === 0) {
      console.log('No transcription results available');
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', 'No speech detected. Please try again.');
      }
      return;
    }
    
    const transcription = response.results
      .map(result => result.alternatives[0].transcript)
      .join('\n');

    if (transcription) {
      console.log('Transcription:', transcription);
      currentTranscript = transcription;
      
      // Send transcription to renderer
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('transcript', transcription);
        // Automatically get answer from OpenAI
        await getOpenAIAnswer(transcription);
      }
    } else {
      console.log('No transcription available');
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

// Handle sign-in request
ipcMain.handle('sign-in', async () => {
  return new Promise(async (resolve, reject) => {
    try {
      console.log('Starting sign-in process...');
      const { authUrl, OAUTH_CLIENT_ID, CLIENT_SECRET, REDIRECT_URI } = getGoogleAuthDetails();

      let server;
      let serverClosed = false;

      // Create a local HTTP server to catch the redirect
      server = http.createServer(async (req, res) => {
        try {
          const requestUrl = url.parse(req.url, true);
          if (requestUrl.pathname === '/' && requestUrl.query.code) {
            const code = requestUrl.query.code;
            console.log('Authorization code received:', code);

            // Exchange the code for tokens
            const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                code,
                client_id: OAUTH_CLIENT_ID,
                client_secret: CLIENT_SECRET,
                redirect_uri: REDIRECT_URI,
                grant_type: 'authorization_code',
              }),
            });

            const tokens = await tokenResponse.json();
            console.log('Tokens received:', tokens);

            if (tokens.access_token) {
              const credential = GoogleAuthProvider.credential(null, tokens.access_token);
              const result = await signInWithCredential(auth, credential);
              currentUser = result.user;
              console.log('Firebase sign-in successful:', currentUser.email);

              const planCheck = await checkUserPlan(currentUser.uid);
              // Corrected: Extract boolean hasAccess directly
              const hasAccess = planCheck.hasAccess;

              // Close the server and respond to the browser
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>Authentication successful!</h1><p>You can close this window.</p></body></html>');
              if (server && !serverClosed) {
                server.close(() => console.log('Local server closed.'));
                serverClosed = true;
              }

              const finalResult = {
                success: true,
                hasAccess: hasAccess,
                user: {
                  email: currentUser.email,
                  uid: currentUser.uid
                },
                planName: planCheck.planName
              };
              console.log('IPC sign-in handler resolving with:', finalResult);
              resolve(finalResult);
            } else {
              res.writeHead(400, { 'Content-Type': 'text/html' });
              res.end('<html><body><h1>Authentication failed!</h1><p>No access token received.</p></body></html>');
              if (server && !serverClosed) {
                server.close(() => console.log('Local server closed.'));
                serverClosed = true;
              }
              reject(new Error('Authentication failed: No access token received'));
            }
          } else {
            res.writeHead(404);
            res.end();
          }
        } catch (error) {
          console.error('Error in local server request handler:', error);
          res.writeHead(500, { 'Content-Type': 'text/html' });
          res.end(`<html><body><h1>Authentication Error!</h1><p>${error.message}</p></body></html>`);
          if (server && !serverClosed) {
            server.close(() => console.log('Local server closed on error.'));
            serverClosed = true;
          }
          reject(error);
        }
      });

      server.listen(new URL(REDIRECT_URI).port || 80, () => {
        console.log(`Local server listening on ${REDIRECT_URI}`);
        shell.openExternal(authUrl).catch(err => {
          console.error('Failed to open external URL:', err);
          if (server && !serverClosed) {
            server.close(() => console.log('Local server closed due to external URL open error.'));
            serverClosed = true;
          }
          reject(new Error('Failed to open Google sign-in page in browser.'));
        });
      });

      // Set a timeout for the authentication process
      setTimeout(() => {
        if (server && !serverClosed) {
          server.close(() => console.log('Local server timed out and closed.'));
          serverClosed = true;
        }
        reject(new Error('Authentication timed out'));
      }, 300000); // 5 minutes timeout

    } catch (error) {
      console.error('Error occurred in handler for \'sign-in\':', error);
      reject(error);
    }
  });
});

ipcMain.handle('check-auth', async () => {
  if (!auth.currentUser) {
    return { isAuthenticated: false };
  }
  
  try {
    currentUser = auth.currentUser;
    const planCheck = await checkUserPlan(currentUser.uid);
    // Corrected: Extract boolean hasAccess directly
    const hasAccess = planCheck.hasAccess;

    const finalResult = {
      isAuthenticated: true,
      user: {
        email: currentUser.email,
        uid: currentUser.uid
      },
      hasAccess: hasAccess,
      planName: planCheck.planName
    };
    console.log('IPC check-auth handler resolving with:', finalResult);
    return finalResult;
  } catch (error) {
    console.error('Auth check error:', error);
    return { isAuthenticated: false, error: error.message };
  }
});

ipcMain.handle('sign-out', async () => {
  try {
    await auth.signOut();
    currentUser = null;
    return { success: true };
  } catch (error) {
    console.error('Sign-out error:', error);
    throw error;
  }
});

// New: IPC handler to save user profile
ipcMain.handle('save-user-profile', (event, resumeText) => {
  userResume = resumeText;
  console.log('User resume saved.');
  // Persist the resume to a file
  try {
    fs.writeFileSync(userProfilePath, JSON.stringify({ resume: userResume }));
    console.log('User profile persisted to disk.');
  } catch (error) {
    console.error('Failed to persist user profile:', error);
  }
  return true; // Acknowledge receipt
});

app.whenReady().then(() => {
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