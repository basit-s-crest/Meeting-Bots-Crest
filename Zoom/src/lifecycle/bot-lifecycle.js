import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { ZoomBot } from '../join/zoom-bot.js';
import { AudioCapture } from '../audio/audio-capture.js';
import { SpeakerDetector } from '../speaker/speaker-detector.js';
import { AudioChunker } from '../chunker/audio-chunker.js';
import { createOutput } from '../output/chunk-output.js';
import { SELECTORS } from '../config/selectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class BotLifecycle {
  constructor(config) {
    this.meetingUrl = config.meetingUrl;
    this.botName = config.botName || 'Meeting Bot';
    this.passcode = config.passcode || null;
    this.outputType = config.outputType || 'file'; // default to file output
    this.outputConfig = config.outputConfig || {};
    this.headless = config.headless !== false;
    this.channel = config.channel || null;
    this.userDataDir = config.userDataDir || null;
    
    // Audio processing configuration
    this.audioProcessingConfig = {
      enableAudioProcessing: config.enableAudioProcessing !== false,
      enableVAD: config.enableVAD !== false,
      enableNoiseReduction: config.enableNoiseReduction !== false,
      enableNormalization: config.enableNormalization !== false,
      enableAntiAliasing: config.enableAntiAliasing !== false,
      enableAudioDiarization: config.enableAudioDiarization !== false
    };
    
    this.bot = null;
    this.audioCapture = null;
    this.speakerDetector = null;
    this.chunker = null;
    this.output = null;
    this.state = 'idle';
    this.stateChangeCallback = null;
  }

  async start() {
    this.transitionState('joining');
    
    // Start WebSocket / Output handler server early (before launching browser/joining)
    try {
      console.log('[Lifecycle] Starting early output handler of type "' + this.outputType + '" on port:', this.outputConfig.port || 8080);
      this.output = createOutput(this.outputType, this.outputConfig);
      await this.output.start();
      console.log('[Lifecycle] Early output handler started successfully.');
    } catch (err) {
      console.error('[Lifecycle] ERROR: Failed to start early output handler:', err.message || err);
      throw err;
    }
    
    this.bot = new ZoomBot(this.meetingUrl, this.botName, {
      headless: this.headless,
      channel: this.channel,
      userDataDir: this.userDataDir,
      passcode: this.passcode,
    });

    await this.bot.launch();

    // Pre-initialize capturing modules before joining to catch all context creations
    const page = this.bot.getPage();
    this.audioCapture = new AudioCapture(page);
    await this.audioCapture.initialize();

    this.speakerDetector = new SpeakerDetector(page, this.botName);
    await this.speakerDetector.initialize();

    await this.bot.join();

    console.log('[Lifecycle] Waiting for call connection...');
    await this.bot.getPage().waitForTimeout(5000);

    // Verify if in call or in waiting room
    const inCall = await this.verifyInCall();
    if (!inCall) {
      console.log('[Lifecycle] Bot is in waiting room or loading. Waiting for host to admit...');
      await this.waitForAdmission();
      const admitted = await this.verifyInCall();
      if (!admitted) {
        throw new Error('Not admitted to meeting within timeout window');
      }
    }

    this.transitionState('in_call');

    // Initialize capturing modules
    await this.initializeCapture();

    this.transitionState('capturing');
  }

  async verifyInCall() {
    try {
      // If we see the participants footer toggle or the leave button, we are in the call
      const leaveBtn = await this.bot.findLocator(SELECTORS.inCall.leaveBtn);
      const participantToggle = await this.bot.findLocator(SELECTORS.inCall.participantsToggle);

      if (leaveBtn || participantToggle) {
        console.log('[Lifecycle] In-call toolbar detected - inside meeting!');
        return true;
      }

      // Check for waiting room indicator
      const page = this.bot.getPage();
      const waitingText = await page.locator('text=/waiting for the host|host will let you in|please wait/i').first();
      if (await waitingText.isVisible().catch(() => false)) {
        console.log('[Lifecycle] Waiting room indicator text visible');
        return false;
      }

      return false;
    } catch (err) {
      console.log('[Lifecycle] Error verifying call state:', err.message);
      return false;
    }
  }

  async waitForAdmission(maxWaitMs = 120000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxWaitMs) {
      await this.bot.getPage().waitForTimeout(5000);
      const inCall = await this.verifyInCall();
      if (inCall) {
        console.log('[Lifecycle] Admitted to meeting by host!');
        return true;
      }
      console.log('[Lifecycle] Still waiting in lobby/waiting room...');
    }
    return false;
  }

  async initializeCapture() {
    // 1. Set up chunker with audio processing options & output callbacks linking to already running output
    this.chunker = new AudioChunker(this.audioProcessingConfig);
    this.chunker.onChunk = (chunk) => this.output?.send(chunk);

    // Log audio processing configuration
    console.log('[Lifecycle] Audio Processing Configuration:', this.audioProcessingConfig);

    // 2. Set callbacks on pre-initialized audio interceptor
    this.audioCapture.setCallbacks({
      onFrame: (frame) => this.chunker.addAudioFrame(frame),
      onError: (err) => console.error('[Lifecycle] Audio capture error:', err),
      onRMSUpdate: (trackId, rms) => this.audioCapture.onRMSUpdate(trackId, rms),
    });
    
    // Set RMS callback on chunker to report back to audio capture for liveness tracking
    this.chunker.onRMSUpdate = (trackId, rms) => {
      this.audioCapture.onRMSUpdate(trackId, rms);
    };

    // 3. Set callback on pre-initialized speaker observer with audio diarization sync
    this.speakerDetector.setCallback((data) => {
      // Add confidence and source to DOM-based speaker events
      this.chunker.addSpeakerEvent({
        speaker: data.speaker,
        timestamp: data.timestamp,
        confidence: data.confidence || 1.0,
        source: 'dom'
      });
    });

    // 4. Click the Audio Join button (satisfies autoplay permissions and connects stream)
    const audioConnected = await this.bot.connectAudio();
    if (!audioConnected) {
      throw new Error('Failed to connect to computer audio');
    }

    // 5. Start captures
    await this.audioCapture.start();
    await this.speakerDetector.start();
    console.log('[Lifecycle] Capture initialized and active with enhanced audio processing');

    // Diagnostic: take a screenshot of the active call after 10 seconds to inspect the view layout
    const page = this.bot.getPage();
    setTimeout(async () => {
      try {
        const debugDir = path.resolve(__dirname, '../../debug');
        fs.mkdirSync(debugDir, { recursive: true });
        const screenshotPath = path.join(debugDir, 'active-call.png');
        await page.screenshot({ path: screenshotPath });
        console.log(`[Lifecycle] Diagnostic screenshot of active call saved to: ${screenshotPath}`);
      } catch (e) {
        console.error('[Lifecycle] Diagnostic screenshot failed:', e.message);
      }
    }, 10000);
    
    // Periodic statistics logging
    setInterval(() => {
      if (this.state === 'capturing') {
        const stats = this.chunker.getStats();
        console.log(`[Lifecycle] Stats - Chunks: ${stats.totalChunks}, Voice: ${stats.voiceChunks}, Silence: ${stats.silenceChunks}, Avg Gain: ${stats.avgGain.toFixed(2)}x`);
      }
    }, 30000); // Every 30 seconds
  }

  async stop() {
    this.transitionState('ended');
    
    try {
      await this.audioCapture?.stop();
      await this.speakerDetector?.stop();
      this.chunker?.flush();
      await this.output?.stop();
      await this.bot?.leave();
    } catch (e) {
      console.error('[Lifecycle] Cleanup error during shutdown:', e.message);
    }
    
    this.transitionState('cleaned_up');
  }

  transitionState(newState) {
    this.state = newState;
    console.log(`[Lifecycle] State transition: ${newState}`);
    if (this.stateChangeCallback) {
      this.stateChangeCallback(newState);
    }
  }

  getState() {
    return this.state;
  }

  onStateChange(callback) {
    this.stateChangeCallback = callback;
  }
}
