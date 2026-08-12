import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Per-channel Deepgram proxy for Google Meet.
//
// The Google Meet bot now captures each participant's audio on its OWN channel
// (per-receiver AudioContext → 16kHz PCM) and binds channel↔speaker at capture
// (channel_speaker_event). This proxy opens ONE Deepgram stream PER CHANNEL and
// attributes each stream's transcripts by its channel's bound name — identity is
// CARRIED at capture, so a new speaker's first words ride their own channel and
// can never land in the previous speaker's block.
//
// The previous single-mixed-stream path (SpeakerBinder + laggy DOM hint matching)
// remains as a fallback: if a session never sends channel bindings, we fall back
// to one stream on channel 0 that uses the SpeakerBinder against speaker_event
// hints — the exact behavior that shipped before.
// ---------------------------------------------------------------------------

// All binder time math is in EPOCH SECONDS, matching the bot's speaker_event
// `timestamp_ts` (epoch seconds) and Deepgram's `response.start` (seconds from
// stream start). Anchoring both to the bot's clock (via the first speaker_event)
// keeps them on one timebase.
const HINT_LAG_S = 0.25;           // DOM active-speaker hint latency (s)
const RECENCY_TIE_S = 1.0;         // near-tie → more recent hint wins
const FLICKER_MIN_S = 1.0;         // ignore hint turns shorter than this
const OPEN_TURN_GRACE_S = 4.0;     // open turn decays so new speaker wins
const HINT_SUPPORT_SLACK_S = 0.5;  // slack added when measuring support
const MIN_MATCH_COVERAGE = 0.35;   // hint must cover ≥35% of commit span
const MIN_MATCH_SUPPORT_S = 0.45;  // and ≥0.45s of support to name a turn
const MIN_MATCH_CONFIDENCE = 0.6;  // and ≥0.6 overlap-share confidence
const HINT_LOG_LIMIT = 2000;       // max retained hint turns

class SpeakerBinder {
  constructor() {
    /** @type {Array<{name: string, tStartSec: number, tEndSec?: number}>} */
    this.turns = [];
    this.firstChunkTs = null;
  }

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

const DG_URL = 'wss://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=100';

class DeepgramProxy {
  constructor() {
    /** @type {Map<string, { channels: Map<number, object> }>} sessionId -> { channels } */
    this.activeProxies = new Map();
  }

  _newChannelState(sessionId, channel, onTranscript, onError) {
    return {
      channel,
      wsConnection: null,
      isReconnecting: false,
      config: null,
      binder: new SpeakerBinder(),
      segmentId: 0,
      currentSegment: null, // { segmentId, isFinal, lastSpeaker }
      lastResolvedSpeaker: null,
      lastChannelSpeaker: null,
      keepAliveInterval: null,
      onTranscript,
      onError
    };
  }

  _ensureSession(sessionId, onTranscript, onError) {
    let entry = this.activeProxies.get(sessionId);
    if (!entry) {
      entry = { channels: new Map() };
      this.activeProxies.set(sessionId, entry);
    }
    // Attach callbacks to the session for late channel creation.
    entry.onTranscript = onTranscript;
    entry.onError = onError;
    return entry;
  }

  /**
   * Initialize the Deepgram WebSocket for a (session, channel) pair.
   * Each channel gets its own stream so transcripts are attributed by channel.
   */
  initializeChannel(sessionId, channel, { apiKey, onTranscript, onError }) {
    const entry = this._ensureSession(sessionId, onTranscript, onError);
    const existing = entry.channels.get(channel);
    if (existing) {
      this.closeChannel(sessionId, channel);
    }

    const state = this._newChannelState(sessionId, channel, onTranscript, onError);
    state.config = { apiKey, onTranscript, onError };
    console.log(`[DeepgramProxy][${sessionId}] Connecting Deepgram WebSocket for channel ${channel}...`);

    const dgSocket = this._openSocket(sessionId, state, channel);
    state.wsConnection = dgSocket;
    entry.channels.set(channel, state);
  }

