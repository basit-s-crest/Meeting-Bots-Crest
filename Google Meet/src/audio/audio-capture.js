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

// AudioWorklet module: echoes 16kHz input frames to the main thread as Float32 PCM.
// The AudioContext is created at 16kHz, so Chrome resamples each participant's
// audio (48kHz) down to 16kHz on the audio thread before the worklet runs.
const PCM_WORKLET_SRC = \`
class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch || ch.length === 0) return true;
    const pcm = new Float32Array(ch.length);
    pcm.set(ch);
    this.port.postMessage(pcm, [pcm.buffer]);
    return true;
  }
}
registerProcessor('pcm-capture', PcmCaptureProcessor);
\`;

window.audioCapture = {
  targetRate: ${AUDIO_CONFIG.sampleRate},
  silenceThreshold: 0.005,
  holdOpenMs: 2000,
  isRunning: false,
  contexts: new Map(),            // streamId -> { ctx, sourceNode, workletNode }
  connectedStreamIds: new Set(),  // streamId -> true
  channelByStream: new Map(),     // streamId -> channel index
  channelToStream: new Map(),     // channel index -> streamId
  streamLastVoice: new Map(),     // streamId -> last voice timestamp (ms)
  nextChannel: 0,
  freedChannels: [],
  rescanTimer: null,
  workletUrl: null,
  onFrame: null,
  onError: null,

  async start(onFrameCallback, onErrorCallback) {
    this.onFrame = onFrameCallback;
    this.onError = onErrorCallback;
    if (this.isRunning) return true;
    this.isRunning = true;

    try {
      this.workletUrl = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' }));

      // Seed: capture every remote audio receiver on the active PeerConnection.
      // Each receiver track IS one participant's channel (the per-speaker stream).
      const pc = await this.findPeerConnection();
      if (pc) {
        const receivers = pc.getReceivers();
        console.log('[AudioCapture] Found ' + receivers.length + ' receiver(s) in PeerConnection');
        for (const r of receivers) {
          if (r.track && r.track.kind === 'audio') {
            this.connectStream(new MediaStream([r.track]));
          }
        }
        pc.addEventListener('track', (event) => {
          if (event.track && event.track.kind === 'audio') {
            console.log('[AudioCapture] New remote audio track: ' + event.track.id);
            this.connectStream(new MediaStream([event.track]));
          }
        });
      }

      // Ground truth: Google Meet renders each participant's audio as a separate
      // <audio>/<video> element whose srcObject is a live MediaStream. Discover
      // them and connect each into its own AudioContext → worklet, so every
      // participant's audio rides its own channel (no mixing, no muddling).
      this.discoverMediaElements();

      // Rescan for late joiners / recycled elements.
      this.rescanTimer = setInterval(() => {
        if (this.isRunning) this.discoverMediaElements();
      }, 5000);

      console.log('[AudioCapture] Per-channel capture started');
      return true;
    } catch (e) {
      console.error('[AudioCapture] Start failed:', e.message);
      this.onError?.(e.message);
      return false;
    }
  },

  findMediaElements() {
    return Array.from(document.querySelectorAll('audio, video')).filter((el) =>
      !el.paused &&
      el.srcObject instanceof MediaStream &&
      el.srcObject.getAudioTracks().length > 0
    );
  },

  discoverMediaElements() {
    for (const el of this.findMediaElements()) {
      const stream = el.srcObject;
      if (stream && !this.connectedStreamIds.has(stream.id)) {
        this.connectStream(stream);
      }
    }
  },

  async connectStream(stream) {
    if (!stream) return;
    const streamId = stream.id;
    if (!streamId || this.connectedStreamIds.has(streamId)) return;

    const channel = this.freedChannels.length > 0 ? this.freedChannels.shift() : this.nextChannel++;
    this.connectedStreamIds.add(streamId);
    this.channelByStream.set(streamId, channel);
    this.channelToStream.set(channel, streamId);

    try {
      const ctx = new AudioContext({ sampleRate: this.targetRate });
      // Chrome's autoplay policy can create the context SUSPENDED (no user gesture)
      // → the worklet never runs → zero PCM. Resume it explicitly.
      await ctx.resume().catch(() => {});
      await ctx.audioWorklet.addModule(this.workletUrl);
      const sourceNode = ctx.createMediaStreamSource(stream);
      const workletNode = new AudioWorkletNode(ctx, 'pcm-capture');

      workletNode.port.onmessage = (e) => {
        if (!this.isRunning) return;
        const pcm = e.data; // Float32Array @ 16kHz, 128 frames
        let peak = 0;
        for (let i = 0; i < pcm.length; i++) {
          const a = Math.abs(pcm[i]);
          if (a > peak) peak = a;
        }

        // Silence gate with hold-open: keep the channel streaming for a while after
        // its last voice so quiet frames don't fragment a speaking turn, but a
        // channel that has never spoken (or went quiet long ago) costs nothing.
        const now = Date.now();
        const lastVoice = this.streamLastVoice.get(streamId) || 0;
        if (peak > this.silenceThreshold) this.streamLastVoice.set(streamId, now);
        if (peak <= this.silenceThreshold && now - lastVoice > this.holdOpenMs) return;

        const i16 = new Int16Array(pcm.length);
        for (let i = 0; i < pcm.length; i++) {
          const s = Math.max(-1, Math.min(1, pcm[i]));
          i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }

        this.onFrame?.({
          channel,
          timestamp: now,
          sampleRate: this.targetRate,
          numberOfFrames: i16.length,
          numberOfChannels: 1,
          data: Array.from(i16),
          peak
        });
      };

      sourceNode.connect(workletNode);
      workletNode.connect(ctx.destination);

      this.contexts.set(streamId, { ctx, sourceNode, workletNode });
      console.log('[AudioCapture] Connected stream ' + streamId.substring(0, 8) + ' -> channel ' + channel);

      const track = stream.getAudioTracks()[0];
      if (track) {
        track.addEventListener('ended', () => this.disconnectStream(streamId));
      }
    } catch (err) {
      console.error('[AudioCapture] connectStream error:', err.message);
      this.disconnectStream(streamId);
    }
  },

  disconnectStream(streamId) {
    const rec = this.contexts.get(streamId);
    if (rec) {
      try { rec.workletNode.disconnect(); } catch {}
      try { rec.sourceNode.disconnect(); } catch {}
      try { rec.ctx.close(); } catch {}
      this.contexts.delete(streamId);
    }
    const channel = this.channelByStream.get(streamId);
    if (channel !== undefined) {
      this.channelToStream.delete(channel);
      if (!this.freedChannels.includes(channel)) this.freedChannels.push(channel);
    }
    this.channelByStream.delete(streamId);
    this.connectedStreamIds.delete(streamId);
    this.streamLastVoice.delete(streamId);
    console.log('[AudioCapture] Disconnected stream ' + streamId.substring(0, 8) + ' (freed channel ' + channel + ')');
  },

  async findPeerConnection() {
    console.log('[AudioCapture] Finding PeerConnection. Intercepted count: ' + (window.meetPeerConnections ? window.meetPeerConnections.length : 0));

    if (window.meetPeerConnections && window.meetPeerConnections.length > 0) {
      for (let i = 0; i < window.meetPeerConnections.length; i++) {
        const pc = window.meetPeerConnections[i];
        try {
          const receivers = pc.getReceivers();
          const audioTracks = receivers.map(r => r.track).filter(t => t);
          console.log('[AudioCapture] Intercepted PC index ' + i + ': signalingState=' + pc.signalingState + ', connectionState=' + pc.connectionState + ', audioTracksCount=' + audioTracks.length);

          if (pc.signalingState !== 'closed' && audioTracks.some(t => t.kind === 'audio' && t.readyState === 'live')) {
            console.log('[AudioCapture] Selecting intercepted PC index ' + i + ' as active connection');
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
    if (this.rescanTimer) {
      clearInterval(this.rescanTimer);
      this.rescanTimer = null;
    }
    for (const streamId of Array.from(this.contexts.keys())) {
      this.disconnectStream(streamId);
    }
    this.nextChannel = 0;
    this.freedChannels = [];
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    console.log('[AudioCapture] Per-channel capture stopped');
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
