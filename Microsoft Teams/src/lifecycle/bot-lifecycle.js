import { TeamsBot } from '../join/teams-bot.js';
import { CaptionScraper } from '../capture/caption-scraper.js';
import { AudioCapture } from '../capture/audio-capture.js';
import { FileOutput } from '../output/file-output.js';
import { generateAnnouncementMessage, parseChatCommand } from '../config/chat-service.js';

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
    this.isPaused = false;
    this._chatMonitorInterval = null;
    this.processedChatMessages = new Set();
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
      if (!this.isPaused) {
        console.log(`[TRANSCRIPT] [${event.speaker}]: ${event.text}`);
        if (this.output) {
          await this.output.write(event);
        }
      }
    });

    this.state = 'capturing';

    // 1. Enable captions & start DOM stream first
    await this.capture.start();
    console.log('[BotLifecycle] Capture started. Streaming transcripts...');

    // 2. Trigger chat announcement sequentially after call UI settles
    try {
      console.log('[BotLifecycle] [CHAT LOG] Triggering chat announcement...');
      await this.sendChatAnnouncement();
    } catch (err) {
      console.error('[BotLifecycle] [CHAT LOG] Uncaught error in sendChatAnnouncement:', err.message);
    }

    // 3. Start background chat command monitor
    this.startChatCommandMonitor();
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
    const result = await this.bot?.sendChatMessage(msg);
    if (result) {
      console.log('[BotLifecycle] [CHAT LOG] Announcement draft message sent successfully!');
    } else {
      console.warn('[BotLifecycle] [CHAT LOG] Failed to send announcement draft message.');
    }
  }

  startChatCommandMonitor() {
    if (this._chatMonitorInterval) return;
    this.processedChatMessages = new Set();
    console.log('[BotLifecycle] [CHAT LOG] In-call chat command monitor started (polling every 3s).');

    this._chatMonitorInterval = setInterval(async () => {
      if (this.state !== 'capturing') return;
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
    }, 3000);
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

  async stop(explicitReason) {
    if (explicitReason) {
      this.emitReason(explicitReason);
    }
    if (this.state === 'stopping' || this.state === 'stopped') {
      return;
    }
    this.state = 'stopping';
    console.log('[BotLifecycle] Stopping bot lifecycle...');

    if (this._chatMonitorInterval) {
      clearInterval(this._chatMonitorInterval);
      this._chatMonitorInterval = null;
    }

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