  _openSocket(sessionId, state, channel) {
    const dgSocket = new WebSocket(DG_URL, { headers: { 'Authorization': `Token ${state.config.apiKey}` } });

    dgSocket.on('open', () => {
      console.log(`[DeepgramProxy][${sessionId}] Connected to Deepgram for channel ${channel}`);
      state.isReconnecting = false;
      // Keepalive ping loop every 3s prevents Deepgram's idle timeout (10s limit) —
      // this is what keeps a 5-min silence from closing the connection.
      if (state.keepAliveInterval) clearInterval(state.keepAliveInterval);
      state.keepAliveInterval = setInterval(() => {
        if (dgSocket.readyState === WebSocket.OPEN) {
          dgSocket.send(JSON.stringify({ type: 'KeepAlive' }));
        }
      }, 3000);
    });

    dgSocket.on('message', (message) => this._onMessage(sessionId, state, channel, message));

    dgSocket.on('close', (code, reason) => {
      console.log(`[DeepgramProxy][${sessionId}] Channel ${channel} connection closed: Code ${code}, Reason: ${reason}`);
      state.isReconnecting = false;
      this.cleanupChannel(sessionId, channel);
    });

    dgSocket.on('error', (err) => {
      console.error(`[DeepgramProxy][${sessionId}] Channel ${channel} WebSocket error:`, err.message);
      if (state.config.onError) state.config.onError(err);
      state.isReconnecting = false;
      this.cleanupChannel(sessionId, channel);
    });

    return dgSocket;
  }

  _onMessage(sessionId, state, channel, message) {
    try {
      const response = JSON.parse(message.toString());
      if (response.type === 'Metadata' || response.type === 'KeepAlive') return;
      const channel_ = response.channel;
      if (!channel_) return;
      const alternative = channel_.alternatives?.[0];
      const transcript = alternative?.transcript;

      if (transcript && transcript.trim().length > 0) {
        const isFinal = response.is_final || response.speech_final;
        const relativeStart = response.start;
        const relativeEnd = response.end ?? relativeStart;

        const binder = state.binder;
        const absoluteStartSec = (binder.firstChunkTs ?? (Date.now() / 1000)) + relativeStart;
        const endPadSec = response.end !== undefined ? 0 : (isFinal ? 0 : 0.3);
        const absoluteEndSec = (binder.firstChunkTs ?? (Date.now() / 1000)) + relativeEnd + endPadSec;

        // PRIMARY: the channel's bound name (carried at capture). FALLBACK: if
        // the binder can't resolve yet (no channel binding arrived), use the
        // SpeakerBinder + legacy hints.
        let speakerName = state.lastChannelSpeaker;
        let provisional = !speakerName;

        if (!speakerName) {
          const resolved = binder.resolve(absoluteStartSec, absoluteEndSec);
          const resolvedName = resolved.name;
          speakerName = resolvedName || state.lastResolvedSpeaker;
          provisional = !speakerName;
          if (resolvedName) state.lastResolvedSpeaker = resolvedName;
        }

        let seg = state.currentSegment;
        if (!seg || seg.isFinal) {
          const segmentId = ++state.segmentId;
          seg = { segmentId, isFinal: false, lastSpeaker: null };
          state.currentSegment = seg;
        }
        seg.isFinal = isFinal;
        const speaker = speakerName || `speaker_${seg.segmentId}`;
        seg.lastSpeaker = speaker;

        state.config.onTranscript({
          segmentId: seg.segmentId,
          channel,
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
  }

  /**
   * Reconnect a channel's Deepgram socket. Called from sendAudio when the socket
   * isn't OPEN — restores the original auto-reconnect behavior that a hard socket
   * drop (network blip, Deepgram-side close) would otherwise turn into silent
   * audio loss.
   */
  reconnectChannel(sessionId, state, channel) {
    if (state.isReconnecting) return;
    state.isReconnecting = true;

    try {
      const dgSocket = this._openSocket(sessionId, state, channel);
      state.wsConnection = dgSocket;
      // Keep the channel registered (cleanup on close/error already handles teardown).
      const entry = this.activeProxies.get(sessionId);
      if (entry) entry.channels.set(channel, state);
    } catch (e) {
      state.isReconnecting = false;
    }
  }

  /**
   * Whether a Deepgram stream already exists for the (session, channel) pair.
   * The server lazy-inits a channel's stream on first audio.
   */
  channelInitialized(sessionId, channel = 0) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return false;
    const state = entry.channels.get(channel);
    return !!(state && state.wsConnection);
  }

  /**
   * Backward-compat entry: initialize the "session" (channel 0). Kept for callers
   * that still use initializeSession() — the Google Meet server now calls
   * initializeChannel() instead.
   */
  initializeSession(sessionId, opts) {
    this.initializeChannel(sessionId, 0, opts);
  }

  logStreamStart(sessionId, channel = 0, startTsSec) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(channel);
    if (!state) return;
    if (state.binder.firstChunkTs === null) {
      state.binder.firstChunkTs = startTsSec;
      console.log(`[DeepgramProxy][${sessionId}] Anchored stream epoch (ch ${channel}) from audio chunk: ${startTsSec}`);
    }
  }

  logSpeakerBoundary(sessionId, { timestamp, speaker }) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(0);
    if (!state) return;
    const binder = state.binder;
    if (binder.firstChunkTs === null) {
      binder.firstChunkTs = timestamp;
      console.log(`[DeepgramProxy][${sessionId}] Anchored stream epoch (from speaker_event fallback): ${timestamp}`);
    }
    if (speaker) {
      binder.recordHint(speaker, timestamp);
    }
  }

  /**
   * Record a channel↔speaker binding (from channel_speaker_event). This is the
   * per-channel ground truth: the channel's Deepgram stream is attributed to the
   * bound name directly, no laggy cross-speaker matching.
   */
  logChannelSpeakerBoundary(sessionId, { channel = 0, speaker, timestamp }) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(channel);
    if (!state) return;
    if (speaker) {
      state.lastChannelSpeaker = speaker;
      console.log(`[DeepgramProxy][${sessionId}] Channel ${channel} speaker bound: "${speaker}"`);
    }
  }

