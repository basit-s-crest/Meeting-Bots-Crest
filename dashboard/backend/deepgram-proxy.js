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

    const url = 'wss://api.deepgram.com/v1/listen?model=nova-2&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&smart_format=true&endpointing=100';
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
          const relativeStart = response.start; // Offset in seconds from start of stream
          
          // Map relative time to speaker name using our chunk history
          const speaker = this.mapTimeToSpeaker(sessionId, relativeStart);
          
          onTranscript({
            speaker: speaker || 'Silence/Noise',
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
   * Log bot chunk metadata (timestamps and speaker identity) to match against transcriptions later.
   */
  logChunkMetadata(sessionId, { start_ts, end_ts, speaker }) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy) return;

    if (proxy.firstChunkTs === null) {
      proxy.firstChunkTs = start_ts;
      console.log(`[DeepgramProxy][${sessionId}] Recorded first chunk starting epoch: ${start_ts}`);
    }

    proxy.chunkHistory.push({ start_ts, end_ts, speaker });

    // Keep history size limited to last 15 minutes (approx 1800 chunks at 500ms intervals) to avoid memory growth
    if (proxy.chunkHistory.length > 2000) {
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
   */
  mapTimeToSpeaker(sessionId, relativeTimeSec) {
    const proxy = this.activeProxies.get(sessionId);
    if (!proxy || proxy.firstChunkTs === null) return null;

    // Convert Deepgram relative offset to absolute Unix epoch seconds
    const absoluteTimeSec = proxy.firstChunkTs + relativeTimeSec;

    // Find nearest matching chunk interval in history (search from newest to oldest for speed)
    for (let i = proxy.chunkHistory.length - 1; i >= 0; i--) {
      const c = proxy.chunkHistory[i];
      if (absoluteTimeSec >= c.start_ts && absoluteTimeSec <= c.end_ts) {
        return c.speaker;
      }
    }

    // Fallback: check if we match slightly outside bounds
    if (proxy.chunkHistory.length > 0) {
      const newest = proxy.chunkHistory[proxy.chunkHistory.length - 1];
      if (absoluteTimeSec > newest.end_ts) {
        return newest.speaker;
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
