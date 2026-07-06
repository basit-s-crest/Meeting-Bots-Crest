import { SELECTORS, TIMEOUTS } from '../config/selectors.js';

const SPEAKER_DETECTION_SCRIPT = `
window.speakerDetector = {
  observer: null,
  currentSpeaker: null,
  lastChangeTime: 0,
  onSpeakerChange: null,
  isRunning: false,

  start(onChangeCallback) {
    this.onSpeakerChange = onChangeCallback;
    this.isRunning = true;
    console.log('[Speaker Detector Hook] Starting MutationObserver on: ' + window.location.href);
    
    const root = document.querySelector('#zmmtg-root') || document.body;
    if (!root) {
      console.warn('[Speaker Detector Hook] Meeting root or document body not found. Retrying in 1s...');
      setTimeout(() => this.start(onChangeCallback), 1000);
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      mutations.slice(0, 5).forEach((mutation, index) => {
        console.log('[Speaker Detector Mutation] Mutation ' + index + ':', 
          'type:', mutation.type, 
          'target:', mutation.target.tagName, 
          'class:', typeof mutation.target.className === 'string' ? mutation.target.className : '', 
          'attribute:', mutation.attributeName || 'none'
        );
      });
      if (mutations.length > 5) {
        console.log('[Speaker Detector Mutation] ...and ' + (mutations.length - 5) + ' more mutations.');
      }
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
    let foundSpeaker = null;

    // Diagnostic query to print existing classes related to audio/speaking
    try {
      const keywords = ['active', 'speaking', 'speaker', 'audio', 'mic', 'avatar'];
      const matches = document.querySelectorAll(keywords.map(k => '[class*="' + k + '"]').join(','));
      if (matches.length > 0) {
        const uniqueClasses = new Set();
        matches.forEach(el => {
          if (typeof el.className === 'string') {
            el.className.split(/\\s+/).forEach(c => {
              if (c && keywords.some(k => c.toLowerCase().includes(k))) {
                uniqueClasses.add(c);
              }
            });
          }
        });
        console.log('[Speaker Detector Hook] Diagnostic - Matching DOM classes: ' + Array.from(uniqueClasses).slice(0, 15).join(', '));
      }
    } catch (e) {
      console.error('[Speaker Detector Hook] Diagnostic print failed:', e.message);
    }

    // Strategy 1: Check for active speaker indicator banner or text in the DOM
    const talkingIndicator = document.querySelector('[class*="talking-indicator"], [class*="active-speaker-name"], .talking-indicator');
    if (talkingIndicator && talkingIndicator.textContent) {
      const text = talkingIndicator.textContent.trim();
      console.log('[Speaker Detector Hook] Found talking-indicator text:', text);
      if (text.toLowerCase().includes('talking:') || text.toLowerCase().includes('speaking:')) {
        foundSpeaker = text.replace(/^(talking:|speaking:)\s*/i, '').trim();
      } else if (text.length > 0 && text.length < 50) {
        foundSpeaker = text;
      }
    }

    // Strategy 2: Check active speaker borders or highlighted tiles in Gallery View
    if (!foundSpeaker) {
      const activeTile = document.querySelector('${SELECTORS.inCall.activeSpeakerBorder}');
      if (activeTile) {
        foundSpeaker = this.getParticipantName(activeTile);
        if (foundSpeaker) {
          console.log('[Speaker Detector Hook] Found active speaker via border highlight:', foundSpeaker);
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
            console.log('[Speaker Detector Hook] Found active speaker via participant panel mic icon:', foundSpeaker);
          }
        }
      }
    }

    const now = Date.now();
    if (foundSpeaker !== this.currentSpeaker) {
      if (now - this.lastChangeTime > ${TIMEOUTS.speakerDebounce}) {
        console.log('[Speaker Detector Hook] Emitting speaker change:', foundSpeaker);
        this.currentSpeaker = foundSpeaker;
        this.lastChangeTime = now;
        this.onSpeakerChange?.({ speaker: foundSpeaker, timestamp: now });
      }
    }
  },

  getParticipantName(el) {
    if (!el) return null;
    const nameEl = el.querySelector('${SELECTORS.inCall.participantName}');
    if (nameEl) return nameEl.textContent.trim();
    
    const label = el.getAttribute('aria-label') || el.getAttribute('title');
    if (label) {
      return label.replace(/'s video|video of/i, '').trim();
    }
    return null;
  },

  stop() {
    this.isRunning = false;
    this.observer?.disconnect();
    this.observer = null;
    console.log('[Speaker Detector Hook] Stopped');
  }
};
`;

export class SpeakerDetector {
  constructor(page) {
    this.page = page;
  }

  async initialize() {
    console.log('[Speaker Detector] Initializing context-level hooks across all frames...');
    await this.page.context().addInitScript(SPEAKER_DETECTION_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onSpeakerChange', this.onChange.bind(this)).catch(() => {});

    // Run init script on any already loaded frames
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(SPEAKER_DETECTION_SCRIPT).catch(() => {});
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async start() {
    const frames = this.page.frames();
    console.log(`[Speaker Detector] Starting observer across ${frames.length} frames...`);
    
    for (const frame of frames) {
      try {
        const hasDetector = await frame.evaluate(() => typeof window.speakerDetector !== 'undefined').catch(() => false);
        if (hasDetector) {
          console.log(`[Speaker Detector] Starting observer in frame: ${frame.url()}`);
          await frame.evaluate(() => {
            window.speakerDetector.start((data) => window.onSpeakerChange(data));
          }).catch((err) => console.error('[Speaker Detector Frame Start Error]:', err.message));
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
