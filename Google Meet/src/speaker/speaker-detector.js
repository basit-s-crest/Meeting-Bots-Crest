import { TIMEOUTS } from '../config/selectors.js';

/**
 * SpeakerDetector — polls Google Meet DOM every 400ms from the Node/Playwright side.
 *
 * Key facts from DOM analysis:
 *   - Speaker indicator: [jsname="QgSmzd"].KUNJSe — added when participant is speaking
 *     Works for video ON/OFF, mic ON/OFF, any number of participants.
 *   - Name source: [aria-label^="More options for <Name>"] inside each tile
 *   - Bot's own tile is identified by containing "Remove this tile" button
 *     (self-view controls only appear on the bot's own tile, never on others)
 *   - Bot tile must be excluded — it joins as the same Google account name as
 *     the real user, so name-based exclusion is not reliable.
 */
export class SpeakerDetector {
  constructor(page) {
    this.page = page;
    this.callback = null;
    this.currentSpeaker = null;
    this.lastChangeTime = 0;
    this.pollInterval = null;
    this.botParticipantId = null; // Set once detected, then excluded permanently
    this.emptyCallback = null;
    this.solitudeTicks = 0;
    this.hasHumanJoinedEver = false;
  }


  async initialize() {
    // Node-side polling — nothing to inject
  }

  async start() {
    console.log('[SpeakerDetector] Starting (KUNJSe detection, bot-tile excluded)...');

    // Detect bot's own tile before polling starts
    await this._detectBotTile(true);

    await this._poll();
    this.pollInterval = setInterval(() => this._poll(), 150);
  }

  async stop() {
    console.log('[SpeakerDetector] Stopping...');
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }

  setCallback(callback) {
    this.callback = callback;
  }

  setEmptyCallback(callback) {
    this.emptyCallback = callback;
  }

