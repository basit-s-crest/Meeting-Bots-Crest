import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// SpeakerBinder — maps Deepgram transcript timestamps to speaker names using a
// Vexa ClusterNameBinder-style approach (overlap-window match + recency
// tie-break + lag correction + flicker debounce + provisional publish).
//
// Why this replaces the old mapTimeToSpeaker point-lookup: Deepgram has 1-3s
// of processing latency, so a transcript's `start` timestamp can land AFTER the
// speaker boundary that produced it. A point-in-window lookup plus the old
// "prefer upcoming speaker" bias let the PREVIOUS speaker's last words leak into
// the NEXT speaker's block. This binder instead overlaps each hint turn against
// the transcript's audio span and, on a near-tie, gives the MORE RECENT speaker
// priority — the inverse of the old bias.
// ---------------------------------------------------------------------------

// All binder time math is in EPOCH SECONDS, matching the bot's speaker_event
// `timestamp_ts` (epoch seconds) and Deepgram's `response.start` (seconds from
// stream start). Anchoring both to the bot's clock (via the first speaker_event)
// keeps them on one timebase — mixing in Date.now() (server clock) was what made
// hint turns and transcript windows never overlap.
const HINT_LAG_S = 0.25;           // KUNJSe/DOM active-speaker hint ≈ dom-active; measure live
const RECENCY_TIE_S = 1.0;         // near-tie → more recent hint wins
const FLICKER_MIN_S = 1.0;         // ignore hint turns shorter than this
const OPEN_TURN_GRACE_S = 4.0;      // open turn decays so new speaker wins
const HINT_SUPPORT_SLACK_S = 0.5;  // slack added when measuring support
const MIN_MATCH_COVERAGE = 0.35;    // hint must cover ≥35% of commit span
const MIN_MATCH_SUPPORT_S = 0.45;    // and ≥0.45s of support to name a turn
const MIN_MATCH_CONFIDENCE = 0.6;   // and ≥0.6 overlap-share confidence
const HINT_LOG_LIMIT = 2000;        // max retained hint turns

class SpeakerBinder {
  constructor() {
    /** @type {Array<{name: string, tStartMs: number, tEndMs?: number}>} */
    this.turns = [];
    this.firstChunkTs = null;
  }

  /**
   * Record a speaker-boundary hint (from logSpeakerBoundary). The hint timestamp
   * is wall-clock ms; we lag-correct it back to the actual audio time, then close
   * the previously-open turn for that speaker and open a fresh one. Other speakers'
   * open turns are left untouched (concurrent speakers are possible).
   */
  recordHint(speaker, tSec) {
    const t = tSec - HINT_LAG_S;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i];
      if (turn.name === speaker && turn.tEndSec === undefined) {
        turn.tEndSec = t;
        break;
      }
    }
    this.turns.push({ name: speaker, tStartSec: t });
    if (this.turns.length > HINT_LOG_LIMIT) {
      this.turns.splice(0, this.turns.length - HINT_LOG_LIMIT);
    }
  }

  /**
   * Resolve a Deepgram result to a speaker name.
   * @param {number} absoluteStartSec - epoch seconds corresponding to response.start
   * @param {number} absoluteEndSec - epoch seconds corresponding to response.end (or estimate)
   * @returns {{ name: string|null, confidence: number }}
   */
  resolve(absoluteStartSec, absoluteEndSec) {
    if (this.firstChunkTs === null || this.turns.length === 0) {
      return { name: null, confidence: 0 };
    }

    const windowStart = absoluteStartSec;
    const windowEnd = absoluteEndSec;
    const supportStart = absoluteStartSec - HINT_SUPPORT_SLACK_S;
    const supportEnd = absoluteEndSec + HINT_SUPPORT_SLACK_S;
    const commitDur = Math.max(0.001, absoluteEndSec - absoluteStartSec);

    /** @type {Map<string, {ms: number, supportMs: number, lastStart: number}>} */
    const agg = new Map();
    let totalSupportSec = 0;

    for (const turn of this.turns) {
      // FLICKER DEBOUNCE: skip closed turns shorter than FLICKER_MIN_S (transient blips).
      if (turn.tEndSec !== undefined && turn.tEndSec - turn.tStartSec < FLICKER_MIN_S) continue;
      const turnEnd = turn.tEndSec !== undefined ? turn.tEndSec : turn.tStartSec + OPEN_TURN_GRACE_S;

      const overlap = Math.max(0, Math.min(turnEnd, windowEnd) - Math.max(turn.tStartSec, windowStart));
      if (overlap <= 0) continue;
      const support = Math.max(0, Math.min(turnEnd, supportEnd) - Math.max(turn.tStartSec, supportStart));
      if (support <= 0) continue;

      totalSupportSec += support;
      const a = agg.get(turn.name) ?? { ms: 0, supportMs: 0, lastStart: -Infinity };
      a.ms += overlap;
      a.supportMs += support;
      a.lastStart = Math.max(a.lastStart, turn.tStartSec);
      agg.set(turn.name, a);
    }

    if (agg.size === 0) return { name: null, confidence: 0 };

    // Most overlap wins; on a near-tie (within RECENCY_TIE_S) the MORE RECENT
    // hint wins — so a previous speaker's still-open turn can't out-vote the speaker
    // who actually just started.
    let best = null;
    for (const [name, a] of agg) {
      if (!best) { best = { name, ...a }; continue; }
      if (a.supportMs > best.supportMs + RECENCY_TIE_S) best = { name, ...a };
      else if (a.supportMs >= best.supportMs - RECENCY_TIE_S && a.lastStart > best.lastStart) best = { name, ...a };
    }
    if (!best) return { name: null, confidence: 0 };

    const coverage = Math.min(1, best.supportMs / commitDur);
    const confidence = totalSupportSec > 0 ? best.supportMs / totalSupportSec : 0;
    const requiredSupport = Math.min(MIN_MATCH_SUPPORT_S, commitDur * 0.8);

    if (best.supportMs < requiredSupport) return { name: null, confidence: 0 };
    if (coverage < MIN_MATCH_COVERAGE) return { name: null, confidence: 0 };
    if (confidence < MIN_MATCH_CONFIDENCE) return { name: null, confidence: 0 };

    return { name: best.name, confidence: Math.min(coverage, confidence) };
  }
}

