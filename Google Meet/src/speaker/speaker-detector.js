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
    
    const grid = document.querySelector('${SELECTORS.inCall.participantGrid}');
    if (!grid) {
      setTimeout(() => this.start(onChangeCallback), 1000);
      return;
    }

    this.observer = new MutationObserver((mutations) => {
      this.checkSpeakerChange(grid);
    });

    this.observer.observe(grid, {
      attributes: true,
      attributeFilter: ['aria-label', 'data-speaking', 'class'],
      subtree: true,
      childList: true
    });

    this.checkSpeakerChange(grid);
  },

  checkSpeakerChange(grid) {
    const tiles = grid.querySelectorAll('${SELECTORS.inCall.participantTile}');
    let foundSpeaker = null;

    for (const tile of tiles) {
      if (this.isSpeaking(tile)) {
        const name = this.getParticipantName(tile);
        if (name) {
          foundSpeaker = name;
          break;
        }
      }
    }

    const now = Date.now();
    if (foundSpeaker !== this.currentSpeaker) {
      if (now - this.lastChangeTime > ${TIMEOUTS.speakerDebounce}) {
        this.currentSpeaker = foundSpeaker;
        this.lastChangeTime = now;
        this.onSpeakerChange?.({ speaker: foundSpeaker, timestamp: now });
      }
    }
  },

  isSpeaking(tile) {
    return tile.getAttribute('aria-label')?.includes('speaking') ||
           tile.getAttribute('data-speaking') === 'true' ||
           tile.classList.contains('speaking') ||
           tile.querySelector('[aria-label*="speaking" i]') !== null;
  },

  getParticipantName(tile) {
    return tile.getAttribute('data-participant-name') ||
           tile.querySelector('${SELECTORS.inCall.participantName}')?.textContent?.trim() ||
           tile.getAttribute('aria-label')?.split(',')[0]?.trim() ||
           null;
  },

  stop() {
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
    await this.page.evaluate(() => 
      window.speakerDetector.start((data) => window.onSpeakerChange(data))
    );
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