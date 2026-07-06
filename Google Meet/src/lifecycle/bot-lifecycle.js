import { MeetBot } from '../join/meet-bot.js';
import { AudioCapture } from '../audio/audio-capture.js';
import { SpeakerDetector } from '../speaker/speaker-detector.js';
import { AudioChunker } from '../chunker/audio-chunker.js';
import { createOutput } from '../output/chunk-output.js';
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
    this.userDataDir = config.userDataDir || null;
    
    this.bot = null;
    this.audioCapture = null;
    this.speakerDetector = null;
    this.chunker = null;
    this.output = null;
    this._state = 'idle';
    
    this.pcmStream = null;
    this.pcmPath = null;
    this.wavTimer = null;
    this.totalBytesWritten = 0;
  }

  async start() {
    this.state = 'joining';
    
    this.bot = new MeetBot(this.meetingUrl, this.botName, {
      headless: this.headless,
      channel: this.channel,
      userDataDir: this.userDataDir
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

    // Set up live raw PCM file writing (guarantees data survival even on hard Ctrl+C)
    const filename = `session_capture_${Date.now()}.pcm`;
    this.pcmPath = join(process.cwd(), filename);
    this.pcmStream = createWriteStream(this.pcmPath);
    this.totalBytesWritten = 0;
    console.log(`[BotLifecycle] Saving live raw PCM audio to: ${this.pcmPath}`);

    this.audioCapture.setCallbacks({
      onFrame: (frame) => {
        this.chunker.addAudioFrame(frame);
        if (frame.data && frame.data.length > 0) {
          const buffer = Buffer.from(new Int16Array(frame.data).buffer);
          this.pcmStream.write(buffer);
          this.totalBytesWritten += buffer.length;
        }
      },
      onError: (err) => console.error('Audio error:', err),
    });

    this.speakerDetector.setCallback((data) => this.chunker.addSpeakerEvent(data));

    // Start with retry logic for audio capture
    await this.startAudioWithRetry();
    await this.speakerDetector.start();

    // Diagnostic DOM check: run after 15 seconds
    setTimeout(async () => {
      try {
        console.log('[BotLifecycle] Running DOM diagnostics for participant tiles...');
        const info = await this.bot.getPage().evaluate(() => {
          const results = [];
          
          // 1. Find all divs that might be participant tiles
          const divs = Array.from(document.querySelectorAll('div'));
          const candidates = divs.filter(d => {
            const label = d.getAttribute('aria-label') || '';
            const id = d.getAttribute('id') || '';
            const dataId = d.getAttribute('data-participant-id') || d.getAttribute('data-member-id') || d.getAttribute('data-requested-participant-id');
            const className = d.className || '';
            return dataId || label.includes('Participant') || className.includes('tile') || className.includes('participant') || d.hasAttribute('data-self-name');
          });

          results.push(`Found ${candidates.length} tile candidates.`);
          candidates.slice(0, 10).forEach((c, idx) => {
            const attrs = {};
            for (const attr of c.attributes) {
              attrs[attr.name] = attr.value;
            }
            results.push(`Candidate ${idx}: tag=${c.tagName}, class=${c.className}, text=${c.textContent ? c.textContent.trim().substring(0, 30) : 'none'}, attrs=${JSON.stringify(attrs)}`);
          });

          // 2. Find any active speaking icons or elements
          const speakingEls = Array.from(document.querySelectorAll('[aria-label*="speaking" i], [class*="speaking" i], [data-speaking]'));
          results.push(`Found ${speakingEls.length} speaking indicators.`);
          speakingEls.slice(0, 5).forEach((s, idx) => {
            results.push(`Speaking Indicator ${idx}: tag=${s.tagName}, class=${s.className}, text=${s.textContent?.trim()}`);
          });

          // 3. Search for any elements that might contain participant names
          const nameEls = Array.from(document.querySelectorAll('[data-self-name], [class*="name" i], [data-name]'));
          results.push(`Found ${nameEls.length} potential name elements.`);
          nameEls.slice(0, 5).forEach((n, idx) => {
            results.push(`Name Element ${idx}: tag=${n.tagName}, class=${n.className}, text=${n.textContent?.trim()}`);
          });

          return results;
        });
        
        console.log('\n===================================');
        console.log('--- GOOGLE MEET DOM DIAGNOSTICS ---');
        info.forEach(line => console.log(line));
        console.log('===================================\n');
      } catch (err) {
        console.error('[BotLifecycle] DOM diagnostics error:', err.message);
      }
    }, 15000);

    // Start periodic background WAV conversion (updates visualizer/export WAV file every 5s)
    this.wavTimer = setInterval(() => {
      this.writeWavFromPcm().catch(() => {});
    }, 5000);
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

  async stop() {
    this.state = 'ended';
    
    // Clear background timer immediately
    if (this.wavTimer) {
      clearInterval(this.wavTimer);
      this.wavTimer = null;
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

    // Close the raw PCM file write stream
    if (this.pcmStream) {
      await new Promise((resolve) => {
        this.pcmStream.end(() => {
          console.log('[BotLifecycle] Closed raw PCM write stream.');
          resolve();
        });
      });
      this.pcmStream = null;
    }

    // Write final WAV file from the complete PCM file
    await this.writeWavFromPcm();

    // Delete temporary raw PCM file
    if (this.pcmPath) {
      try {
        await unlink(this.pcmPath);
        console.log('[BotLifecycle] Cleaned up temporary PCM file.');
      } catch (err) {
        console.error('[BotLifecycle] Failed to delete temporary PCM file:', err.message);
      }
      this.pcmPath = null;
    }

    try {
      await this.bot?.leave();
    } catch (err) {
      console.log('[BotLifecycle] Bot leave warning:', err.message);
    }
  }

  async writeWavFromPcm() {
    if (!this.pcmPath || this.totalBytesWritten === 0) {
      return;
    }

    try {
      const pcmData = await readFile(this.pcmPath);
      if (pcmData.length === 0) return;

      const sampleRate = 16000;
      const numChannels = 1;
      const bitsPerSample = 16;
      const bytesPerSample = bitsPerSample / 8;
      const blockAlign = numChannels * bytesPerSample;

      // Allocate exactly 44 bytes for the WAV header
      const headerBuffer = Buffer.alloc(44);
      const view = new DataView(headerBuffer.buffer);

      const writeString = (view, offset, string) => {
        for (let i = 0; i < string.length; i++) {
          view.setUint8(offset + i, string.charCodeAt(i));
        }
      };

      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + pcmData.length, true);
      writeString(view, 8, 'WAVE');
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * blockAlign, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, bitsPerSample, true);
      writeString(view, 36, 'data');
      view.setUint32(40, pcmData.length, true);

      const finalWavBuffer = Buffer.concat([headerBuffer, pcmData]);
      const wavPath = this.pcmPath.replace('.pcm', '.wav');
      await writeFile(wavPath, finalWavBuffer);
      
      console.log(`[BotLifecycle] Saved session audio update: ${wavPath} (${(finalWavBuffer.length / 1024).toFixed(1)} KB)`);
    } catch (err) {
      console.error('[BotLifecycle] Failed to write WAV file from PCM:', err.message);
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