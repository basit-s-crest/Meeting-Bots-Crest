# Zoom Browser-Automation Meeting Bot

This project is a browser-automation meeting bot that joins a Zoom meeting programmatically as a guest participant using Playwright, captures the call audio stream via browser API interception, performs active speaker detection, and outputs labeled 16kHz PCM audio chunks.

## Project Structure

```
Zoom/
├── src/
│   ├── audio/
│   │   └── audio-capture.js    # Hooks Web Audio API (AudioContext)
│   ├── chunker/
│   │   └── audio-chunker.js    # Packages and tags audio windows
│   ├── config/
│   │   └── selectors.js        # Obfuscation-resilient CSS selectors
│   ├── join/
│   │   └── zoom-bot.js         # Browser launch, navigation, audio opt-in
│   ├── lifecycle/
│   │   └── bot-lifecycle.js    # State machine and lobby transitions
│   ├── output/
│   │   └── chunk-output.js     # Chunks and manifest writer
│   └── index.js                # CLI runner and env loader
├── output/                     # Default output location for recordings
├── .env.template               # Template for configuration settings
├── package.json
└── README.md
```

## Setup Instructions

### 1. Install Dependencies
Make sure you have Node.js installed, then run:
```bash
npm install
```

### 2. Install Playwright Browsers
Install the required Chromium binaries:
```bash
npx playwright install chromium
```

### 3. Create Configuration File
Copy the env template file to `.env`:
```bash
cp .env.template .env
```
Open `.env` and fill out your target `MEETING_URL` and `MEETING_PASSCODE` (if required). You can also toggle `HEADLESS` to `false` during local development to watch the bot join and click through the UI.

---

## Running Headless on Linux (Ubuntu Server)

WebRTC and browser audio capture require a display server to function reliably. On headless Linux machines, run the bot inside a virtual display buffer (`Xvfb`):

1. Install `Xvfb` and system dependencies:
   ```bash
   sudo apt-get update
   sudo apt-get install -y xvfb libgbm1 libasound2
   ```

2. Run the bot using the virtual frame buffer wrapper:
   ```bash
   xvfb-run --server-args="-screen 0 1280x720x24" node src/index.js
   ```

---

## Output Architecture

By default, the bot outputs structured JSON files and audio to `Zoom/output/`:

```
Zoom/output/
  ├── manifest.json            # Central meeting info and chunk list index
  └── chunks/
        ├── c000000.json       # Metadata and base64 PCM data for chunk 0
        ├── c000001.json
        └── ...
```

### Chunk JSON Schema
Each chunk matches the Google Meet bot's schema:
```json
{
  "chunk_id": "c000001",
  "start_ts": 1730822401.25,
  "end_ts": 1730822401.50,
  "speaker": "Alice",
  "sample_rate": 16000,
  "channels": 1,
  "format": "pcm_s16le",
  "audio_base64": "..."
}
```

### Manifest Schema
```json
{
  "meeting_id": "1234567890",
  "started_at": "2026-07-06T06:30:00.000Z",
  "chunks": [
    {
      "chunk_id": "c000000",
      "start_ts": 1730822401.00,
      "end_ts": 1730822401.25,
      "speaker": null,
      "sample_rate": 16000,
      "channels": 1,
      "format": "pcm_s16le",
      "file_path": "./chunks/c000000.json"
    }
  ],
  "ended_at": "2026-07-06T06:35:00.000Z"
}
```

---

## Technical Notes

### 1. Web Audio Interception
The Zoom web client runs its media stack inside a WebAssembly (Wasm) sandbox, playing sound directly through Web Audio. This bot implements **monkey-patching** on the browser's `AudioContext` and `AudioNode.prototype.connect` prototypes. 
When the page tries to connect sound nodes to the speakers (`context.destination`), the bot interceptor mirrors the connection to a custom `MediaStreamAudioDestinationNode`. This allows us to retrieve a standard audio track and feed it into `MediaStreamTrackProcessor` to copy raw data frames.

### 2. Auto-Downsampling
Audio captured from the browser typically matches the hardware sample rate (44.1kHz or 48kHz). The interception script automatically downsamples audio frames to **16kHz 16-bit Mono PCM** in the browser thread before sending them over the Playwright bridge, reducing memory and messaging overhead.
