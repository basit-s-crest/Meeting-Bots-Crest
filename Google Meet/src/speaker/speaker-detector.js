import { TIMEOUTS } from '../config/selectors.js';

/**
 * Channel↔Speaker binder (energy ↔ glow correlation).
 *
 * Google Meet's remote channels are an anonymous rotating pool (channel ≠
 * speaker), so a channel can't be bound structurally. But a channel's AUDIO
 * ENERGY and its speaker's GLOW are driven by the SAME audio — Meet lights tile
 * X exactly when X is loud, and X's audio is what's loud on X's channel. So we
 * integrate agreement over a short window:
 *
 *   channel C ↔ tile X   when C is LOUD exactly while X GLOWS (and not otherwise)
 *
 * Same principle as vexa's GmeetChannelBinder. 1 tile ↔ 1 channel: a tile goes
 * to the channel that correlates with it most. A channel whose best score is
 * below a confidence floor stays UNKNOWN — leak-free, never a guess.
 *
 * Emits a channel_speaker_event whenever a channel's confidently-bound name
 * changes. The backend keys each Deepgram stream by channel, so attribution is
 * carried at capture — no laggy cross-speaker time-matching.
 */
class ChannelSpeakerBinder {
  constructor(options = {}) {
    this.tauMs = options.tauMs ?? 2500;          // correlation decay constant
    // `rms` here is the PEAK amplitude of a Float32 frame (0..1, typical speech
    // peaks ~0.01–0.05). Vexa uses the same scale (loudThreshold 0.02). Do NOT
    // use an Int16 RMS (~500) — the capture layer feeds Float32 peak, so an Int16
    // threshold would never trip and no channel would ever bind a real name.
    this.loudThreshold = options.loudThreshold ?? 0.02;
    this.minScore = options.minScore ?? 2.5;     // confidence floor before binding
    this.selfName = null;

    /** @type {Map<number, Map<string, {score: number, ts: number}>>} channel -> name -> decayed agreement */
    this.agree = new Map();
    /** @type {Map<number, string|null>} channel -> currently-bound name (or null) */
    this.bound = new Map();
  }

  setSelfName(name) {
    this.selfName = name;
    // A sticky self name can never bind a remote channel. Purge any agreement the
    // self already accrued (it may have leaked before the name was known).
    if (name) {
      for (const m of this.agree.values()) m.delete(name);
    }
  }

  /**
   * Update the correlation for one channel with one audio frame.
   * @param {number} channel
   * @param {number} rms  RMS energy of the frame's samples
   * @param {string[]} litNames  names currently glowing (non-self, named tiles)
   * @param {number} tsMs  frame timestamp (ms)
   * @returns {string|null} the channel's current best name, or null if not confident
   */
  update(channel, rms, litNames, tsMs) {
    if (rms > this.loudThreshold && litNames.length > 0) {
      let m = this.agree.get(channel);
      if (!m) { m = new Map(); this.agree.set(channel, m); }
      for (const name of litNames) {
        const e = m.get(name);
        const decayed = e ? e.score * Math.exp(-(tsMs - e.ts) / this.tauMs) : 0;
        m.set(name, { score: decayed + 1, ts: tsMs });
      }
    }
    return this.assign(channel, tsMs);
  }

  cur(channel, name, tsMs) {
    const e = this.agree.get(channel)?.get(name);
    return e ? e.score * Math.exp(-(tsMs - e.ts) / this.tauMs) : 0;
  }

  assign(channel, tsMs) {
    const m = this.agree.get(channel);
    if (!m) return null;
    let best = null;
    let bestScore = 0;
    for (const [name, e] of m) {
      if (name === this.selfName) continue;
      const s = e.score * Math.exp(-(tsMs - e.ts) / this.tauMs);
      if (s > bestScore) { bestScore = s; best = name; }
    }
    if (best === null || bestScore < this.minScore) return null;
    // 1 tile ↔ 1 channel: only claim `best` if no OTHER channel correlates with
    // it more strongly.
    for (const [other] of this.agree) {
      if (other !== channel && this.cur(other, best, tsMs) > bestScore) return null;
    }
    return best;
  }

  /**
   * Returns the channel's current bound name, or null. Does NOT mutate.
   */
  peek(channel, tsMs) {
    return this.assign(channel, tsMs);
  }

