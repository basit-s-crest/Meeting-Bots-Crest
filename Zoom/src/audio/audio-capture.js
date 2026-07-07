import { AUDIO_CONFIG } from '../config/selectors.js';

const AUDIO_CAPTURE_SCRIPT = `
window.audioCapture = {
  processor: null,
  readable: null,
  reader: null,
  onFrame: null,
  onError: null,
  isRunning: false,
  audioContexts: [],
  virtualDestinations: new Map(), // AudioContext -> MediaStreamAudioDestinationNode
  capturedTracks: new Set(),
  targetSampleRate: ${AUDIO_CONFIG.sampleRate},
  currentTrackId: null,
  currentTrackIsRaw: false,
  graphConnections: [],
  peerConnections: [],
  playoutContext: null,
  debugLogging: ${!!process.env.DEBUG},

  recordConnection(source, dest) {
    const srcName = source.constructor.name;
    const destName = dest ? dest.constructor.name : 'null';
    const connStr = srcName + ' -> ' + destName;
    if (!this.graphConnections.includes(connStr)) {
      this.graphConnections.push(connStr);
    }
  },

  init() {
    console.log('[Audio Hook] Initializing audio interceptor hook inside page/frame: ' + window.location.href);
    const self = this;

    // 1. Hook HTMLMediaElement.prototype.srcObject
    try {
      const originalSrcObjectDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'srcObject');
      if (originalSrcObjectDescriptor) {
        Object.defineProperty(HTMLMediaElement.prototype, 'srcObject', {
          set(stream) {
            console.log('[Audio Hook] HTMLMediaElement.srcObject set:', this.tagName, 'stream:', stream ? stream.id : 'null');
            if (stream instanceof MediaStream) {
              const tracks = stream.getAudioTracks();
              if (tracks.length > 0) {
                console.log('[Audio Hook] Found audio track in srcObject stream:', tracks[0].id);
                if (self.isRunning) {
                  self.captureStreamTrack(tracks[0], true);
                }
              }
            }
            return originalSrcObjectDescriptor.set.call(this, stream);
          },
          get() {
            return originalSrcObjectDescriptor.get.call(this);
          },
          configurable: true,
          enumerable: true
        });
        console.log('[Audio Hook] HTMLMediaElement.prototype.srcObject hooked successfully.');
      }
    } catch (e) {
      console.error('[Audio Hook] Failed to hook HTMLMediaElement.srcObject:', e.message);
    }

    // 2. Hook HTMLMediaElement.prototype.play
    try {
      const originalPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function() {
        console.log('[Audio Hook] HTMLMediaElement.play() called on:', this.tagName, 'srcObject:', this.srcObject ? this.srcObject.id : 'null');
        if (this.srcObject instanceof MediaStream) {
          const tracks = this.srcObject.getAudioTracks();
          if (tracks.length > 0) {
            console.log('[Audio Hook] Play call triggered capture check for track:', tracks[0].id);
            if (self.isRunning) {
              self.captureStreamTrack(tracks[0], true);
            }
          }
        }
        return originalPlay.apply(this, arguments);
      };
      console.log('[Audio Hook] HTMLMediaElement.prototype.play hooked successfully.');
    } catch (e) {
      console.error('[Audio Hook] Failed to hook HTMLMediaElement.play:', e.message);
    }

    // 3. Hook AudioContext / webkitAudioContext
    try {
      const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
      if (OriginalAudioContext) {
        self.OriginalAudioContext = OriginalAudioContext;
        window.AudioContext = window.webkitAudioContext = class extends OriginalAudioContext {
          constructor(...args) {
            super(...args);
            self.audioContexts.push(this);
            console.log('[Audio Hook] Intercepted new AudioContext creation. State:', this.state);

            try {
              const dest = this.createMediaStreamDestination();
              self.virtualDestinations.set(this, dest);
              console.log('[Audio Hook] Virtual destination created for AudioContext.');

              if (self.isRunning) {
                const track = dest.stream.getAudioTracks()[0];
                if (track) {
                  self.captureStreamTrack(track, false);
                }
              }
            } catch (e) {
              console.error('[Audio Hook] Failed to create virtual destination:', e.message);
            }
          }
        };
        console.log('[Audio Hook] AudioContext constructor hooked successfully.');
      }
    } catch (e) {
      console.error('[Audio Hook] Failed to hook AudioContext:', e.message);
    }

    // 3.5 Hook createMediaStreamSource
    try {
      const targetProto = window.AudioContext ? window.AudioContext.prototype : null;
      if (targetProto && targetProto.createMediaStreamSource) {
        const originalCreate = targetProto.createMediaStreamSource;
        targetProto.createMediaStreamSource = function(mediaStream) {
          if (self.debugLogging) {
            const tracksInfo = mediaStream ? mediaStream.getTracks().map(t => 'ID=' + t.id + ', Kind=' + t.kind + ', Label=' + t.label + ', Enabled=' + t.enabled + ', ReadyState=' + t.readyState).join('; ') : 'none';
            console.log('[Audio Hook] createMediaStreamSource() called with Stream ID: ' + (mediaStream ? mediaStream.id : 'null') + ' containing tracks: [' + tracksInfo + ']');
          }
          return originalCreate.call(this, mediaStream);
        };
        if (self.debugLogging) {
          console.log('[Audio Hook] createMediaStreamSource hooked successfully on AudioContext.prototype.');
        }
      } else {
        const baseProto = window.BaseAudioContext ? window.BaseAudioContext.prototype : null;
        if (baseProto && baseProto.createMediaStreamSource) {
          const originalCreate = baseProto.createMediaStreamSource;
          baseProto.createMediaStreamSource = function(mediaStream) {
            if (self.debugLogging) {
              const tracksInfo = mediaStream ? mediaStream.getTracks().map(t => 'ID=' + t.id + ', Kind=' + t.kind + ', Label=' + t.label + ', Enabled=' + t.enabled + ', ReadyState=' + t.readyState).join('; ') : 'none';
              console.log('[Audio Hook] createMediaStreamSource() called on BaseAudioContext with Stream ID: ' + (mediaStream ? mediaStream.id : 'null') + ' containing tracks: [' + tracksInfo + ']');
            }
            return originalCreate.call(this, mediaStream);
          };
          if (self.debugLogging) {
            console.log('[Audio Hook] createMediaStreamSource hooked successfully on BaseAudioContext.prototype.');
          }
        }
      }
    } catch (e) {
      if (self.debugLogging) {
        console.error('[Audio Hook] Failed to hook createMediaStreamSource:', e.message);
      }
    }

    // 4. Hook AudioNode.prototype.connect
    try {
      const originalConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function(destination, outputNum = 0, inputNum = 0) {
        // Record connection in our topology list
        if (self.recordConnection) {
          self.recordConnection(this, destination);
        }

        // Log every single connect call to verify Zoom's audio graph actions in real time
        if (self.debugLogging) {
          console.log('[Audio Hook] AudioNode.connect() called:', 
            this.constructor.name, 
            '->', 
            destination ? destination.constructor.name : 'null',
            '(context: ' + (this.context ? this.context.state : 'undefined') + ')'
          );
        }

        if (destination === this.context.destination) {
          const srcName = this.constructor.name;
          const isPlayout = srcName === 'e' || srcName === 'AudioWorkletNode' || (srcName !== 'MediaStreamAudioSourceNode' && srcName !== 'OscillatorNode' && srcName !== 'DynamicsCompressorNode' && srcName !== 'AnalyserNode' && srcName !== 'GainNode');
          if (isPlayout) {
            console.log('[Audio Hook] Playout connection detected from source class: ' + srcName + ' on context: ' + (this.context ? this.context.state : 'undefined'));
            self.playoutContext = this.context;
          }

          const dest = self.virtualDestinations.get(this.context);
          if (dest) {
            try {
              originalConnect.call(this, dest, outputNum, 0);
              if (self.debugLogging) {
                console.log('[Audio Hook] Mirrored connection to virtual destination.');
              }

              if (self.isRunning) {
                const track = dest.stream.getAudioTracks()[0];
                if (track) {
                  console.log('[Audio Hook] Destination connection triggering capture on track: ' + track.id + ' (isPlayout=' + isPlayout + ')');
                  self.captureStreamTrack(track, false, isPlayout);
                }
              }
            } catch (e) {
              console.error('[Audio Hook] Mirror connection failed:', e.message);
            }
          }
        }
        return originalConnect.call(this, destination, outputNum, inputNum);
      };
      console.log('[Audio Hook] AudioNode.prototype.connect hooked successfully.');
    } catch (e) {
      console.error('[Audio Hook] Failed to hook AudioNode.prototype.connect:', e.message);
    }

    // 5. Hook RTCPeerConnection to track all remote streams
    try {
      const OriginalRTCPeerConnection = window.RTCPeerConnection;
      if (OriginalRTCPeerConnection) {
        const pcWrapper = function(...args) {
          const pc = new OriginalRTCPeerConnection(...args);
          console.log('[Audio Hook] New RTCPeerConnection instance created.');
          self.peerConnections.push(pc);

          // Listen to track events on this instance directly
          try {
            pc.addEventListener('track', (event) => {
              console.log('[Audio Hook] PeerConnection "track" event received:', event);
              if (event.track) {
                console.log('[Audio Hook] Dynamic Track Details - Kind: ' + event.track.kind + ', ID: ' + event.track.id + ', Label: ' + event.track.label + ', Enabled: ' + event.track.enabled + ', ReadyState: ' + event.track.readyState + ', Muted: ' + event.track.muted);
                if (event.track.kind === 'audio' && event.track.readyState === 'live' && event.track.enabled === true) {
                  console.log('[Audio Hook] Found remote track on RTCPeerConnection instance:', event.track.id, 'Label:', event.track.label);
                  if (self.isRunning) {
                    self.captureStreamTrack(event.track, true);
                  }
                }
              }
            });
          } catch (err) {
            console.error('[Audio Hook] Failed to bind track listener in constructor:', err.message);
          }

          return pc;
        };

        // Copy prototype and static properties to match standard RTCPeerConnection class topology
        pcWrapper.prototype = OriginalRTCPeerConnection.prototype;
        Object.defineProperty(pcWrapper, 'prototype', { writable: false });
        for (const prop of Object.getOwnPropertyNames(OriginalRTCPeerConnection)) {
          if (prop !== 'prototype' && prop !== 'name' && prop !== 'length') {
            Object.defineProperty(pcWrapper, prop, Object.getOwnPropertyDescriptor(OriginalRTCPeerConnection, prop));
          }
        }
        window.RTCPeerConnection = pcWrapper;
        console.log('[Audio Hook] window.RTCPeerConnection constructor hooked successfully.');
      }
    } catch (e) {
      console.error('[Audio Hook] Failed to hook RTCPeerConnection constructor:', e.message);
    }
  },

  async start(onFrameCallback, onErrorCallback) {
    console.log('[Audio Hook] start() called inside frame: ' + window.location.href);
    this.onFrame = onFrameCallback;
    this.onError = onErrorCallback;
    this.isRunning = true;

    // Helper to query all elements matching selectors, traversing any open shadow roots
    const queryAllShadow = (selectors) => {
      const elements = [];
      const find = (root) => {
        if (!root) return;
        const matches = root.querySelectorAll(selectors);
        elements.push(...matches);
        const all = root.querySelectorAll('*');
        all.forEach(el => {
          if (el.shadowRoot) {
            find(el.shadowRoot);
          }
        });
      };
      find(document);
      return elements;
    };

    const scanForAudioElement = () => {
      const mediaElements = queryAllShadow('audio');
      for (const el of mediaElements) {
        const stream = el.srcObject;
        if (stream instanceof MediaStream) {
          const tracks = stream.getAudioTracks();
          if (tracks.length > 0) {
            const track = tracks[0];
            if (track && track.readyState === 'live' && track.enabled === true) {
              const isZoomAudio = el.id && el.id.includes('zoom-audio-tag');
              const isCallAudio = isZoomAudio || !el.id || !el.id.includes('preview');
              if (isCallAudio) {
                return { track, el };
              }
            }
          }
        }
      }
      return null;
    };

    try {
      // 0. Broad Diagnostic Dump (Only runs if debugLogging is active)
      if (this.debugLogging) {
        try {
          const allAudio = queryAllShadow('audio');
          const allVideo = queryAllShadow('video');
          console.log('[Audio Diagnostic] Frame URL: ' + window.location.href);
          console.log('[Audio Diagnostic] Total <audio> elements: ' + allAudio.length);
          allAudio.forEach((el, index) => {
            const stream = el.srcObject;
            const streamId = stream ? stream.id : 'null';
            let tracksInfo = 'none';
            if (stream instanceof MediaStream) {
              tracksInfo = stream.getTracks().map(t => 'ID=' + t.id + ', Kind=' + t.kind + ', ReadyState=' + t.readyState + ', Enabled=' + t.enabled + ', Muted=' + t.muted).join('; ');
            }
            console.log('[Audio Diagnostic] <audio>[' + index + ']: ID="' + (el.id || '') + '", Class="' + (el.className || '') + '", src="' + (el.src || '') + '", srcObject="' + streamId + '", Tracks=[' + tracksInfo + '], Muted=' + el.muted + ', Volume=' + el.volume + ', Paused=' + el.paused);
          });
          console.log('[Audio Diagnostic] Total <video> elements: ' + allVideo.length);
          allVideo.forEach((el, index) => {
            const stream = el.srcObject;
            const streamId = stream ? stream.id : 'null';
            let tracksInfo = 'none';
            if (stream instanceof MediaStream) {
              tracksInfo = stream.getTracks().map(t => 'ID=' + t.id + ', Kind=' + t.kind + ', ReadyState=' + t.readyState + ', Enabled=' + t.enabled + ', Muted=' + t.muted).join('; ');
            }
            console.log('[Audio Diagnostic] <video>[' + index + ']: ID="' + (el.id || '') + '", Class="' + (el.className || '') + '", src="' + (el.src || '') + '", srcObject="' + streamId + '", Tracks=[' + tracksInfo + '], Muted=' + el.muted + ', Volume=' + el.volume + ', Paused=' + el.paused);
          });
        } catch (diagErr) {
          console.error('[Audio Diagnostic] Failed to run diagnostic dump:', diagErr.message);
        }
      }

      let captured = false;

      // Priority 1: Scan for live call audio element with retries (Fix 2)
      const maxAttempts = 10;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        console.log('[Audio Hook] Scanning for live call audio element (attempt ' + attempt + '/' + maxAttempts + ')...');
        const found = scanForAudioElement();
        if (found) {
          console.log('[Audio Hook] start(): Found live call audio track: ' + found.track.id + ' on attempt ' + attempt);
          this.captureStreamTrack(found.track, true);
          captured = true;
          break;
        }
        if (attempt < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      }

      // Priority 2: Scan PeerConnections for live remote audio tracks (Fix 7)
      if (!captured) {
        console.log('[Audio Hook] start(): Scanning ' + this.peerConnections.length + ' existing PeerConnections...');
        for (const pc of this.peerConnections) {
          try {
            const receivers = pc.getReceivers();
            console.log('[Audio Hook] start(): PC has ' + receivers.length + ' receivers.');
            for (const receiver of receivers) {
              const track = receiver.track;
              if (track) {
                if (this.debugLogging) {
                  console.log('[Audio Hook] start(): PC Receiver Track details - Kind: ' + track.kind + ', ID: ' + track.id + ', ReadyState: ' + track.readyState + ', Enabled: ' + track.enabled + ', Muted: ' + track.muted + ', Label: ' + track.label);
                }
                if (track.kind === 'audio' && track.readyState === 'live' && track.enabled === true) {
                  console.log('[Audio Hook] start(): Found remote track in existing PeerConnection receiver: ' + track.id + ' Label: ' + track.label);
                  this.captureStreamTrack(track, true);
                  captured = true;
                }
              }
            }
          } catch (err) {
            console.error('[Audio Hook] Failed to scan existing PeerConnection receivers:', err.message);
          }
        }
      }

      // Priority 3: Fall back to detected playoutContext (Fix 6)
      if (!captured) {
        if (this.playoutContext) {
          const dest = this.virtualDestinations.get(this.playoutContext);
          const track = dest ? dest.stream.getAudioTracks()[0] : null;
          if (track) {
            console.log('[Audio Hook] start(): Prioritizing detected playout AudioContext destination:', track.id);
            this.captureStreamTrack(track, false, true); // force=true
            captured = true;
          }
        } else {
          console.log('[Audio Hook] start(): No playout playoutContext has been detected yet.');
        }
      }

      if (!captured) {
        console.warn('[Audio Hook] start(): No active audio sources could be locked at launch. Relying on dynamic connection triggers or poller.');
      }

      // 4. Scan standard media elements and PeerConnections for existing tracks (with continuous polling loop)
      const scanAndAttemptCapture = async () => {
        // 1. Scan for raw audio element
        const raw = scanForAudioElement();
        if (raw) {
          if (!this.capturedTracks.has(raw.track.id)) {
            console.log('[Audio Hook] Poller selected live call audio track: ' + raw.track.id);
            this.captureStreamTrack(raw.track, true);
            return;
          }
        }

        // 2. Scan PeerConnection receivers
        this.peerConnections.forEach(pc => {
          try {
            pc.getReceivers().forEach(receiver => {
              const track = receiver.track;
              if (track && track.kind === 'audio' && track.readyState === 'live' && track.enabled === true) {
                if (!this.capturedTracks.has(track.id)) {
                  console.log('[Audio Hook] Poller selected PeerConnection audio track: ' + track.id);
                  this.captureStreamTrack(track, true);
                  return;
                }
              }
            });
          } catch (e) {}
        });

        // 3. Playout context destination fallback
        if (this.playoutContext) {
          const dest = this.virtualDestinations.get(this.playoutContext);
          const track = dest ? dest.stream.getAudioTracks()[0] : null;
          if (track && !this.capturedTracks.has(track.id)) {
            console.log('[Audio Hook] Poller selected playout AudioContext track: ' + track.id);
            this.captureStreamTrack(track, false, true); // force = true
          }
        }
      };

      const runPoller = async () => {
        console.log('[Audio Hook] Starting continuous background media poller...');
        while (this.isRunning) {
          try {
            await scanAndAttemptCapture();
          } catch (e) {
            console.error('[Audio Hook] Poller iteration failed:', e.message);
          }
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        console.log('[Audio Hook] Continuous media poller stopped.');
      };

      runPoller();
      return true;
    } catch (e) {
      console.error('[Audio Hook] start() scan failed:', e.message);
      this.onError?.('[Audio Hook] start() error: ' + e.message);
      return false;
    }
  },

  async stopTrack() {
    this.isRunning = false;
    if (this.reader) {
      try {
        await this.reader.cancel().catch(() => {});
        this.reader.releaseLock();
      } catch (e) {}
    }
    this.processor = null;
    this.readable = null;
    this.reader = null;
    if (this.resamplerCtx) {
      try {
        await this.resamplerCtx.close().catch(() => {});
      } catch (e) {}
      this.resamplerCtx = null;
    }
  },

  async captureStreamTrack(track, isRawMedia, force = false) {
    const isRaw = !!isRawMedia;
    
    // Guard 1: Already capturing or setting up this track
    if (this.currentTrackId === track.id) {
      return;
    }
    
    if (!force) {
      // Guard 2: Already capturing a raw track, ignore non-raw Web Audio switches (upgrade lock)
      if (this.currentTrackId && this.currentTrackIsRaw && !isRaw) {
        console.log('[Audio Hook] Ignoring Web Audio track switch request (holding onto raw WebRTC track: ' + this.currentTrackId + ')');
        return;
      }

      // Guard 3: Already capturing a Web Audio track, ignore other Web Audio tracks (prevent racy switching)
      if (this.currentTrackId && !this.currentTrackIsRaw && !isRaw) {
        return;
      }
    } else {
      if (this.debugLogging) {
        console.log('[Audio Hook] Force-capture requested. Overriding existing track capture locks.');
      }
    }

    // Lock track identity early to prevent re-entrant race conditions during async setup
    const prevTrackId = this.currentTrackId;
    this.currentTrackId = track.id;
    this.currentTrackIsRaw = isRaw;

    console.log('[Audio Hook] captureStreamTrack() starting for track: ' + track.id + ' (isRawMedia: ' + isRaw + ')');

    try {
      if (this.processor || prevTrackId) {
        console.log('[Audio Hook] Stopping existing track processor: ' + prevTrackId);
        await this.stopTrack();
      }

      // Create a native AudioContext running at 16kHz for proper resampling and mixdown
      const ResamplerCtxClass = this.OriginalAudioContext || window.AudioContext || window.webkitAudioContext;
      const resamplerCtx = new ResamplerCtxClass({ sampleRate: this.targetSampleRate });
      this.resamplerCtx = resamplerCtx; // Keep a reference to prevent garbage collection

      // Source stream wrapping the incoming track
      const sourceStream = new MediaStream([track]);
      const sourceNode = resamplerCtx.createMediaStreamSource(sourceStream);

      // Destination stream at 16kHz explicitly mixed to Mono (1 channel)
      const destNode = resamplerCtx.createMediaStreamDestination();
      destNode.channelCount = 1;
      destNode.channelCountMode = 'explicit';
      destNode.channelInterpretation = 'speakers';

      sourceNode.connect(destNode);
      console.log('[Audio Hook] Resampler AudioContext pipeline wired successfully.');

      const resampledTrack = destNode.stream.getAudioTracks()[0];

      this.processor = new MediaStreamTrackProcessor({ track: resampledTrack });
      console.log('[Audio Hook] MediaStreamTrackProcessor created successfully on resampled track.');
      
      this.readable = this.processor.readable;
      this.reader = this.readable.getReader();
      console.log('[Audio Hook] Stream reader acquired.');
      
      this.readLoop();
    } catch (e) {
      console.error('[Audio Hook] captureStreamTrack failed:', e);
      this.currentTrackId = null;
      this.currentTrackIsRaw = false;
      this.onError?.('[Audio Hook] MediaStreamTrackProcessor initialization error: ' + e.message);
    }
  },

  async readLoop() {
    console.log('[Audio Hook] Entering readLoop...');
    try {
      while (this.isRunning && this.reader) {
        const { done, value } = await this.reader.read();
        if (done) {
          console.log('[Audio Hook] Read loop finished.');
          break;
        }

        if (value instanceof AudioData) {
          const sampleRate = value.sampleRate;
          const numberOfFrames = value.numberOfFrames;
          const format = value.format;

          let pcmData;
          if (format.includes('f32')) {
            const f32Buffer = new Float32Array(numberOfFrames);
            value.copyTo(f32Buffer, { planeIndex: 0 });

            pcmData = new Int16Array(numberOfFrames);
            for (let i = 0; i < numberOfFrames; i++) {
              let s = Math.max(-1, Math.min(1, f32Buffer[i]));
              pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
          } else {
            pcmData = new Int16Array(numberOfFrames);
            value.copyTo(pcmData, { planeIndex: 0 });
          }

          this.onFrame?.({
            timestamp: value.timestamp,
            sampleRate: sampleRate,
            numberOfFrames: pcmData.length,
            numberOfChannels: 1,
            data: Array.from(pcmData)
          });

          value.close();
        }
      }
    } catch (e) {
      console.error('[Audio Hook] Error in readLoop:', e.message);
      this.onError?.('[Audio Hook] Read loop runtime error: ' + e.message);
    }
  },

  stop() {
    this.isRunning = false;
    this.reader?.releaseLock();
    this.processor = null;
    this.readable = null;
    this.reader = null;
    this.capturedTracks.clear();
    this.currentTrackId = null;
    this.currentTrackIsRaw = false;
    if (this.resamplerCtx) {
      try {
        this.resamplerCtx.close().catch(() => {});
      } catch (e) {}
      this.resamplerCtx = null;
    }
    console.log('[Audio Hook] Audio capture stopped.');
    if (this.debugLogging) {
      console.log('[Audio Graph Topology] Full topology summary: ' + JSON.stringify(this.graphConnections));
    }
  }
};
window.audioCapture.init();
`;