  sendAudio(sessionId, channel = 0, audioBuffer) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(channel);
    if (!state) return;

    const socket = state.wsConnection;
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Direct raw binary write
      socket.send(audioBuffer);
    } else if (socket && socket.readyState === WebSocket.CONNECTING) {
      // Reconnect in flight — nothing to do, next audio will send once open.
    } else if (state.config && (!socket || socket.readyState === WebSocket.CLOSED)) {
      // Socket died (idle timeout / network blip / Deepgram-side close) — restore
      // the original auto-reconnect instead of silently dropping audio.
      console.log(`[DeepgramProxy][${sessionId}] Channel ${channel} socket not open, reconnecting...`);
      this.reconnectChannel(sessionId, state, channel);
    }
  }

  closeChannel(sessionId, channel) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(channel);
    if (!state) return;

    console.log(`[DeepgramProxy][${sessionId}] Closing Deepgram channel ${channel}`);

    if (state.keepAliveInterval) {
      clearInterval(state.keepAliveInterval);
      state.keepAliveInterval = null;
    }
    const socket = state.wsConnection;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
    state.wsConnection = null;
    entry.channels.delete(channel);
  }

  /**
   * Called when a channel's socket closes/errors unexpectedly. Unlike closeChannel,
   * this KEEPS the channel state (binder timeline, carried speaker name, segment
   * counter) so a later sendAudio can reconnect without losing attribution. Only
   * clears the dead socket + keepalive.
   */
  cleanupChannel(sessionId, channel) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    const state = entry.channels.get(channel);
    if (state) {
      if (state.keepAliveInterval) {
        clearInterval(state.keepAliveInterval);
        state.keepAliveInterval = null;
      }
      state.wsConnection = null;
      state.isReconnecting = false;
    }
  }

  closeSession(sessionId) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    console.log(`[DeepgramProxy] Closing all Deepgram channels for session ${sessionId}`);
    for (const channel of Array.from(entry.channels.keys())) {
      this.closeChannel(sessionId, channel);
    }
    this.activeProxies.delete(sessionId);
  }

  cleanupSession(sessionId) {
    const entry = this.activeProxies.get(sessionId);
    if (!entry) return;
    for (const channel of Array.from(entry.channels.keys())) {
      this.cleanupChannel(sessionId, channel);
    }
    this.activeProxies.delete(sessionId);
  }
}

export const deepgramProxyGoogle = new DeepgramProxy();
