import { AUDIO_CONFIG } from '../config/selectors.js';

const AUDIO_CAPTURE_SCRIPT = `
// Intercept RTCPeerConnection instances before Google Meet loads
(function() {
  if (!window.meetPeerConnections) {
    window.meetPeerConnections = [];
    const OrigPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
    if (OrigPeerConnection) {
      const NewPeerConnection = function(...args) {
        const pc = new OrigPeerConnection(...args);
        window.meetPeerConnections.push(pc);
        return pc;
      };
      NewPeerConnection.prototype = OrigPeerConnection.prototype;
      for (const key of Object.getOwnPropertyNames(OrigPeerConnection)) {
        if (key !== 'prototype' && key !== 'arguments' && key !== 'caller') {
          try {
            Object.defineProperty(NewPeerConnection, key, Object.getOwnPropertyDescriptor(OrigPeerConnection, key));
          } catch (e) {}
        }
      }
      window.RTCPeerConnection = NewPeerConnection;
      if (window.webkitRTCPeerConnection) {
        window.webkitRTCPeerConnection = NewPeerConnection;
      }
    }
  }
})();

window.audioCapture = {
  audioCtx: null,
  mixerDest: null,
  processor: null,
  reader: null,
  onFrame: null,
  onError: null,
  isRunning: false,
  sources: new Set(), // Keep track of source nodes to prevent garbage collection

  async start(onFrameCallback, onErrorCallback) {
    this.onFrame = onFrameCallback;
    this.onError = onErrorCallback;
    this.isRunning = true;
    
    try {
      console.log('[AudioCapture] Starting audio capture with Web Audio Mixer...');
      const pc = await this.findPeerConnection();
      if (!pc) throw new Error('RTCPeerConnection not found');

      // Initialize Web Audio Context to mix all tracks natively in Chrome at 16000Hz
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
      this.mixerDest = this.audioCtx.createMediaStreamDestination();

      // 1. Process all existing audio tracks
      const receivers = pc.getReceivers();
      console.log(\`[AudioCapture] Found \${receivers.length} receivers in PeerConnection\`);
      for (const r of receivers) {
        if (r.track && r.track.kind === 'audio') {
          this.addTrackToMixer(r.track);
        }
      }

      // 2. Listen for dynamic new tracks
      pc.addEventListener('track', (event) => {
        if (event.track && event.track.kind === 'audio') {
          console.log(\`[AudioCapture] New audio track added: id=\${event.track.id}\`);
          this.addTrackToMixer(event.track);
        }
      });

      // Get the single mixed audio track from our destination stream
      const mixedTrack = this.mixerDest.stream.getAudioTracks()[0];
      if (!mixedTrack) throw new Error('Failed to create mixed audio track');

      console.log('[AudioCapture] Initializing processor for mixed track...');
      this.processor = new MediaStreamTrackProcessor({ track: mixedTrack });
      this.reader = this.processor.readable.getReader();

      this.readLoop();
      console.log('[AudioCapture] Audio capture initialized successfully');
      return true;
    } catch (e) {
      console.error('[AudioCapture] Start failed:', e.message);
      this.onError?.(e.message);
      return false;
    }
  },

  addTrackToMixer(track) {
    if (track.readyState !== 'live') return;
    
    console.log(\`[AudioCapture] Adding track to mixer: \${track.id}\`);

    // Force decoding via hidden local audio element
    try {
      const stream = new MediaStream([track]);
      const audioEl = document.createElement('audio');
      audioEl.srcObject = stream;
      audioEl.autoplay = true;
      audioEl.muted = false;
      audioEl.volume = 0.01;
      document.body.appendChild(audioEl);
      audioEl.play().catch(() => {});
    } catch (err) {
      console.log('[AudioCapture] Helper audio play warning:', err.message);
    }

    // Connect to Web Audio mixer
    try {
      const sourceStream = new MediaStream([track]);
      const sourceNode = this.audioCtx.createMediaStreamSource(sourceStream);
      sourceNode.connect(this.mixerDest);
      this.sources.add(sourceNode); // Prevent garbage collection
      console.log(\`[AudioCapture] Successfully connected track \${track.id} to mixer\`);
    } catch (err) {
      console.error(\`[AudioCapture] Failed to connect track \${track.id} to mixer:\`, err.message);
    }
  },

  async readLoop() {
    console.log('[AudioCapture] Starting readLoop...');
    let frameCount = 0;
    try {
      while (this.isRunning) {
        const { done, value } = await this.reader.read();
        if (done) {
          console.log('[AudioCapture] readLoop done');
          break;
        }

        frameCount++;
        if (frameCount % 100 === 0) {
          console.log(\`[AudioCapture] Received \${frameCount} mixed audio frames\`);
        }

        if (value instanceof AudioData) {
          try {
            const format = value.format;
            const size = value.allocationSize({ planeIndex: 0 });
            const arrayBuffer = new ArrayBuffer(size);
            value.copyTo(arrayBuffer, { planeIndex: 0 });

            let samples;
            if (format.startsWith('f32')) {
              const f32 = new Float32Array(arrayBuffer);
              samples = new Int16Array(f32.length);
              for (let i = 0; i < f32.length; i++) {
                const s = Math.max(-1, Math.min(1, f32[i]));
                samples[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
              }
            } else {
              samples = new Int16Array(arrayBuffer);
            }

            let finalSamples = samples;
            const incomingRate = value.sampleRate;
            const targetRate = 16000;
            if (incomingRate !== targetRate) {
              const ratio = incomingRate / targetRate;
              const newLength = Math.round(samples.length / ratio);
              const resampled = new Int16Array(newLength);
              for (let i = 0; i < newLength; i++) {
                const pos = i * ratio;
                const idx = Math.floor(pos);
                const nextIdx = Math.min(samples.length - 1, idx + 1);
                const weight = pos - idx;
                resampled[i] = Math.round(samples[idx] * (1 - weight) + samples[nextIdx] * weight);
              }
              finalSamples = resampled;
            }

            this.onFrame?.({
              timestamp: value.timestamp,
              sampleRate: targetRate,
              numberOfFrames: finalSamples.length,
              numberOfChannels: 1,
              data: Array.from(finalSamples)
            });
          } catch (copyErr) {
            console.error('[AudioCapture] Error processing frame:', copyErr.message);
          } finally {
            value.close();
          }
        }
      }
    } catch (e) {
      console.error('[AudioCapture] readLoop error:', e.message);
      this.onError?.(e.message);
    }
  },

  async findPeerConnection() {
    console.log('[AudioCapture] Finding PeerConnection. Intercepted count: ' + (window.meetPeerConnections ? window.meetPeerConnections.length : 0));
    
    if (window.meetPeerConnections && window.meetPeerConnections.length > 0) {
      for (let i = 0; i < window.meetPeerConnections.length; i++) {
        const pc = window.meetPeerConnections[i];
        try {
          const receivers = pc.getReceivers();
          const audioTracks = receivers.map(r => r.track).filter(t => t);
          console.log(\`[AudioCapture] Intercepted PC index \${i}: signalingState=\${pc.signalingState}, connectionState=\${pc.connectionState}, iceConnectionState=\${pc.iceConnectionState}, audioTracksCount=\${audioTracks.length}\`);
          
          for (let j = 0; j < audioTracks.length; j++) {
            const t = audioTracks[j];
            console.log(\`[AudioCapture]   - Track \${j}: id=\${t.id}, kind=\${t.kind}, enabled=\${t.enabled}, readyState=\${t.readyState}\`);
          }

          if (pc.signalingState !== 'closed' && audioTracks.some(t => t.kind === 'audio' && t.readyState === 'live')) {
            console.log(\`[AudioCapture] Selecting intercepted PC index \${i} as active connection\`);
            return pc;
          }
        } catch (err) {
          console.log('[AudioCapture] Error inspecting intercepted PC index ' + i + ': ' + err.message);
        }
      }
    }

    // Strategy 1: Check RTCPeerConnection instances in window
    try {
      const RTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (RTCPeerConnection) {
        for (const key of Object.keys(window)) {
          try {
            const obj = window[key];
            if (obj instanceof RTCPeerConnection) {
              const receivers = obj.getReceivers();
              if (receivers.some(r => r.track?.kind === 'audio')) {
                console.log('[AudioCapture] Found PeerConnection in window.' + key);
                return obj;
              }
            }
          } catch {}
        }
      }
    } catch {}

    // Strategy 2: Look for peer connection in global variables
    const candidates = [
      'peerConnection', 'pc', 'rtcPeerConnection', 'webRTCPeerConnection',
      'googleMeetPc', 'meetPeerConnection', 'connection'
    ];
    
    for (const key of candidates) {
      try {
        const obj = window[key];
        if (obj && typeof obj.getReceivers === 'function') {
          const receivers = obj.getReceivers();
          if (receivers.some(r => r.track?.kind === 'audio')) {
            console.log('[AudioCapture] Found PeerConnection in candidates.' + key);
            return obj;
          }
        }
      } catch {}
    }

    // Strategy 3: Search all window properties
    for (const key of Object.keys(window)) {
      try {
        const obj = window[key];
        if (obj && typeof obj.getReceivers === 'function') {
          const receivers = obj.getReceivers();
          if (receivers.some(r => r.track?.kind === 'audio')) {
            console.log('[AudioCapture] Found PeerConnection in window search.' + key);
            return obj;
          }
        }
      } catch {}
    }

    console.warn('[AudioCapture] No active RTCPeerConnection found');
    return null;
  },

  stop() {
    console.log('[AudioCapture] Stopping audio capture...');
    this.isRunning = false;
    this.reader?.releaseLock();
    this.processor = null;
    this.reader = null;

    for (const sourceNode of this.sources) {
      try {
        sourceNode.disconnect();
      } catch {}
    }
    this.sources.clear();

    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.mixerDest = null;
  }
};
`;

export class AudioCapture {
  constructor(page) {
    this.page = page;
  }

  async initialize() {
    await this.page.addInitScript(AUDIO_CAPTURE_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onAudioFrame', this.onFrame.bind(this)).catch(() => {});
    await this.page.exposeFunction('onAudioError', this.onError.bind(this)).catch(() => {});
    await this.page.evaluate(AUDIO_CAPTURE_SCRIPT);
  }

  async start() {
    return await this.page.evaluate(() => 
      window.audioCapture.start(
        (frame) => window.onAudioFrame(frame),
        (err) => window.onAudioError(err)
      )
    );
  }

  stop() {
    return this.page.evaluate(() => window.audioCapture.stop());
  }

  onFrame(frame) {
    if (this.callback) this.callback(frame);
  }

  onError(err) {
    if (this.errorCallback) this.errorCallback(err);
  }

  setCallbacks(callbacks) {
    this.callback = callbacks.onFrame;
    this.errorCallback = callbacks.onError;
  }
}