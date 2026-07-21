import WebSocket from 'ws';

// ---------------------------------------------------------------------------
// Zoom Deepgram Proxy — uses the original chunk-history + mapTimeToSpeaker
// approach for speaker attribution. Zoom embeds speaker info directly in each
// audio chunk (no separate speaker_event messages), so we store every chunk's
// timestamps and speaker in a rolling history array and match Deepgram
// transcript timestamps against it.
// ---------------------------------------------------------------------------

class DeepgramProxyZoom {
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
    console.log(`[DeepgramProxyZoom] Connecting to Deepgram WebSocket for session ${sessionId}...`);

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
      console.log(`[DeepgramProxyZoom] Connected to Deepgram for session ${sessionId}`);

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
          const relativeStart = response.start; // Offset in seconds from start of stream

          // Map relative time to speaker name using our chunk history
          const speaker = this.mapTimeToSpeaker(sessionId, relativeStart);

          onTranscript({
            speaker: speaker || 'Unknown',
            text: transcript.trim(),
            timestamp: new Date().toISOString(),
            isFinal
          });
        }
      } catch (err) {
        console.error(`[DeepgramProxyZoom][${sessionId}] Error processing message:`, err.message);
      }
    });

    dgSocket.on('close', (code, reason) => {
      console.log(`[DeepgramProxyZoom][${sessionId}] Connection closed: Code ${code}, Reason: ${reason}`);
      this.cleanupSession(sessionId);
    });

    dgSocket.on('error', (err) => {
      console.error(`[DeepgramProxyZoom][${sessionId}] WebSocket error:`, err.message);
      if (onError) onError(err);
      this.cleanupSession(sessionId);
    });
  }

  /**
   * Log bot chunk metadata (timestamps and speaker identity) to match against transcriptions later.
   * This is the primary path for Zoom — each audio chunk carries embedded speaker info
   * which we store for timestamp-based matching in mapTimeToSpeaker.
   * Only stores the chunk if it carries a non-null speaker name (skips audio-diarization
   * fallback entries that have generic "Speaker N" names from the bot side).
   */
  logChunkMetadata(sessionId, { start_ts, end_ts, speaker }) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    if (proxy.firstChunkTs === null) {
      proxy.firstChunkTs = start_ts;
      console.log(`[DeepgramProxyZoom][${sessionId}] Recorded first chunk starting epoch: ${start_ts}`);
    }

    // Always push the chunk so timestamps are tracked for mapTimeToSpeaker even when speaker
    // is null (silence or not-yet-detected). The lookup will skip null-speaker entries.
    proxy.chunkHistory.push({ start_ts, end_ts, speaker: speaker || null });

    // Keep history size limited to last 60 minutes (approx 7200 chunks at 500ms intervals)
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
   *
   * Only chunks with a real DOM-detected speaker name are considered — chunks
   * with null speaker (silence / audio-diarization fallback) are skipped, so
   * generic "Speaker N" IDs are never returned.
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

    // 2. Fallback: if the transcript time is past the end of all known chunks
    //    (Deepgram has a processing delay), return the most recent named speaker.
    if (history.length > 0) {
      const newest = history[history.length - 1];
      if (absoluteTimeSec > newest.end_ts) {
        // Walk backwards to find the most recent chunk that has a real speaker name
        for (let i = history.length - 1; i >= 0; i--) {
          if (history[i].speaker) {
            return history[i].speaker;
          }
        }
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

    console.log(`[DeepgramProxyZoom] Closing Deepgram session for ${sessionId}`);

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

export const deepgramProxyZoom = new DeepgramProxyZoom();