class DeepgramProxy {
  constructor() {
    this.activeProxies = new Map(); // sessionId -> { wsConnection, firstChunkTs, chunkHistory, keepAliveInterval }
  }

  /**
   * Initialize a Deepgram streaming connection for a bot session.
   */
  initializeSession(sessionId, { apiKey, onTranscript, onError }) {
    if (this.activeProxies.has(sessionId)) {
      this.closeSession(sessionId);
    }

    const url = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=100';
    console.log(`[DeepgramProxy] Connecting to Deepgram WebSocket for session ${sessionId}...`);

    const headers = {
      'Authorization': `Token ${apiKey}`
    };

    const dgSocket = new WebSocket(url, { headers });

    const proxyState = {
      wsConnection: dgSocket,
      binder: new SpeakerBinder(),
      segmentId: 0,
      currentSegment: null, // { segmentId, isFinal, lastSpeaker } — in-progress utterance
      lastResolvedSpeaker: null, // continuity fallback for provisional segments
      keepAliveInterval: null,
      onTranscript,
      onError
    };

    this.activeProxies.set(sessionId, proxyState);

    dgSocket.on('open', () => {
      console.log(`[DeepgramProxy] Connected to Deepgram for session ${sessionId}`);

      // Start keepalive ping loop every 3 seconds to prevent Deepgram idle timeout (10s limit)
      proxyState.keepAliveInterval = setInterval(() => {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 3000);
    });

    dgSocket.on('message', (message) => {
      try {
        const response = JSON.parse(message.toString());

        // Deepgram sends metadata and KeepAlive responses which we can filter out
        if (response.type === 'Metadata' || response.type === 'KeepAlive') {
          return;
        }

        const channel = response.channel;
        if (!channel) return;

        const alternative = channel.alternatives?.[0];
        const transcript = alternative?.transcript;

        if (transcript && transcript.trim().length > 0) {
          const isFinal = response.is_final || response.speech_final;
          const relativeStart = response.start;            // seconds from stream start
          const relativeEnd = response.end ?? relativeStart; // seconds; DG omits end on partials

          const binder = proxyState.binder;
          const absoluteStartSec = binder.firstChunkTs + relativeStart;
          // Pad partial/interim ends slightly so the window isn't a zero-width point.
          const endPadSec = response.end !== undefined ? 0 : (isFinal ? 0 : 0.3);
          const absoluteEndSec = binder.firstChunkTs + relativeEnd + endPadSec;

          const resolved = binder.resolve(absoluteStartSec, absoluteEndSec);
          const resolvedName = resolved.name; // null until confidently matched

          // Continuity fallback: if the binder can't confidently name THIS segment yet
          // but we've already resolved a speaker earlier in the call, inherit that
          // name instead of emitting a bare "speaker_N". Avoids provisional sprawl
          // during brief hint gaps while still letting a later resolve repaint.
          const speakerName = resolvedName || proxyState.lastResolvedSpeaker;
          const provisional = resolvedName === null && proxyState.lastResolvedSpeaker === null;
          if (resolvedName) proxyState.lastResolvedSpeaker = resolvedName;

          // Segment lifecycle: one stable segmentId per finalized utterance. Interim
          // (non-final) results for the SAME in-progress utterance reuse the current
          // segmentId so the frontend repaints in place instead of spawning a new
          // block per partial. A final result closes the current segment and the next
          // transcript (interim or final) opens a fresh one.
          let seg = proxyState.currentSegment;
          if (!seg || seg.isFinal) {
            const segmentId = ++proxyState.segmentId;
            seg = { segmentId, isFinal: false, lastSpeaker: null };
            proxyState.currentSegment = seg;
          }
          seg.isFinal = isFinal;

          // Emit under the stable segmentId; the frontend repaints in place.
          const speaker = speakerName || `speaker_${seg.segmentId}`;
          seg.lastSpeaker = speaker;

          onTranscript({
            segmentId: seg.segmentId,
            speaker,
            provisional,
            text: transcript.trim(),
            timestamp: new Date().toISOString(),
            isFinal
          });
        }
      } catch (err) {
        console.error(`[DeepgramProxy][${sessionId}] Error processing message:`, err.message);
      }
    });

    dgSocket.on('close', (code, reason) => {
      console.log(`[DeepgramProxy][${sessionId}] Connection closed: Code ${code}, Reason: ${reason}`);
      this.cleanupSession(sessionId);
    });

    dgSocket.on('error', (err) => {
      console.error(`[DeepgramProxy][${sessionId}] WebSocket error:`, err.message);
      if (onError) onError(err);
      this.cleanupSession(sessionId);
    });
  }

  /**
   * Anchor the binder's timeline to the first audio chunk's start_ts (bot epoch
   * seconds at stream start). This is the shared base for Deepgram's response.start
   * (seconds from stream start) and speaker_event.timestamp_ts — anchoring here
   * (rather than on the first speaker_event, which can arrive many seconds in)
   * is what makes hint turns and transcript windows overlap.
   */
  logStreamStart(sessionId, startTsSec) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;
    const binder = proxy.binder;
    if (binder.firstChunkTs === null) {
      binder.firstChunkTs = startTsSec;
      console.log(`[DeepgramProxy][${sessionId}] Anchored stream epoch (from audio chunk): ${startTsSec}`);
    }
  }