  /**
   * Find and cache the bot's own participant-id by looking for self-view controls.
   * "Remove this tile" and "Backgrounds and effects" only appear on the bot's tile.
   * Called once at startup (with retries) and then again on each poll until found.
   */
  async _detectBotTile(withRetries = false) {
    const attempts = withRetries ? 10 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const botId = await this.page.evaluate(() => {
          const tiles = Array.from(document.querySelectorAll('[data-participant-id]'));
          for (const tile of tiles) {
            const hasRemove = tile.querySelector('[aria-label="Remove this tile"]') !== null;
            const hasBg = tile.querySelector('[aria-label="Backgrounds and effects"]') !== null;
            if (hasRemove || hasBg) {
              return tile.getAttribute('data-participant-id');
            }
          }
          return null;
        });

        if (botId) {
          this.botParticipantId = botId;
          console.log(`[SpeakerDetector] Bot tile identified: data-participant-id="${botId}"`);
          return;
        }
      } catch (err) {
        // Page still loading
      }
      if (withRetries) await new Promise(r => setTimeout(r, 1000));
    }
    if (withRetries) {
      console.warn('[SpeakerDetector] Could not identify bot tile after retries — self-exclusion disabled');
    }
  }

  async _poll() {
    try {
      // If bot tile not yet found, keep trying on every poll until found
      if (!this.botParticipantId) {
        await this._detectBotTile();
      }

      const botId = this.botParticipantId;

      const result = await this.page.evaluate((excludeId) => {
        const participantCount = document.querySelectorAll('[data-participant-id]').length;

        function getNameFromTile(tile) {
          const moreBtn = tile.querySelector('[aria-label^="More options for"]');
          if (moreBtn) {
            const name = moreBtn.getAttribute('aria-label')
              .replace(/^More options for\s+/i, '').trim();
            if (name) return name;
          }
          const pinBtn = tile.querySelector('[aria-label^="Pin "]');
          if (pinBtn) {
            const m = pinBtn.getAttribute('aria-label').match(/^Pin (.+?) to your/i);
            if (m) return m[1].trim();
          }
          return null;
        }

        // ── Strategy 1: KUNJSe — primary speaking indicator ──────────────────
        // Collect ALL speaking indicators (multiple participants can be live at
        // once when mics are left on). The first match is the "primary" speaker;
        // any ADDITIONAL live speaker is reported so concurrent talkers aren't
        // silently swallowed into the primary's turn.
        const speakingEls = Array.from(document.querySelectorAll('[jsname="QgSmzd"].KUNJSe'));
        const speakingNames = [];
        for (const el of speakingEls) {
          const tile = el.closest('[data-participant-id]');
          if (!tile) continue;
          const tileId = tile.getAttribute('data-participant-id');
          if (excludeId && tileId === excludeId) continue;
          const name = getNameFromTile(tile);
          if (name && !speakingNames.includes(name)) speakingNames.push(name);
        }
        if (speakingNames.length > 0) {
          return { speaker: speakingNames[0], others: speakingNames.slice(1), strategy: 'KUNJSe', participantCount };
        }

        // ── Strategy 2: Mic-live fallback ─────────────────────────────────────
        const tiles = Array.from(document.querySelectorAll('[data-participant-id]'));
        for (const tile of tiles) {
          const tileId = tile.getAttribute('data-participant-id');
          if (excludeId && tileId === excludeId) continue;

          for (const el of tile.querySelectorAll('[aria-label]')) {
            const lbl = el.getAttribute('aria-label') || '';
            const m = lbl.match(/^You can't remotely mute (.+?)'s microphone$/i);
            if (m) return { speaker: m[1].trim(), strategy: 'mic-live', participantCount };
            const m2 = lbl.match(/^Mute (.+)$/i);
            if (m2 && m2[1].trim().length > 1) {
              return { speaker: m2[1].trim(), strategy: 'mute-btn', participantCount };
            }
          }
        }

        return { speaker: null, strategy: 'silence', participantCount };

      }, botId);

      const foundSpeaker = result ? result.speaker : null;
      const otherSpeakers = result && result.others ? result.others : [];
      const participantCount = result ? result.participantCount : 0;
      const now = Date.now();

      // Solitude (empty meeting) check commented out per user request.
      // Bot stays in call until manually stopped from UI.
      /*
      if (this.botParticipantId && participantCount <= 1) {
        this.solitudeTicks++;
        // 200 ticks * 150ms = 30 seconds
        if (this.solitudeTicks >= 200) {
          console.warn(`[SpeakerDetector] Bot has been alone in the meeting for 30 seconds. Triggering empty meeting exit...`);
          this.solitudeTicks = 0; // reset
          if (this.emptyCallback) {
            this.emptyCallback();
          }
        }
      } else {
        this.solitudeTicks = 0;
      }
      */


      // Primary speaker changed → emit as before (handles mic-off / clear handoff).
      if (foundSpeaker !== this.currentSpeaker) {
        if (now - this.lastChangeTime > TIMEOUTS.speakerDebounce) {
          console.log(`[SpeakerDetector] "${this.currentSpeaker}" → "${foundSpeaker}" (${result?.strategy ?? 'silence'})`);
          this.currentSpeaker = foundSpeaker;
          this.lastChangeTime = now;
          if (this.callback) {
            this.callback({ speaker: foundSpeaker, timestamp: now });
          }
        }
      } else if (otherSpeakers.length > 0 && !otherSpeakers.includes(this.currentSpeaker)) {
        // Concurrent speaker appeared while the primary is still live (e.g. both
        // mics on). Emit a change to the newly-appeared speaker so their chunks
        // aren't swallowed into the primary's turn. The audio is mixed, so the
        // most-recently-started talker is the most likely current transcription.
        // Damp flips back within a short window to avoid 150ms thrash.
        const next = otherSpeakers[0];
        const CONCURRENT_MIN_GAP_MS = 400;
        if (now - this.lastChangeTime > CONCURRENT_MIN_GAP_MS) {
          console.log(`[SpeakerDetector] concurrent "${next}" while primary "${this.currentSpeaker}" live`);
          this.currentSpeaker = next;
          this.lastChangeTime = now;
          if (this.callback) {
            this.callback({ speaker: next, timestamp: now });
          }
        }
      }
    } catch (err) {
      if (!err.message.includes('Target closed') && !err.message.includes('Execution context')) {
        console.error('[SpeakerDetector] Poll error:', err.message);
      }
    }
  }
}
