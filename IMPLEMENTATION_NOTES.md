# Chiku AI Desktop - Backend API Integration

## Overview
This refactored implementation uses the webapp backend for all API calls instead of direct third-party integrations, providing better security and maintainability.

## Features Implemented

### ✅ Real-time Audio Transcription
- **AssemblyAI Integration**: Uses AssemblyAI's Universal Streaming API v3 for real-time transcription
- **WebSocket Connection**: Direct connection to AssemblyAI streaming service
- **Audio Processing**: Captures microphone audio at 16kHz sample rate
- **Transcript Storage**: Saves transcripts to MongoDB using existing data models

### ✅ AI Answer Generation
- **OpenAI Integration**: Uses GPT-4o-mini for generating interview responses
- **Context Aware**: Analyzes transcript content to provide relevant answers
- **Coding Support**: Detects and handles coding interview questions differently
- **Professional Responses**: Generates natural, conversational answers

### ✅ Screen Analysis & Question Extraction
- **Screen Capture**: Uses Electron's desktopCapturer API
- **Vision AI**: OpenAI's vision model analyzes screenshots
- **Question Detection**: Automatically detects interview questions on screen
- **Auto-Answer**: Generates responses to detected questions

### ✅ Session Management
- **Real Timer**: Tracks actual session duration with minute-level precision
- **Database Integration**: Uses existing MongoDB collections (interviewsessions, users)
- **Remaining Minutes**: Updates user's remaining minutes in real-time
- **Session Persistence**: Saves session data and transcripts

### ✅ Permission Handling
- **Microphone Access**: Requests and handles microphone permissions
- **Screen Capture**: Manages screen capture permissions
- **Error Handling**: Graceful fallbacks when permissions are denied

## Technical Details

### Dependencies Added
```json
{
  "uuid": "^13.0.0"
}
```

### Environment Variables Required
```bash
WEBAPP_BASE_URL=https://www.chiku-ai.in
# API keys and database connections handled by webapp backend
```

### Key Files Modified

#### Main Process (`src/main.ts`)
- **Webapp Backend Integration**: All API calls now go through webapp backend
- **JWT Authentication**: Includes user token in all API requests
- **Session Management**: Creates and tracks sessions via webapp APIs
- **Security**: No direct API keys stored in desktop app

#### Preload (`src/preload.ts`)
- Exposed new APIs for audio/screen capture
- Added transcription and AI response APIs
- Session management APIs

#### Renderer (`src/renderer.html`)
- Replaced mock transcription with real AssemblyAI WebSocket connection
- Implemented real AI answer generation using transcript data
- Added screen capture and analysis functionality
- Real-time transcript display and storage

## Backend API Architecture
- **Existing APIs**: Uses webapp's `/api/chat`, `/api/assemblyai-token`, `/api/analyze-screen`
- **New APIs Needed**: `/api/sessions/create`, `/api/sessions/update`, `/api/sessions/transcript`
- **Authentication**: JWT token-based authentication for all requests
- **Security**: API keys and database access handled by webapp backend

## Audio Processing Pipeline
1. **Microphone Access**: `navigator.mediaDevices.getUserMedia()`
2. **Audio Context**: Creates 16kHz audio context for optimal AssemblyAI compatibility
3. **Real-time Processing**: Uses `ScriptProcessorNode` to stream audio data
4. **Format Conversion**: Converts Float32 to PCM16 format required by AssemblyAI
5. **WebSocket Streaming**: Sends binary audio data to AssemblyAI
6. **Turn-based Transcription**: Receives formatted transcripts with punctuation

## AI Response Generation
1. **Transcript Analysis**: Analyzes complete conversation transcript
2. **Question Extraction**: Identifies the most recent interview question
3. **Context Building**: Combines question with conversation history
4. **Response Generation**: Uses GPT-4o-mini with interview-specific prompts
5. **Natural Language**: Generates conversational, professional responses

## Screen Analysis Workflow
1. **Screen Capture**: Captures current screen at high resolution
2. **Image Analysis**: Sends screenshot to OpenAI's vision model
3. **Question Detection**: Identifies coding vs. behavioral questions
4. **Auto-Response**: Generates appropriate answers based on question type

## Session Management
- **Real Timing**: Tracks actual elapsed time from session start
- **Database Updates**: Saves duration and transcript to MongoDB
- **User Credits**: Updates user's remaining minutes in real-time
- **Automatic Termination**: Ends session when time limit reached

## Error Handling
- Graceful fallbacks for permission denials
- Retry mechanisms for network failures
- User-friendly error messages
- Maintains app functionality even if some features fail

## Setup Instructions
1. Copy `.env.example` to `.env` and fill in API keys
2. Install dependencies: `npm install`
3. Build the app: `npm run build`
4. Run: `npm start`

## Testing Checklist
- [ ] Microphone permission request works
- [ ] Real-time transcription displays correctly
- [ ] AI Answer generates relevant responses
- [ ] Screen capture and analysis functions
- [ ] Session timer counts down properly
- [ ] Database saves sessions and transcripts
- [ ] User remaining minutes update correctly
- [ ] App handles permission denials gracefully