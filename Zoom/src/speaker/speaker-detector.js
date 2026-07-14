import { SELECTORS, TIMEOUTS } from '../config/selectors.js';

const SPEAKER_DETECTION_SCRIPT = `
window.speakerDetector = {
  observer: null,
  currentSpeaker: null,
  lastChangeTime: 0,
  lastCheckTime: 0,
  onSpeakerChange: null,
  isRunning: false,
  speakerPersistence: new Map(), // Track speaker IDs across disconnects
  speakerConfidence: 1.0,
  consecutiveDetections: 0,
  minConsecutiveForConfidence: 3,

  start(onChangeCallback) {
    this.onSpeakerChange = onChangeCallback;
    
    if (this.isRunning) {
      console.log('[Speaker Detector Hook] Already running, forcing speaker check...');
      this.currentSpeaker = null; // Force re-detection to emit current speaker to newly registered callback
      this.checkSpeakerChange();
      return;
    }
    
    this.isRunning = true;
    console.log('[Speaker Detector Hook] Starting MutationObserver on: ' + window.location.href);
    
    const root = document.querySelector('#zmmtg-root') || document.body;
    if (!root) {
      console.warn('[Speaker Detector Hook] Meeting root or document body not found. Retrying in 1s...');
      setTimeout(() => this.start(onChangeCallback), 1000);
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      const now = Date.now();
      if (now - this.lastCheckTime < 300) return;
      this.lastCheckTime = now;
      this.checkSpeakerChange();
    });

    this.observer.observe(root, {
      attributes: true,
      attributeFilter: ['class', 'style', 'aria-label'],
      subtree: true,
      childList: true
    });

    console.log('[Speaker Detector Hook] MutationObserver attached to root:', root.tagName);
    this.checkSpeakerChange();
  },

  checkSpeakerChange() {
    console.log('[Speaker Detector Hook] Running checkSpeakerChange() on: ' + window.location.href);
    let foundSpeaker = null;
    let detectionMethod = null;

    // Strategy 1: Check for active speaker indicator banner or text in the DOM
    const talkingIndicator = document.querySelector('[class*="talking-indicator"], [class*="active-speaker-name"], .talking-indicator');
    if (talkingIndicator && talkingIndicator.textContent) {
      const text = talkingIndicator.textContent.trim();
      let candidateName = null;
      if (text.toLowerCase().includes('talking:') || text.toLowerCase().includes('speaking:')) {
        candidateName = text.replace(/^(talking:|speaking:)\s*/i, '').trim();
      } else if (text.length > 0 && text.length < 50) {
        candidateName = text;
      }
      
      if (candidateName) {
        const lower = candidateName.toLowerCase();
        // Skip if the talking banner is labeling the bot
        if (lower.includes('(me)') || (window.botDisplayName && lower.includes(window.botDisplayName.toLowerCase())) || lower.includes('bot') || lower.includes('transcriber') || lower.includes('recorder')) {
          console.log('[Speaker Detector Hook] Strategy 1 found indicator for BOT: ' + candidateName + ' (skipped)');
        } else {
          foundSpeaker = candidateName;
          detectionMethod = 'banner';
          console.log('[Speaker Detector Hook] Strategy 1 found indicator: ' + text + ' -> speaker: ' + foundSpeaker);
        }
      }
    }

    // Strategy 2: Check active speaker borders/tiles in Gallery View OR the
    // dominant video pane in Speaker View. These are two different Zoom
    // layouts with unrelated class names:
    //   - Gallery View: small thumbnail gets a "--active" modifier class
    //   - Speaker View: the large/main pane uses speaker-active-container__*
    //     and its mere presence there (no modifier needed) IS the signal
    if (!foundSpeaker) {
      const activeTile = document.querySelector('.speaker-bar-container__video-frame--active, [class*="speaker-bar-container__video-frame--active"], .speaker-active-container__video-frame, [class*="speaker-active-container__video-frame"]');
      if (activeTile) {
        foundSpeaker = this.getParticipantName(activeTile);
        if (foundSpeaker) {
          detectionMethod = 'active-tile';
          console.log('[Speaker Detector Hook] Strategy 2 found active tile (' + activeTile.className + ') -> speaker: ' + foundSpeaker);
        } else {
          console.log('[Speaker Detector Hook] Strategy 2 found active tile class but name was null/excluded.');
        }
      }
    }

    // Strategy 3: Check speaking mic icons in the participant list
    if (!foundSpeaker) {
      const activeMic = document.querySelector('${SELECTORS.inCall.speakingMicIcon}');
      if (activeMic) {
        const row = activeMic.closest('${SELECTORS.inCall.participantRow}');
        if (row) {
          foundSpeaker = this.getParticipantName(row);
          if (foundSpeaker) {
            detectionMethod = 'mic-icon';
            console.log('[Speaker Detector Hook] Strategy 3 found active mic container -> speaker: ' + foundSpeaker);
          }
        }
      }
    }

    console.log('[Speaker Detector Hook] checkSpeakerChange final result: ' + foundSpeaker);
    const now = Date.now();
    
    // Handle speaker changes with confidence tracking
    if (foundSpeaker !== this.currentSpeaker) {
      if (now - this.lastChangeTime > ${TIMEOUTS.speakerDebounce}) {
        // Apply speaker persistence (check if this is a returning speaker)
        const persistentId = this.getSpeakerPersistentId(foundSpeaker);
        
        // Update consecutive detection counter
        if (foundSpeaker) {
          this.consecutiveDetections++;
        } else {
          this.consecutiveDetections = 0;
        }
        
        // Calculate confidence based on consecutive detections
        this.speakerConfidence = foundSpeaker ? 
          Math.min(1.0, this.consecutiveDetections / this.minConsecutiveForConfidence) : 
          0;
        
        console.log('[Speaker Detector Hook] Emitting speaker change from ' + this.currentSpeaker + ' to ' + foundSpeaker + ' (confidence: ' + (this.speakerConfidence * 100).toFixed(0) + '%, method: ' + detectionMethod + ')');
        this.currentSpeaker = foundSpeaker;
        this.lastChangeTime = now;
        
        this.onSpeakerChange?.({ 
          speaker: foundSpeaker, 
          timestamp: now,
          confidence: this.speakerConfidence,
          method: detectionMethod,
          persistentId: persistentId
        });
      }
    } else if (foundSpeaker) {
      // Same speaker, increase confidence
      this.consecutiveDetections++;
      const newConfidence = Math.min(1.0, this.consecutiveDetections / this.minConsecutiveForConfidence);
      
      // Emit confidence update if significantly changed
      if (Math.abs(newConfidence - this.speakerConfidence) > 0.2) {
        this.speakerConfidence = newConfidence;
        this.onSpeakerChange?.({ 
          speaker: foundSpeaker, 
          timestamp: now,
          confidence: this.speakerConfidence,
          method: detectionMethod,
          persistentId: this.getSpeakerPersistentId(foundSpeaker)
        });
      }
    }
  },
  
  getSpeakerPersistentId(speakerName) {
    if (!speakerName) return null;
    
    // Check if we've seen this speaker before
    if (this.speakerPersistence.has(speakerName)) {
      const data = this.speakerPersistence.get(speakerName);
      data.lastSeen = Date.now();
      data.appearances++;
      return data.id;
    }
    
    // New speaker, assign persistent ID
    const id = 'speaker_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    this.speakerPersistence.set(speakerName, {
      id: id,
      firstSeen: Date.now(),
      lastSeen: Date.now(),
      appearances: 1
    });
    
    console.log('[Speaker Detector Hook] Assigned persistent ID ' + id + ' to speaker: ' + speakerName);
    return id;
  },

  getParticipantRawName(el) {
    if (!el) return null;
    
    // a. img[alt] attribute inside the active tile (e.g. <img class="video-avatar__avatar-img" alt="Lina Dholariya">)
    const imgEl = el.querySelector('img[alt]');
    if (imgEl) {
      const altVal = imgEl.getAttribute('alt')?.trim();
      if (altVal && altVal.length > 0) return altVal;
    }

    // b. span[role="none"] text content inside video-avatar__avatar-footer
    const spanEl = el.querySelector('span[role="none"], .video-avatar__avatar-footer span, [class*="avatar-footer"] span');
    if (spanEl && spanEl.textContent?.trim()) {
      return spanEl.textContent.trim();
    }

    // c. Any other visible text-containing name element as a last-resort fallback
    const nameEl = el.querySelector('${SELECTORS.inCall.participantName}');
    if (nameEl && nameEl.textContent?.trim()) return nameEl.textContent.trim();
    
    const genericNameEl = el.querySelector('[class*="name" i]');
    if (genericNameEl && genericNameEl.textContent?.trim()) return genericNameEl.textContent.trim();
    
    const label = el.getAttribute('aria-label') || el.getAttribute('title');
    if (label) {
      return label.replace(/'s video|video of/i, '').trim();
    }
    return null;
  },

  getParticipantName(el) {
    const name = this.getParticipantRawName(el);
    if (name) {
      const lower = name.toLowerCase();
      // Exclude bot self-view and generic bot display names
      if (lower.includes('(me)')) return null;
      if (window.botDisplayName && lower.includes(window.botDisplayName.toLowerCase())) return null;
      if (lower.includes('bot') || lower.includes('transcriber') || lower.includes('recorder')) return null;
      return name;
    }
    return null;
  },

  stop() {
    this.isRunning = false;
    this.observer?.disconnect();
    this.observer = null;
    console.log('[Speaker Detector Hook] Stopped');
    
    // Log speaker persistence statistics
    if (this.speakerPersistence.size > 0) {
      console.log('[Speaker Detector Hook] Speaker Persistence Summary:');
      this.speakerPersistence.forEach((data, name) => {
        console.log('  ' + name + ' (ID: ' + data.id + '): ' + data.appearances + ' appearances');
      });
    }
  }
};

// Auto-start if window.onSpeakerChange function is already exposed
if (typeof window.onSpeakerChange === 'function') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      window.speakerDetector.start((data) => window.onSpeakerChange(data));
    });
  } else {
    window.speakerDetector.start((data) => window.onSpeakerChange(data));
  }
}
`;