  /**
   * Log a precise speaker-turn boundary (from the bot's speaker_event message).
   * Feeds the SpeakerBinder as a lag-corrected hint turn. This is the ground-truth
   * path — it closes the previous speaker's open turn at the exact moment the new
   * speaker was detected. `timestamp` is bot epoch seconds.
   * Only sets the timeline anchor if no audio chunk has anchored us yet.
   */
  logSpeakerBoundary(sessionId, { timestamp, speaker }) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    const binder = proxy.binder;
    if (binder.firstChunkTs === null) {
      binder.firstChunkTs = timestamp;
      console.log(`[DeepgramProxy][${sessionId}] Anchored stream epoch (from speaker_event fallback): ${timestamp}`);
    }

    if (speaker) {
      binder.recordHint(speaker, timestamp);
    }
  }

  /**
   * Feeds raw binary audio data into the active Deepgram connection.
   */
  sendAudio(sessionId, audioBuffer) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    const socket = proxy.wsConnection;
    if (socket.readyState === WebSocket.OPEN) {
      // Direct raw binary write
      socket.send(audioBuffer);
    }
  }

  /**
   * Closes the WebSocket and cleans up keepalive timers.
   */
  closeSession(sessionId) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    console.log(`[DeepgramProxy] Closing Deepgram session for ${sessionId}`);

    if (proxy.keepAliveInterval) {
      clearInterval(proxy.keepAliveInterval);
    }

    const socket = proxy.wsConnection;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }

    this.activeProxies.delete(sessionId);
  }

  cleanupSession(sessionId) {
    const proxy = this.activeProxies.get(sessionId);
    if (proxy) {
      if (proxy.keepAliveInterval) {
        clearInterval(proxy.keepAliveInterval);
      }
      this.activeProxies.delete(sessionId);
    }
  }
}

export const deepgramProxyGoogle = new DeepgramProxy();