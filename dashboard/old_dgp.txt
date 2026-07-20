import WebSocket from 'ws';

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
      firstChunkTs: null,
      chunkHistory: [], // Array of { start_ts, end_ts, speaker }
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
          const relativeStart = response.start;

          const speaker = this.mapTimeToSpeaker(sessionId, relativeStart);

          onTranscript({
            speaker: speaker || 'Unknown',
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
   * Log a precise speaker-turn boundary (from the bot's speaker_event message).
   * This is the preferred, ground-truth path — it closes off the previous
   * speaker's interval at the exact moment the new speaker was detected,
   * instead of relying on 500ms audio-chunk majority voting.
   */
  logSpeakerBoundary(sessionId, { timestamp, speaker }) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    if (proxy.firstChunkTs === null) {
      proxy.firstChunkTs = timestamp;
      console.log(`[DeepgramProxy][${sessionId}] Recorded first chunk starting epoch (from speaker_event): ${timestamp}`);
    }

    const history = proxy.chunkHistory;
    if (history.length > 0 && history[history.length - 1].end_ts === Infinity) {
      history[history.length - 1].end_ts = timestamp;
    }

    if (speaker) {
      history.push({ start_ts: timestamp, end_ts: Infinity, speaker });
    }

    if (history.length > 7200) {
      history.shift();
    }
  }

  /**
   * Log bot chunk metadata (timestamps and speaker identity) to match against transcriptions later.
   * NOTE: this is now a fallback path only, used if speaker_event messages are
   * unavailable — logSpeakerBoundary (above) provides higher-precision data
   * and should be preferred whenever the bot sends speaker_event messages.
   */
  logChunkMetadata(sessionId, { start_ts, end_ts, speaker }) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    if (proxy.firstChunkTs === null) {
      proxy.firstChunkTs = start_ts;
      console.log(`[DeepgramProxy][${sessionId}] Recorded first chunk starting epoch: ${start_ts}`);
    }

    proxy.chunkHistory.push({ start_ts, end_ts, speaker });

    // Keep history size limited to last 60 minutes (approx 7200 chunks at 500ms intervals) to avoid memory growth
    if (proxy.chunkHistory.length > 7200) {
      proxy.chunkHistory.shift();
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
   * Align Deepgram's relative timestamp against the active speaker intervals.
   * Deepgram's `start` offset is seconds from the beginning of the audio stream.
   * We convert it to absolute epoch seconds using firstChunkTs, then find the
   * chunk whose [start_ts, end_ts] window best covers that moment.
   */
  mapTimeToSpeaker(sessionId, relativeTimeSec) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy || proxy.firstChunkTs === null) return null;

    const absoluteTimeSec = proxy.firstChunkTs + relativeTimeSec;
    const history = proxy.chunkHistory;
    if (history.length === 0) return null;

    // 1. Exact window match — search newest-to-oldest.
    for (let i = history.length - 1; i >= 0; i--) {
      const c = history[i];
      if (c.speaker && absoluteTimeSec >= c.start_ts && absoluteTimeSec <= c.end_ts) {
        return c.speaker;
      }
    }

    // 2. Gap fallback — timestamp falls between speaker intervals (transition window).
    //    At speaker transitions, Deepgram may return a transcript whose `start` time
    //    lands slightly before the new speaker's first chunk (processing latency).
    //    Strategy: prefer the UPCOMING speaker (chunk whose start_ts is just ahead of
    //    or equal to the transcript time) over the PREVIOUS speaker, within tolerance.
    //    This prevents User B's first 1-2 chunks being attributed to User A.

    const TRANSITION_TOLERANCE_SEC = 1.5;

    // 2a. Look for a chunk that starts soon AFTER the transcript time (upcoming speaker).
    //     This handles the case where Deepgram returns a result just before the new
    //     speaker's chunk is registered.
    let upcomingChunk = null;
    let upcomingDist = Infinity;
    for (let i = 0; i < history.length; i++) {
      const c = history[i];
      if (!c.speaker) continue;
      // Chunk starts after or at the transcript time
      if (c.start_ts >= absoluteTimeSec) {
        const dist = c.start_ts - absoluteTimeSec;
        if (dist < upcomingDist && dist <= TRANSITION_TOLERANCE_SEC) {
          upcomingDist = dist;
          upcomingChunk = c;
        }
      }
    }
    if (upcomingChunk) return upcomingChunk.speaker;

    // 2b. Look for the most recent chunk that ended just before the transcript time.
    //     Capped to TRANSITION_TOLERANCE_SEC to avoid stale attribution.
    for (let i = history.length - 1; i >= 0; i--) {
      const c = history[i];
      if (!c.speaker) continue;
      const gap = absoluteTimeSec - c.end_ts;
      if (gap >= 0 && gap <= TRANSITION_TOLERANCE_SEC) {
        return c.speaker;
      }
    }

    // 3. Last resort — most recent non-null speaker (capped at 2s ago to avoid
    //    stale attribution after a long silence).
    for (let i = history.length - 1; i >= 0; i--) {
      const c = history[i];
      if (c.speaker && (absoluteTimeSec - c.end_ts) <= 2.0) {
        return c.speaker;
      }
    }

    return null;
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

export const deepgramProxy = new DeepgramProxy();