export class AudioCapture {
  constructor(page) {
    this.page = page;
    this.isCapturing = false;
  }

  async initialize() {
    console.log('[Audio Capture] Initializing context-level hooks across all frames...');
    this.isCapturing = false;

    // We register the init script on the context so it propagates to all subframes and pages cleanly
    await this.page.context().addInitScript(AUDIO_CAPTURE_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onAudioFrame', this.onFrame.bind(this)).catch(() => {});
    await this.page.exposeFunction('onAudioError', this.onError.bind(this)).catch(() => {});
    
    // Listen for dynamically created or navigated frames during an active session
    this.page.on('frameattached', async (frame) => {
      if (this.isCapturing) {
        console.log(`[Audio Capture] New frame detected mid-session, attempting capture: \${frame.url()}`);
        await this.startFrameCapture(frame);
      }
    });

    this.page.on('framenavigated', async (frame) => {
      if (this.isCapturing) {
        console.log(`[Audio Capture] Frame navigation detected mid-session, attempting capture: \${frame.url()}`);
        await this.startFrameCapture(frame);
      }
    });

    // Immediately evaluate on existing frames to prevent early connection race conditions
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(AUDIO_CAPTURE_SCRIPT).catch(() => {});
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async startFrameCapture(frame) {
    try {
      await frame.waitForLoadState('domcontentloaded').catch(() => {});
      const hasCapture = await frame.evaluate(() => typeof window.audioCapture !== 'undefined').catch(() => false);
      if (hasCapture) {
        console.log(`[Audio Capture] Found window.audioCapture in: ${frame.url()}`);
        return await frame.evaluate(() => {
          try {
            if (!window.audioCapture.isRunning) {
              return window.audioCapture.start(
                (frame) => window.onAudioFrame(frame),
                (err) => window.onAudioError(err)
              );
            }
            return true;
          } catch (e) {
            console.error('[Audio Capture Frame Start Error]:', e.message);
            return false;
          }
        });
      }
    } catch (err) {
      // Ignore cross-origin frame access limits
    }
    return false;
  }

  async start() {
    this.isCapturing = true;
    const frames = this.page.frames();
    let started = false;
    console.log(`[Audio Capture] Starting audio capture in matching contexts across ${frames.length} frames...`);
    
    for (const frame of frames) {
      const result = await this.startFrameCapture(frame);
      if (result) {
        started = true;
      }
    }
    
    if (!started) {
      console.warn('[Audio Capture] Warning: No frames responded to start() request.');
    }
    return started;
  }

  async stop() {
    this.isCapturing = false;
    const frames = this.page.frames();
    console.log('[Audio Capture] Stopping audio capture across all frames...');
    for (const frame of frames) {
      try {
        const hasCapture = await frame.evaluate(() => typeof window.audioCapture !== 'undefined').catch(() => false);
        if (hasCapture) {
          await frame.evaluate(() => window.audioCapture.stop()).catch(() => {});
        }
      } catch (e) {
        // ignore
      }
    }
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
