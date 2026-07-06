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
    
    console.log('[SpeakerDetector] Starting speaker detector observer on document.body...');
    this.observer = new MutationObserver((mutations) => {
      this.checkSpeakerChange();
    });

    this.observer.observe(document.body, {
      attributes: true,
      attributeFilter: ['aria-label', 'data-speaking', 'class'],
      subtree: true
    });

    this.checkSpeakerChange();
  },

  checkSpeakerChange() {
    // Find all participant tiles on the page
    const tiles = document.querySelectorAll('[data-participant-id], [role="listitem"]');
    let foundSpeaker = null;

    for (let i = 0; i < tiles.length; i++) {
      const tile = tiles[i];
      const isSp = this.isSpeaking(tile);
      const name = this.getParticipantName(tile);
      
      if (isSp && name) {
        foundSpeaker = name;
        break;
      }
    }

    const now = Date.now();
    if (foundSpeaker !== this.currentSpeaker) {
      if (now - this.lastChangeTime > ${TIMEOUTS.speakerDebounce}) {
        console.log(\`[SpeakerDetector] Speaker changed: \${this.currentSpeaker} -> \${foundSpeaker}\`);
        this.currentSpeaker = foundSpeaker;
        this.lastChangeTime = now;
        this.onSpeakerChange?.({ speaker: foundSpeaker, timestamp: now });
      }
    }
  },

  isSpeaking(tile) {
    const ariaLabel = tile.getAttribute('aria-label') || '';
    const hasSpeakingAria = ariaLabel.toLowerCase().includes('speaking') || 
                             ariaLabel.toLowerCase().includes('active speaker');
                             
    const hasSpeakingClass = tile.classList.contains('speaking') || 
                             tile.classList.contains('active-speaker') ||
                             tile.querySelector('.speaking, .active-speaker') !== null;
                             
    const hasSpeakingData = tile.getAttribute('data-speaking') === 'true' || 
                            tile.querySelector('[data-speaking="true"]') !== null;
                            
    const hasWaveIndicator = tile.querySelector('[class*="speaking" i], [class*="volume" i], [aria-label*="speaking" i]') !== null;

    return hasSpeakingAria || hasSpeakingClass || hasSpeakingData || hasWaveIndicator;
  },

  getParticipantName(tile) {
    // 1. Check data-participant-name attribute
    let name = tile.getAttribute('data-participant-name');
    if (name) return name.trim();

    // 2. Check participantName selector
    const nameEl = tile.querySelector('${SELECTORS.inCall.participantName}');
    if (nameEl && nameEl.textContent) {
      name = nameEl.textContent.trim();
      if (name) return name;
    }

    // 3. Search for elements containing name or labels
    const nameSelectorEls = tile.querySelectorAll('[data-name], .name, [class*="name" i]');
    for (const el of nameSelectorEls) {
      if (el.textContent && el.textContent.trim()) {
        return el.textContent.trim();
      }
    }

    // 4. Fallback to aria-label
    const ariaLabel = tile.getAttribute('aria-label');
    if (ariaLabel) {
      name = ariaLabel.split(',')[0].trim();
      if (name && name !== 'speaking' && name !== 'video') return name;
    }

    return null;
  },

  stop() {
    console.log('[SpeakerDetector] Stopping speaker detector observer...');
    this.isRunning = false;
    this.observer?.disconnect();
    this.observer = null;
  }
};
`;

export class SpeakerDetector {
  constructor(page) {
    this.page = page;
  }

  async initialize() {
    await this.page.addInitScript(SPEAKER_DETECTION_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onSpeakerChange', this.onChange.bind(this)).catch(() => {});
    await this.page.evaluate(SPEAKER_DETECTION_SCRIPT);
  }

  async start() {
    console.log('[SpeakerDetector] Calling start() in browser context...');
    try {
      const result = await this.page.evaluate(() => {
        console.log('[SpeakerDetector] Browser check: window.speakerDetector is', window.speakerDetector ? 'defined' : 'undefined');
        if (!window.speakerDetector) {
          return 'undefined';
        }
        window.speakerDetector.start((data) => window.onSpeakerChange(data));
        return 'started';
      });
      console.log('[SpeakerDetector] start() browser result:', result);
    } catch (err) {
      console.error('[SpeakerDetector] Failed to start in browser:', err.message);
    }
  }

  stop() {
    return this.page.evaluate(() => window.speakerDetector.stop());
  }

  onChange(data) {
    if (this.callback) this.callback(data);
  }

  setCallback(callback) {
    this.callback = callback;
  }
}