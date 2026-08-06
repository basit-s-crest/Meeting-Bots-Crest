import { MeetBot } from '../join/meet-bot.js';
import { AudioCapture } from '../audio/audio-capture.js';
import { SpeakerDetector } from '../speaker/speaker-detector.js';
import { AudioChunker } from '../chunker/audio-chunker.js';
import { createOutput } from '../output/chunk-output.js';
import { generateAnnouncementMessage, parseChatCommand } from '../config/chat-service.js';
import { writeFile, readFile, unlink } from 'fs/promises';
import { createWriteStream } from 'fs';
import { join } from 'path';

export class BotLifecycle {
  constructor(config) {
    this.meetingUrl = config.meetingUrl;
    this.botName = config.botName || 'Meeting Bot';
    this.outputType = config.outputType || 'websocket';
    this.outputConfig = config.outputConfig || {};
    this.headless = config.headless !== false;
    this.channel = config.channel || null;
    this.authPath = config.authPath || null;
    
    this.bot = null;
    this.audioCapture = null;
    this.speakerDetector = null;
    this.chunker = null;
    this.output = null;
    this._state = 'idle';
    this.isPaused = false;
    this._chatMonitorInterval = null;
    this.processedChatMessages = new Set();
  }

  async start() {
    this.state = 'joining';
    
    this.bot = new MeetBot(this.meetingUrl, this.botName, {
      headless: this.headless,
      channel: this.channel,
      authPath: this.authPath
    });
    await this.bot.launch();

    const page = this.bot.getPage();
    this.audioCapture = new AudioCapture(page);
    await this.audioCapture.initialize();

    this.speakerDetector = new SpeakerDetector(page);
    await this.speakerDetector.initialize();

    await this.bot.join();

    // Wait a bit more for the call to fully establish
    console.log('Waiting for call to establish...');
    await this.bot.getPage().waitForTimeout(5000);

    // Check if actually in call (not waiting room)
    const inCall = await this.verifyInCall();
    if (!inCall) {
      console.log('Bot may be in waiting room. Waiting for host to admit...');
      await this.waitForAdmission();
      const admitted = await this.verifyInCall();
      if (!admitted) {
        throw new Error('Not admitted to meeting within timeout');
      }
    }

    this.state = 'in_call';
    await this.initializeCapture();

    this.state = 'capturing';

    // Auto-send chat announcement & start command listener immediately (non-blocking)
    this.sendChatAnnouncement().catch(err => console.warn('[BotLifecycle] sendChatAnnouncement error:', err.message));
    this.startChatCommandMonitor();
  }

  async verifyInCall() {
    const page = this.bot.getPage();
    try {
      // Multiple strategies to detect if we're in the call
      
      // 1. Check for participant grid (most reliable)
      const grid = await page.$('[role="list"][aria-label*="participant" i], [data-participant-list], [aria-label*="People" i]');
      if (grid && await grid.isVisible()) {
        console.log('Found participant grid - in call');
        return true;
      }
      
      // 2. Check for video tiles (remote participants)
      const videoTiles = await page.$('video:not([muted])');
      if (videoTiles && await videoTiles.isVisible()) {
        console.log('Found video tiles - in call');
        return true;
      }
      
      // 3. Check for call toolbar (leave button, mic, cam controls)
      const toolbar = await page.$('[data-call-toolbar], [aria-label*="call controls" i], button[aria-label*="Leave" i]');
      if (toolbar && await toolbar.isVisible()) {
        console.log('Found call toolbar - in call');
        return true;
      }
      
      // 4. Check for "Ask to join" button (means NOT in call)
      const askBtn = await page.$('button:has-text("Ask to join"):visible, button:has-text("Join now"):visible');
      if (askBtn && await askBtn.isVisible()) {
        console.log('Found Ask to Join button - NOT in call');
        return false;
      }
      
      // 5. Check for waiting room text
      const waitingText = await page.locator('text=/waiting for host|host will let you in|ask to join|lobby|waiting room/i').first();
      if (await waitingText.isVisible().catch(() => false)) {
        console.log('Found waiting room text - NOT in call');
        return false;
      }

      // 6. Check if there are other participants visible
      const participants = await page.$('[data-participant-id], [role="listitem"][aria-label*="participant" i]');
      if (participants && await participants.isVisible()) {
        console.log('Found participant elements - in call');
        return true;
      }

      console.log('Could not determine call state, assuming in call');
      return true;
    } catch (err) {
      console.log('Error verifying call state:', err.message);
      return false;
    }
  }

  async waitForAdmission(maxWaitMs = 120000) {
    const page = this.bot.getPage();
    const startTime = Date.now();
    
    while (Date.now() - startTime < maxWaitMs) {
      await page.waitForTimeout(5000);
      const inCall = await this.verifyInCall();
      if (inCall) {
        console.log('Admitted to meeting!');
        return true;
      }
      console.log('Still waiting for admission...');
    }
    return false;
  }

  async initializeCapture() {
    this.chunker = new AudioChunker();
    this.chunker.onChunk = (chunk) => this.output?.send(chunk);

    this.output = createOutput(this.outputType, this.outputConfig);
    await this.output.start();

    this.audioCapture.setCallbacks({
      onFrame: (frame) => {
        if (!this.isPaused) {
          this.chunker.addAudioFrame(frame);
        }
      },
      onError: (err) => console.error('Audio error:', err),
    });

    this.speakerDetector.setCallback((data) => {
      console.log(`[BotLifecycle] Speaker event received: "${data.speaker}" at ${data.timestamp}`);
      if (!this.isPaused) {
        this.chunker.addSpeakerEvent(data);   // still used for the chunk-level fallback speaker field
        this.output?.sendSpeakerEvent(data);  // NEW: precise, unquantized signal for the backend
      }
    });

    // Commented out auto-exit on empty meeting per user request.
    // The bot will only stop when manually canceled from the UI.
    /*
    this.speakerDetector.setEmptyCallback(() => {
      console.log('[BotLifecycle] Meeting is empty (only the bot remains). Shutting down bot...');
      this.stop();
    });
    */


    // Start with retry logic for audio capture
    await this.startAudioWithRetry();
    await this.speakerDetector.start();
  }

