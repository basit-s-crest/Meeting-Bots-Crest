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
                  self.captureStreamTrack(tracks[0]);
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
              self.captureStreamTrack(tracks[0]);
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
                  self.captureStreamTrack(track);
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

    // 4. Hook AudioNode.prototype.connect
    try {
      const originalConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function(destination, outputNum = 0, inputNum = 0) {
        // Log every single connect call to verify Zoom's audio graph actions in real time
        console.log('[Audio Hook] AudioNode.connect() called:', 
          this.constructor.name, 
          '->', 
          destination ? destination.constructor.name : 'null',
          '(context: ' + (this.context ? this.context.state : 'undefined') + ')'
        );

        if (destination === this.context.destination) {
          const dest = self.virtualDestinations.get(this.context);
          if (dest) {
            try {
              originalConnect.call(this, dest, outputNum, 0);
              console.log('[Audio Hook] Mirrored connection to virtual destination.');

              if (self.isRunning) {
                const track = dest.stream.getAudioTracks()[0];
                if (track) {
                  self.captureStreamTrack(track);
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
  },

  async start(onFrameCallback, onErrorCallback) {
    console.log('[Audio Hook] start() called inside frame: ' + window.location.href);
    this.onFrame = onFrameCallback;
    this.onError = onErrorCallback;
    this.isRunning = true;

    try {
      // 1. Scan existing virtual destinations
      for (const [context, dest] of this.virtualDestinations.entries()) {
        const track = dest.stream.getAudioTracks()[0];
        if (track) {
          console.log('[Audio Hook] start(): Found track in existing AudioContext destination:', track.id);
          this.captureStreamTrack(track);
          return true;
        }
      }

      // 2. Scan standard media elements for existing tracks
      const mediaElements = document.querySelectorAll('audio, video');
      console.log('[Audio Hook] start(): Found standard media elements count: ' + mediaElements.length);
      
      let selectedTrack = null;
      mediaElements.forEach((el, index) => {
        const stream = el.srcObject;
        const streamId = stream ? stream.id : 'null';
        const srcUrl = el.src || 'none';
        let audioTrackDetails = 'none';
        
        if (stream instanceof MediaStream) {
          const tracks = stream.getAudioTracks();
          if (tracks.length > 0) {
            audioTrackDetails = tracks.map(t => 'ID=' + t.id + ', Label=' + t.label + ', Enabled=' + t.enabled + ', ReadyState=' + t.readyState).join('; ');
            // Heuristic: Capture the first unmuted audio element with positive volume (incoming call audio)
            if (!selectedTrack && el.tagName.toLowerCase() === 'audio' && el.muted === false && el.volume > 0) {
              selectedTrack = tracks[0];
            }
          }
        }
        
        console.log('[Audio Hook] MediaElement[' + index + ']: Tag=' + el.tagName + ', ID="' + (el.id || '') + '", Class="' + (el.className || '') + '", src="' + srcUrl + '", srcObjectID="' + streamId + '", AudioTracks=[' + audioTrackDetails + '], Muted=' + el.muted + ', Volume=' + el.volume + ', Paused=' + el.paused);
      });

      if (selectedTrack) {
        console.log('[Audio Hook] start(): Selected call audio track for capture:', selectedTrack.id);
        this.captureStreamTrack(selectedTrack);
      } else {
        // Fallback to first found track if heuristic fails
        for (const el of mediaElements) {
          if (el.srcObject instanceof MediaStream) {
            const tracks = el.srcObject.getAudioTracks();
            if (tracks.length > 0) {
              console.log('[Audio Hook] start() Fallback: Capturing first available track:', tracks[0].id);
              this.captureStreamTrack(tracks[0]);
              break;
            }
          }
        }
      }

      return true;
    } catch (e) {
      console.error('[Audio Hook] start() scan failed:', e.message);
      this.onError?.('[Audio Hook] start() error: ' + e.message);
      return false;
    }
  },

  captureStreamTrack(track) {
    if (this.capturedTracks.has(track.id)) {
      console.log('[Audio Hook] Already capturing track:', track.id);
      return;
    }
    this.capturedTracks.add(track.id);
    console.log('[Audio Hook] captureStreamTrack() starting for track:', track.id);

    try {
      if (this.processor) {
        console.log('[Audio Hook] Stopping existing track processor...');
        this.stop();
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
    if (this.resamplerCtx) {
      try {
        this.resamplerCtx.close().catch(() => {});
      } catch (e) {}
      this.resamplerCtx = null;
    }
    console.log('[Audio Hook] Audio capture stopped.');
  }
};
`;

export class AudioCapture {
  constructor(page) {
    this.page = page;
  }

  async initialize() {
    console.log('[Audio Capture] Initializing context-level hooks across all frames...');
    // We register the init script on the context so it propagates to all subframes and pages cleanly
    await this.page.context().addInitScript(AUDIO_CAPTURE_SCRIPT).catch(() => {});
    await this.page.exposeFunction('onAudioFrame', this.onFrame.bind(this)).catch(() => {});
    await this.page.exposeFunction('onAudioError', this.onError.bind(this)).catch(() => {});
    
    // Immediately evaluate on existing frames to prevent early connection race conditions
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        await frame.evaluate(AUDIO_CAPTURE_SCRIPT).catch(() => {});
        await frame.evaluate(() => {
          if (window.audioCapture) {
            window.audioCapture.init();
          }
        }).catch(() => {});
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async start() {
    const frames = this.page.frames();
    let started = false;
    console.log(`[Audio Capture] Starting audio capture in matching contexts across ${frames.length} frames...`);
    
    for (const frame of frames) {
      try {
        const hasCapture = await frame.evaluate(() => typeof window.audioCapture !== 'undefined').catch(() => false);
        if (hasCapture) {
          console.log(`[Audio Capture] Found window.audioCapture in: ${frame.url()}`);
          
          const result = await frame.evaluate(() => {
            try {
              return window.audioCapture.start(
                (frame) => window.onAudioFrame(frame),
                (err) => window.onAudioError(err)
              );
            } catch (e) {
              console.error('[Audio Capture Frame Start Error]:', e.message);
              return false;
            }
          });
          
          if (result) {
            started = true;
          }
        }
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
    
    if (!started) {
      console.warn('[Audio Capture] Warning: No frames responded to start() request.');
    }
    return started;
  }

  async stop() {
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