export class SpeakerDetector {
  constructor(page, botName) {
    this.page = page;
    this.botName = botName || 'Zoom Bot';
  }

  async initialize() {
    console.log('[Speaker Detector] Initializing context-level hooks across all frames...');
    await this.page.context().addInitScript(SPEAKER_DETECTION_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onSpeakerChange', this.onChange.bind(this)).catch(() => {});

    // Set the bot display name in the browser context initially
    await this.page.context().addInitScript((name) => {
      window.botDisplayName = name;
    }, this.botName).catch(() => {});

    // Run init script on any already loaded frames
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});
        await frame.evaluate((name) => {
          window.botDisplayName = name;
        }, this.botName).catch(() => {});
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async start() {
    const frames = this.page.frames();
    console.log(`[Speaker Detector] Starting observer across ${frames.length} frames (botName: ${this.botName})...`);
    
    for (const frame of frames) {
      try {
        const hasDetector = await frame.evaluate(() => typeof window.speakerDetector !== 'undefined').catch(() => false);
        if (hasDetector) {
          console.log(`[Speaker Detector] Starting observer in frame: ${frame.url()}`);
          await frame.evaluate((name) => {
            if (name) window.botDisplayName = name;
            window.speakerDetector.start((data) => window.onSpeakerChange(data));
          }, this.botName).catch((err) => console.error('[Speaker Detector Frame Start Error]:', err.message));
        }
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async stop() {
    const frames = this.page.frames();
    console.log('[Speaker Detector] Stopping observer across all frames...');
    for (const frame of frames) {
      try {
        const hasDetector = await frame.evaluate(() => typeof window.speakerDetector !== 'undefined').catch(() => false);
        if (hasDetector) {
          await frame.evaluate(() => window.speakerDetector.stop()).catch(() => {});
        }
      } catch (e) {
        // ignore
      }
    }
  }

  onChange(data) {
    if (this.callback) this.callback(data);
  }

  setCallback(callback) {
    this.callback = callback;
  }
}