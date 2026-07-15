import { TeamsBot } from '../join/teams-bot.js';
import { CaptionScraper } from '../capture/caption-scraper.js';
import { AudioCapture } from '../capture/audio-capture.js';
import { FileOutput } from '../output/file-output.js';

export class BotLifecycle {
  constructor(config) {
    this.meetingUrl = config.meetingUrl;
    this.botName = config.botName;
    this.headless = config.headless;
    this.channel = config.channel;
    this.captureSource = config.captureSource || 'captions';
    this.outputPath = config.outputPath || './transcript.jsonl';
    this.isGuest = config.isGuest || config.guest || false;

    this.bot = null;
    this.capture = null;
    this.output = null;
    this._state = 'idle'; // idle, joining, capturing, stopping, stopped
  }

  get state() {
    return this._state;
  }

  set state(newValue) {
    this._state = newValue;
    console.log(`[Lifecycle] State transition: ${newValue}`);
  }

  async start() {
    this.state = 'joining';
    console.log(`[BotLifecycle] Starting Teams Bot for meeting: ${this.meetingUrl}`);

    this.bot = new TeamsBot(this.meetingUrl, this.botName, {
      headless: this.headless,
      channel: this.channel,
      isGuest: this.isGuest
    });

    await this.bot.launch();
    await this.bot.join();

    console.log('[BotLifecycle] Bot joined successfully. Initializing capture and output channels...');
    
    // Initialize output logger
    this.output = new FileOutput(this.outputPath);

    // Initialize chosen capture source
    const page = this.bot.getPage();
    if (this.captureSource === 'captions') {
      console.log('[BotLifecycle] Using live captions DOM scraping as capture source.');
      this.capture = new CaptionScraper();
    } else if (this.captureSource === 'audio') {
      console.log('[BotLifecycle] Using raw audio capture (stub) as capture source.');
      this.capture = new AudioCapture();
    } else {
      throw new Error(`[BotLifecycle] Unknown capture source: ${this.captureSource}`);
    }

    await this.capture.initialize(page);

    // Wire capture events to output destination
    this.capture.onTranscript(async (event) => {
      console.log(`[TRANSCRIPT] [${event.speaker}]: ${event.text}`);
      if (this.output) {
        await this.output.write(event);
      }
    });

    this.state = 'capturing';
    await this.capture.start();
    console.log('[BotLifecycle] Capture started. Streaming transcripts...');
  }

  async stop() {
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }
    this.state = 'stopping';
    console.log('[BotLifecycle] Stopping bot lifecycle...');

    try {
      if (this.capture) {
        await this.capture.stop().catch(err => console.warn('[BotLifecycle] Error stopping capture:', err.message));
      }
      if (this.output) {
        await this.output.close().catch(err => console.warn('[BotLifecycle] Error closing output:', err.message));
      }
      if (this.bot) {
        await this.bot.leave().catch(err => console.warn('[BotLifecycle] Error during bot leave:', err.message));
      }
    } catch (err) {
      console.error('[BotLifecycle] Error during shutdown lifecycle:', err.message);
    } finally {
      this.state = 'stopped';
      console.log('[BotLifecycle] Bot lifecycle stopped.');
    }
  }
}
