# Zoom Browser-Automation Meeting Bot

This project is a browser-automation meeting bot that joins a Zoom meeting programmatically as a guest participant using Playwright, captures the call audio stream via browser API interception, performs active speaker detection, and outputs labeled 16kHz PCM audio chunks.

## Project Structure

```
Zoom/
├── src/
│   ├── audio/
│   │   ├── audio-capture.js       # Hooks Web Audio API (AudioContext)
│   │   └── audio-processor.js     # Enhanced audio processing (VAD, noise reduction, normalization)
│   ├── chunker/
│   │   └── audio-chunker.js       # Packages and tags audio windows with enhanced metadata
│   ├── config/
│   │   └── selectors.js           # Obfuscation-resilient CSS selectors
│   ├── join/
│   │   └── zoom-bot.js            # Browser launch, navigation, audio opt-in
│   ├── lifecycle/
│   │   └── bot-lifecycle.js       # State machine and lobby transitions
│   ├── output/
│   │   └── chunk-output.js        # Chunks and manifest writer
│   ├── speaker/
│   │   ├── speaker-detector.js    # DOM-based speaker detection with confidence
│   │   └── audio-diarization.js   # Audio-based speaker identification fallback
│   └── index.js                   # CLI runner and env loader
├── output/                        # Default output location for recordings
├── .env.template                  # Template for configuration settings
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
Open `.env` and fill out your target `MEETING_URL` and optional settings:

- `MEETING_URL`: Full Zoom meeting URL (required)
- `BOT_NAME`: Display name in meeting (default: "Zoom Meeting Bot")
- `MEETING_PASSCODE`: Meeting password if required
- `HEADLESS`: Run browser in headless mode (default: true)
- `OUTPUT_TYPE`: 'file' or 'websocket' (default: file)
- `ENABLE_AUDIO_PROCESSING`: Enable enhanced audio features (default: true)
- `ENABLE_VAD`: Enable voice activity detection (default: true)
- `ENABLE_NOISE_REDUCTION`: Enable noise reduction (default: true)
- `ENABLE_NORMALIZATION`: Enable audio normalization (default: true)
- `ENABLE_ANTI_ALIASING`: Enable anti-aliasing filter (default: true)
- `ENABLE_AUDIO_DIARIZATION`: Enable audio-based speaker identification (default: true)

You can also toggle `HEADLESS` to `false` during local development to watch the bot join and click through the UI.

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
Each chunk includes enhanced metadata:
```json
{
  "chunk_id": "c000001",
  "start_ts": 1730822401.25,
  "end_ts": 1730822401.50,
  "speaker": "Alice",
  "speaker_confidence": 0.95,
  "speaker_source": "dom",
  "sample_rate": 16000,
  "channels": 1,
  "format": "pcm_s16le",
  "audio_base64": "...",
  "vad": {
    "is_voice": true,
    "confidence": 0.87
  },
  "audio_metrics": {
    "rms": 1523.45,
    "gain_applied": 1.23
  }
}
```

Fields:
- `speaker_confidence`: 0-1 confidence score for speaker identification
- `speaker_source`: Detection method (`dom` or `audio`)
- `vad`: Voice activity detection results
- `audio_metrics`: RMS energy and gain applied during processing

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

### 2. Enhanced Audio Processing
The bot now includes advanced audio processing features:

#### Voice Activity Detection (VAD)
- Automatically detects speech vs. silence based on audio energy
- Prevents recording of silent periods
- Provides confidence scores for voice detection

#### Noise Reduction
- Adaptive noise gate to remove background noise
- Spectral noise reduction based on initial noise profiling
- Automatic noise floor estimation

#### Anti-Aliasing Filter
- Low-pass Butterworth filter applied before downsampling
- Polyphase interpolation with Catmull-Rom splines
- Eliminates aliasing artifacts for cleaner audio

#### Audio Normalization
- Automatic level adjustment for consistent volume
- Smooth gain transitions to avoid abrupt changes
- Configurable target RMS and gain limits

### 3. Audio-Based Speaker Diarization
When DOM-based speaker detection fails, the bot falls back to audio-based speaker identification:

#### Feature Extraction
- Spectral centroid (voice brightness)
- Zero-crossing rate (voice characteristic)
- Energy distribution across frequency bands
- Pitch estimation via autocorrelation

#### Speaker Identification
- Similarity matching based on voice features
- Automatic creation of new speaker profiles
- Moving average for feature stability
- Confidence scoring based on consecutive detections

#### Speaker Persistence
- Tracks speakers across disconnects/reconnects
- Assigns persistent IDs to speakers
- Maintains speaker history and statistics

### 4. Enhanced Speaker Detection
DOM-based detection now includes:
- Confidence scores based on consecutive detections
- Multiple detection methods (banner, active tile, mic icon)
- Speaker persistence tracking with unique IDs
- Fallback to audio-based identification

### 5. Configuration Options
All audio processing features can be enabled/disabled via environment variables:
- `ENABLE_AUDIO_PROCESSING`: Master switch for all processing
- `ENABLE_VAD`: Voice activity detection
- `ENABLE_NOISE_REDUCTION`: Noise gate and spectral reduction
- `ENABLE_NORMALIZATION`: Audio level normalization
- `ENABLE_ANTI_ALIASING`: Anti-aliasing filter
- `ENABLE_AUDIO_DIARIZATION`: Audio-based speaker feature learning and fallback

### 6. Track Liveness & VAD Stability Enhancements
To handle long meetings with frequent speaker transitions, track changes, and participant mute/unmute events without dropping audio or losing transcripts, the bot implements the following mechanisms:

#### Track Reversion & Stability Guards
- **RMS History Decay**: Inactive tracks have their RMS histories decayed to zero at 1-second intervals. This prevents stale average energy from winning tie-breakers against new speaker tracks.
- **Hard Reversion Blocker**: The bot blocks any switch from a newer track back to an older track if the older track's most recent RMS reading is below the silence threshold (`RMS_SILENCE_THRESHOLD = 10`).
- **Immediate Dead Track Evaluation**: If the currently captured track produces two consecutive silent (0.00 RMS) chunks, candidate evaluation runs immediately rather than waiting for the next scheduled poll cycle.
- **Unbounded Map Cleanup**: Stale track metadata is automatically purged from liveness maps (`trackRMSHistory`, `trackFirstSeenTime`, `trackLastSeenTime`) when PeerConnection tracks fire `ended`/`removetrack` events or remain unseen in scans for over 60 seconds.

#### VAD-AGC Hysteresis Calibration
- **Low-Latency VAD**: Voice Activity Detection parameters are optimized for 500ms chunks (`vadMinSpeechFrames = 1`, `vadSilenceFrames = 2`), ensuring speech is detected instantly on the first chunk.
- **Noise Gate Safeguards**: The noise floor threshold is capped at `300.00` RMS, preventing quiet speech from corrupting the noise floor and getting muted by the noise gate.
- **Stable Gain Application**: Normalization gain levels are frozen during pauses/silence but still applied to output chunks, keeping volume levels stable during speaker transitions.

**Important Note on Audio Diarization:**
When enabled, audio diarization serves two purposes:
1. **Feature Learning**: Associates audio characteristics with known speaker names from DOM (primary mode)
2. **Fallback Identification**: Only creates generic "Speaker N" labels when DOM detection completely fails

This means you'll see actual participant names from Zoom as long as the DOM detection is working. Audio diarization runs in the background to learn voice characteristics for future fallback scenarios.

See `.env.template` for full configuration options.
