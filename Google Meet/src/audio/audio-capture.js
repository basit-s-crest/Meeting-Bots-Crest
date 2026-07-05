import { AUDIO_CONFIG } from '../config/selectors.js';

const AUDIO_CAPTURE_SCRIPT = `
window.audioCapture = {
  processor: null,
  readable: null,
  writer: null,
  onFrame: null,
  onError: null,
  isRunning: false,

  async start(onFrameCallback, onErrorCallback) {
    this.onFrame = onFrameCallback;
    this.onError = onErrorCallback;
    
    try {
      const pc = await this.findPeerConnection();
      if (!pc) throw new Error('RTCPeerConnection not found');

      const receivers = pc.getReceivers();
      const audioReceiver = receivers.find(r => r.track?.kind === 'audio');
      if (!audioReceiver?.track) throw new Error('No remote audio track');

      this.processor = new MediaStreamTrackProcessor({ track: audioReceiver.track });
      this.readable = this.processor.readable;
      this.writer = this.readable.getWriter();
      
      this.isRunning = true;
      this.readLoop();
      return true;
    } catch (e) {
      this.onError?.(e.message);
      return false;
    }
  },

  async readLoop() {
    try {
      while (this.isRunning) {
        const { done, value } = await this.writer.read();
        if (done) break;
        if (value instanceof AudioData) {
          this.onFrame?.({
            timestamp: value.timestamp,
            sampleRate: value.sampleRate,
            numberOfFrames: value.numberOfFrames,
            numberOfChannels: value.numberOfChannels,
            data: Array.from(new Int16Array(value.data))
          });
          value.close();
        }
      }
    } catch (e) {
      this.onError?.(e.message);
    }
  },

  async findPeerConnection() {
    // Try multiple strategies to find the peer connection
    
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
            return obj;
          }
        }
      } catch {}
    }

    return null;
  },

  stop() {
    this.isRunning = false;
    this.writer?.releaseLock();
    this.processor = null;
    this.readable = null;
    this.writer = null;
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