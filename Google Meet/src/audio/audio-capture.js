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
  contexts: new Map(),            // trackId -> { ctx, sourceNode, workletNode }
  connectedTrackIds: new Set(),   // trackId -> true (dedup: receiver + <audio> element share the same track)
  channelByTrack: new Map(),      // trackId -> channel index
  channelToTrack: new Map(),      // channel index -> trackId
  trackLastVoice: new Map(),      // trackId -> last voice timestamp (ms)
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
      const track = stream && stream.getAudioTracks()[0];
      // Dedup by TRACK id, not stream id: the receiver track and this <audio>
      // element's stream are the SAME underlying track (same track.id), so keying
      // by stream.id would capture the same person's audio twice.
      if (track && !this.connectedTrackIds.has(track.id)) {
        this.connectStream(stream);
      }
    }
  },

  async connectStream(stream) {
    if (!stream) return;
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const trackId = track.id;
    if (!trackId || this.connectedTrackIds.has(trackId)) return;

    const channel = this.freedChannels.length > 0 ? this.freedChannels.shift() : this.nextChannel++;
    this.connectedTrackIds.add(trackId);
    this.channelByTrack.set(trackId, channel);
    this.channelToTrack.set(channel, trackId);

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
        const lastVoice = this.trackLastVoice.get(trackId) || 0;
        if (peak > this.silenceThreshold) this.trackLastVoice.set(trackId, now);
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

      this.contexts.set(trackId, { ctx, sourceNode, workletNode });
      console.log('[AudioCapture] Connected track ' + trackId.substring(0, 8) + ' -> channel ' + channel);

      track.addEventListener('ended', () => this.disconnectStream(trackId));
    } catch (err) {
      console.error('[AudioCapture] connectStream error:', err.message);
      this.disconnectStream(trackId);
    }
  },

  disconnectStream(trackId) {
    const rec = this.contexts.get(trackId);
    if (rec) {
      try { rec.workletNode.disconnect(); } catch {}
      try { rec.sourceNode.disconnect(); } catch {}
      try { rec.ctx.close(); } catch {}
      this.contexts.delete(trackId);
    }
    const channel = this.channelByTrack.get(trackId);
    if (channel !== undefined) {
      this.channelToTrack.delete(channel);
      if (!this.freedChannels.includes(channel)) this.freedChannels.push(channel);
    }
    this.channelByTrack.delete(trackId);
    this.connectedTrackIds.delete(trackId);
    this.trackLastVoice.delete(trackId);
    console.log('[AudioCapture] Disconnected track ' + trackId.substring(0, 8) + ' (freed channel ' + channel + ')');
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
    for (const trackId of Array.from(this.contexts.keys())) {
      this.disconnectStream(trackId);
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