  async sendChatAnnouncement() {
    console.log('[BotLifecycle] [CHAT LOG] sendChatAnnouncement() invoked');
    if (process.env.ENABLE_CHAT_ANNOUNCEMENT === 'false') {
      console.log('[BotLifecycle] [CHAT LOG] ENABLE_CHAT_ANNOUNCEMENT is set to false. Skipping announcement.');
      return;
    }
    const msg = generateAnnouncementMessage({
      botName: this.botName,
    });
    console.log(`[BotLifecycle] [CHAT LOG] Sending draft announcement message:\n---\n${msg}\n---`);

    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await this.bot?.sendChatMessage(msg);
      if (result) {
        console.log('[BotLifecycle] [CHAT LOG] Announcement draft message sent successfully!');
        return;
      }
      if (attempt < 3) {
        console.log(`[BotLifecycle] [CHAT LOG] Retrying chat announcement (Attempt ${attempt + 1}/3)...`);
        await new Promise(r => setTimeout(r, 2000));
      }
    }
    console.warn('[BotLifecycle] [CHAT LOG] Failed to send announcement draft message after retries.');
  }

  startChatCommandMonitor() {
    if (this._chatMonitorInterval) return;
    this.processedChatMessages = new Set();
    console.log('[BotLifecycle] [CHAT LOG] In-call chat command monitor started (polling every 1s).');

    this._chatMonitorInterval = setInterval(async () => {
      if (this.state !== 'capturing' && this.state !== 'in_call') return;
      try {
        const messages = await this.bot?.readLatestChatMessages();
        if (messages && messages.length > 0) {
          for (const text of messages) {
            if (this.processedChatMessages.has(text)) continue;
            this.processedChatMessages.add(text);
            console.log(`[BotLifecycle] [CHAT LOG] New chat message detected: "${text}"`);

            const action = parseChatCommand(text);
            if (action) {
              console.log(`[BotLifecycle] [CHAT LOG] Matched slash command action: "${action}"`);
              await this.handleChatCommand(action);
            }
          }
        }
      } catch (err) {
        console.warn('[BotLifecycle] [CHAT LOG] Chat monitor error:', err.message);
      }
    }, 1000);
  }

  emitReason(reason) {
    if (this._reasonEmitted) return;
    this._reasonEmitted = true;
    console.log(`REASON: ${reason}`);
    if (typeof process !== 'undefined' && process.send) {
      try {
        process.send({ type: 'SESSION_REASON', reason });
      } catch (err) {
        console.warn('[BotLifecycle] Failed to send IPC reason:', err.message);
      }
    }
  }

  async handleChatCommand(action) {
    if (action === 'pause') {
      if (!this.isPaused) {
        this.isPaused = true;
        console.log('[BotLifecycle] Recording PAUSED via chat command.');
        await this.bot?.sendChatMessage(`[${this.botName}] Recording paused.`);
      }
    } else if (action === 'resume') {
      if (this.isPaused) {
        this.isPaused = false;
        console.log('[BotLifecycle] Recording RESUMED via chat command.');
        await this.bot?.sendChatMessage(`[${this.botName}] Recording resumed.`);
      }
    } else if (action === 'leave') {
      console.log('[BotLifecycle] LEAVE requested via chat command.');
      this.emitReason('chat_command_leave');
      await this.bot?.sendChatMessage(`[${this.botName}] Leaving meeting...`);
      await new Promise(r => setTimeout(r, 1000));
      await this.stop('chat_command_leave');
    }
  }

  async startAudioWithRetry(maxRetries = 10, delayMs = 2000) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        console.log(`Starting audio capture (attempt ${i + 1}/${maxRetries})...`);
        const started = await this.audioCapture.start();
        if (started) {
          console.log('Audio capture started successfully');
          return;
        }
      } catch (err) {
        console.log(`Audio capture failed: ${err.message}`);
      }
      await new Promise(r => setTimeout(r, delayMs));
    }
    throw new Error('Failed to start audio capture after retries');
  }

  async stop(explicitReason) {
    if (explicitReason) {
      this.emitReason(explicitReason);
    }
    this.state = 'ended';

    if (this._chatMonitorInterval) {
      clearInterval(this._chatMonitorInterval);
      this._chatMonitorInterval = null;
    }
    
    try {
      await this.audioCapture?.stop();
    } catch (err) {
      console.log('[BotLifecycle] AudioCapture stop warning:', err.message);
    }

    try {
      await this.speakerDetector?.stop();
    } catch (err) {
      console.log('[BotLifecycle] SpeakerDetector stop warning:', err.message);
    }

    this.chunker?.flush();
    await this.output?.stop();

    try {
      await this.bot?.leave();
    } catch (err) {
      console.log('[BotLifecycle] Bot leave warning:', err.message);
    }
  }

  get state() {
    return this._state;
  }

  set state(newValue) {
    this._state = newValue;
    if (this.stateChangeCallback) {
      try {
        this.stateChangeCallback(newValue);
      } catch (err) {
        console.error('State change callback error:', err);
      }
    }
  }

  getState() {
    return this._state;
  }

  onStateChange(callback) {
    this.stateChangeCallback = callback;
  }
}