  setBound(channel, name) {
    this.bound.set(channel, name);
  }

  getBound(channel) {
    return this.bound.get(channel) ?? null;
  }

  reset() {
    this.agree.clear();
    this.bound.clear();
  }
}

/**
 * SpeakerDetector — polls Google Meet DOM every 150ms from the Node/Playwright
 * side, tracks the glow (active-speaker tiles), and binds each audio channel to
 * a speaker name via the energy↔glow correlation above.
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
    this.emptyCallback = null;
    this.currentSpeaker = null;
    this.lastChangeTime = 0;
    this.pollInterval = null;
    this.botParticipantId = null; // Set once detected, then excluded permanently
    this.solitudeTicks = 0;
    this.hasHumanJoinedEver = false;
    this.channelFrames = new Map(); // channel -> { lastRms, lastLit, ts }
    this.binder = new ChannelSpeakerBinder();
    this._selfNameDetected = false;
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
   * Feed an audio frame (from the capture layer) into the binder. Frames arrive
   * with per-channel RMS, which is what lets us correlate "channel loud" with
   * "tile glowing". Called by the lifecycle for every captured frame.
   */
  feedChannelFrame({ channel, rms }) {
    if (channel === undefined || channel === null) return;
    this.channelFrames.set(channel, { lastRms: rms, ts: Date.now() });
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
          return { litNames: speakingNames, strategy: 'KUNJSe', participantCount };
        }

        // ── Strategy 2: Mic-live fallback ─────────────────────────────────────
        const tiles = Array.from(document.querySelectorAll('[data-participant-id]'));
        for (const tile of tiles) {
          const tileId = tile.getAttribute('data-participant-id');
          if (excludeId && tileId === excludeId) continue;

          for (const el of tile.querySelectorAll('[aria-label]')) {
            const lbl = el.getAttribute('aria-label') || '';
            const m = lbl.match(/^You can't remotely mute (.+?)'s microphone$/i);
            if (m) return { litNames: [m[1].trim()], strategy: 'mic-live', participantCount };
            const m2 = lbl.match(/^Mute (.+)$/i);
            if (m2 && m2[1].trim().length > 1) {
              return { litNames: [m2[1].trim()], strategy: 'mute-btn', participantCount };
            }
          }
        }

        return { litNames: [], strategy: 'silence', participantCount };

      }, botId);

      const litNames = result && Array.isArray(result.litNames) ? result.litNames : [];
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

      // ── Channel ↔ speaker binding ─────────────────────────────────────────
      // Run the correlation for every channel that has audio frames. If a
      // channel's confident name CHANGES, emit a channel_speaker_event so the
      // backend re-binds that channel's Deepgram stream.
      let changed = false;
      for (const [channel, frame] of this.channelFrames) {
        const name = this.binder.update(channel, frame.lastRms, litNames, now);
        const prev = this.binder.getBound(channel);
        if (name !== prev) {
          this.binder.setBound(channel, name);
          console.log(`[SpeakerDetector] Channel ${channel} bound: "${prev}" -> "${name}"`);
          changed = true;
          if (this.callback) {
            this.callback({ type: 'channel_speaker_event', channel, speaker: name, timestamp: now });
          }
        }
      }

      // ── Legacy primary-speaker change event ────────────────────────────────
      // Kept for backward-compat (chunk-level fallback + Zoom uses a different
      // detector entirely). The primary is the first lit name, if any.
      const foundSpeaker = litNames.length > 0 ? litNames[0] : null;
      if (foundSpeaker !== this.currentSpeaker) {
        if (now - this.lastChangeTime > TIMEOUTS.speakerDebounce) {
          console.log(`[SpeakerDetector] "${this.currentSpeaker}" → "${foundSpeaker}" (${result?.strategy ?? 'silence'})`);
          this.currentSpeaker = foundSpeaker;
          this.lastChangeTime = now;
          if (this.callback) {
            this.callback({ speaker: foundSpeaker, timestamp: now });
          }
        }
      } else if (litNames.length > 1 && !litNames.includes(this.currentSpeaker)) {
        // Concurrent speaker appeared while the primary is still live (e.g. both
        // mics on). Emit a change to the newly-appeared speaker so their chunks
        // aren't swallowed into the primary's turn.
        const next = litNames[1];
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
