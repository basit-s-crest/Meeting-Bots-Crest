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
  currentTrackSelectionTime: 0, // When current track was selected (for stability guard)
  graphConnections: [],
  peerConnections: [],
  playoutContext: null,
  debugLogging: ${!!process.env.DEBUG},
  
  // RMS-based liveness tracking
  trackRMSHistory: new Map(), // trackId -> [recent RMS values]
  trackFirstSeenTime: new Map(), // trackId -> timestamp when first discovered
  trackLastSeenTime: new Map(), // trackId -> timestamp when last seen
  lastMapSizeLogTime: 0,
  RMS_HISTORY_SIZE: 5, // Keep last 5 RMS readings
  RMS_SILENCE_THRESHOLD: 10, // RMS below this = silence
  RMS_MIN_LIVE_READINGS: 3, // Need at least 3 non-silent readings
  TRACK_GRACE_PERIOD_MS: 1000, // New tracks get 1s to produce audio
  TRACK_STABILITY_PERIOD_MS: 2000, // Don't switch away from healthy track for 2s

  queryAllShadow(selectors) {
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
  },

  scanForAudioElement() {
    const mediaElements = this.queryAllShadow('audio');
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
  },

  recordConnection(source, dest) {
    const srcName = source.constructor.name;
    const destName = dest ? dest.constructor.name : 'null';
    const connStr = srcName + ' -> ' + destName;
    if (!this.graphConnections.includes(connStr)) {
      this.graphConnections.push(connStr);
    }
  },
  
  /**
   * Update RMS history for a track
   */
  updateTrackRMS(trackId, rms) {
    this.trackLastSeenTime.set(trackId, Date.now());
    if (!this.trackRMSHistory.has(trackId)) {
      this.trackRMSHistory.set(trackId, []);
    }
    const history = this.trackRMSHistory.get(trackId);
    history.push(rms);
    if (history.length > this.RMS_HISTORY_SIZE) {
      history.shift();
    }

    // Check if the current track has gone dead (2+ consecutive 0.00 readings)
    if (trackId === this.currentTrackId && history.length >= 2) {
      const last = history[history.length - 1];
      const prev = history[history.length - 2];
      if (last === 0 && prev === 0) {
        console.warn('[Audio Hook] Current track ' + trackId + ' went silent (2 consecutive 0.00 RMS readings). Triggering immediate candidate evaluation...');
        this.scanAndAttemptCapture().catch((e) => {
          console.error('[Audio Hook] Immediate poller trigger failed:', e.message);
        });
      }
    }
  },

  removeTrackFromLiveness(trackId) {
    let deleted = false;
    if (this.trackRMSHistory.has(trackId)) {
      this.trackRMSHistory.delete(trackId);
      deleted = true;
    }
    if (this.trackFirstSeenTime.has(trackId)) {
      this.trackFirstSeenTime.delete(trackId);
      deleted = true;
    }
    if (this.trackLastSeenTime.has(trackId)) {
      this.trackLastSeenTime.delete(trackId);
      deleted = true;
    }
    if (deleted) {
      console.log('[Audio Hook] Cleaned up ended/removed track ' + trackId + ' from liveness tracking Maps.');
    }
  },
  
  /**
   * Check if a track is producing audio (liveness check)
   */
  isTrackProducingAudio(trackId) {
    const now = Date.now();
    
    // Check if track is brand new (within grace period)
    const firstSeen = this.trackFirstSeenTime.get(trackId);
    if (!firstSeen) {
      // Never seen this track before, give it grace period
      this.trackFirstSeenTime.set(trackId, now);
      return true; // Provisionally eligible
    }
    
    const age = now - firstSeen;
    
    // Grace period expired, check RMS history
    const history = this.trackRMSHistory.get(trackId);
    
    // Rule 2: Most recent 1-2 RMS readings being exactly 0.00 should immediately disqualify it
    if (history && history.length > 0) {
      const checkCount = Math.min(2, history.length);
      let zeroCount = 0;
      for (let i = 0; i < checkCount; i++) {
        if (history[history.length - 1 - i] === 0) {
          zeroCount++;
        }
      }
      if (zeroCount === checkCount) {
        return false; // Disqualified due to recent silence
      }
    }

    if (age < this.TRACK_GRACE_PERIOD_MS) {
      // Still within grace period, give it a chance
      return true;
    }
    
    if (!history || history.length === 0) {
      // No RMS data after grace period = dead track
      return false;
    }
    
    // Count how many recent readings were above silence threshold
    const recentNonSilent = history.filter(rms => rms > this.RMS_SILENCE_THRESHOLD).length;
    return recentNonSilent >= this.RMS_MIN_LIVE_READINGS;
  },
  
  /**
   * Compare candidate A and B for tie-breaking based on priority, grace period, and RMS liveness.
   * Returns positive if a is better, negative if b is better, 0 if equal.
   */
  compareCandidates(a, b) {
    // 1. Priority first
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }

    const now = Date.now();
    
    // Check grace period and samples for candidate a
    const aFirstSeen = this.trackFirstSeenTime.get(a.track.id) || now;
    const aIsWithinGrace = (now - aFirstSeen) < this.TRACK_GRACE_PERIOD_MS;
    const aHistory = this.trackRMSHistory.get(a.track.id) || [];
    const aHasNoSamples = aHistory.length === 0;
    const aIsNewWithNoSamples = aIsWithinGrace && aHasNoSamples;

    // Check grace period and samples for candidate b
    const bFirstSeen = this.trackFirstSeenTime.get(b.track.id) || now;
    const bIsWithinGrace = (now - bFirstSeen) < this.TRACK_GRACE_PERIOD_MS;
    const bHistory = this.trackRMSHistory.get(b.track.id) || [];
    const bHasNoSamples = bHistory.length === 0;
    const bIsNewWithNoSamples = bIsWithinGrace && bHasNoSamples;

    // Rule 3: Grace period tie-breaking (compare against the other's recent liveness)
    if (aIsNewWithNoSamples && !bIsNewWithNoSamples) {
      // a is new, b is established. Compare against b's last reading.
      const bLastReading = bHistory.length > 0 ? bHistory[bHistory.length - 1] : 0;
      const bIsSilent = bLastReading <= this.RMS_SILENCE_THRESHOLD;
      if (bIsSilent) {
        // b is silent, so new track a should win.
        return 1; 
      } else {
        // b is active, so b should win.
        return -1;
      }
    }

    if (bIsNewWithNoSamples && !aIsNewWithNoSamples) {
      // b is new, a is established. Compare against a's last reading.
      const aLastReading = aHistory.length > 0 ? aHistory[aHistory.length - 1] : 0;
      const aIsSilent = aLastReading <= this.RMS_SILENCE_THRESHOLD;
      if (aIsSilent) {
        // a is silent, so new track b should win.
        return -1;
      } else {
        // a is active, so a should win.
        return 1;
      }
    }

    // If both are new with no samples, or both have samples:
    // Tie-break using average RMS
    const avgA = this.getAverageRMS(a.track.id);
    const avgB = this.getAverageRMS(b.track.id);
    return avgA - avgB;
  },
  
  /**
   * Get average recent RMS for tie-breaking
   */
  getAverageRMS(trackId) {
    const history = this.trackRMSHistory.get(trackId);
    if (!history || history.length === 0) {
      return 0;
    }
    const sum = history.reduce((a, b) => a + b, 0);
    return sum / history.length;
  },

  async scanAndAttemptCapture() {
    const now = Date.now();
    const candidates = [];

    // Helper to check track liveness
    const isLive = (track) => {
      return track.readyState === 'live' && track.enabled === true;
    };

    // 1. Scan for raw audio element
    const raw = this.scanForAudioElement();
    if (raw && isLive(raw.track)) {
      candidates.push({ 
        track: raw.track, 
        isRaw: true, 
        priority: 3, 
        source: 'audio-element' 
      });
    }

    // 2. Scan PeerConnection receivers  
    this.peerConnections.forEach(pc => {
      try {
        pc.getReceivers().forEach(receiver => {
          const track = receiver.track;
          if (track && track.kind === 'audio' && isLive(track)) {
            candidates.push({ 
              track: track, 
              isRaw: true, 
              priority: 3, 
              source: 'peerconnection' 
            });
          }
        });
      } catch (e) {}
    });

    // 3. Playout context destination fallback
    if (this.playoutContext) {
      const dest = this.virtualDestinations.get(this.playoutContext);
      const track = dest ? dest.stream.getAudioTracks()[0] : null;
      if (track && isLive(track)) {
        candidates.push({ 
          track: track, 
          isRaw: false, 
          priority: 1, 
          source: 'playout-context' 
        });
      }
    }

    // Update last seen time for all scanned candidates
    candidates.forEach(c => {
      this.trackLastSeenTime.set(c.track.id, now);
      
      // Bind ended listener if seen for the first time
      if (!this.trackFirstSeenTime.has(c.track.id)) {
        this.trackFirstSeenTime.set(c.track.id, now);
        c.track.addEventListener('ended', () => {
          console.log('[Audio Hook] Track ended event fired for candidate: ' + c.track.id);
          this.removeTrackFromLiveness(c.track.id);
        });
      }
    });

    if (this.currentTrackId) {
      this.trackLastSeenTime.set(this.currentTrackId, now);
    }

    // Clean up stale tracks not seen in candidates/captured for 60 seconds
    const STALE_TIMEOUT_MS = 60000;
    for (const trackId of this.trackFirstSeenTime.keys()) {
      const lastSeen = this.trackLastSeenTime.get(trackId) || 0;
      if (trackId !== this.currentTrackId && (now - lastSeen) > STALE_TIMEOUT_MS) {
        this.trackRMSHistory.delete(trackId);
        this.trackFirstSeenTime.delete(trackId);
        this.trackLastSeenTime.delete(trackId);
        console.log('[Audio Hook] Cleaned up stale track ' + trackId + ' (not seen in candidates for ' + (STALE_TIMEOUT_MS / 1000) + 's).');
      }
    }

    // Filter candidates by RMS-based liveness check
    const liveCandidates = candidates.filter(c => {
      const producing = this.isTrackProducingAudio(c.track.id);
      if (!producing && this.debugLogging) {
        console.log('[Audio Hook] Poller: rejecting dead track ' + c.track.id + ' (failed RMS liveness check)');
      }
      return producing;
    });

    if (liveCandidates.length === 0) {
      // No live candidates available
      return;
    }

    // Check if current track is still healthy (stability guard)
    const currentTrackAge = now - this.currentTrackSelectionTime;
    const currentStillLive = liveCandidates.find(c => c.track.id === this.currentTrackId);
    
    if (currentStillLive && currentTrackAge < this.TRACK_STABILITY_PERIOD_MS) {
      // Current track is still producing audio and within stability period
      // Don't switch away unless it becomes dead
      if (this.debugLogging) {
        console.log('[Audio Hook] Poller: staying on current track ' + this.currentTrackId + ' (stability period, age: ' + currentTrackAge + 'ms)');
      }
      return;
    }

    // Select best candidate using priority, then custom liveness/RMS for tie-breaking
    let bestCandidate = null;

    for (const candidate of liveCandidates) {
      if (!bestCandidate) {
        bestCandidate = candidate;
        continue;
      }

      // Compare candidate with the current bestCandidate
      const comparison = this.compareCandidates(candidate, bestCandidate);
      if (comparison > 0) {
        bestCandidate = candidate;
      }
    }

    // Switch to best candidate if different from current
    if (bestCandidate && this.currentTrackId !== bestCandidate.track.id) {
      // Check for track reversion
      if (this.currentTrackId) {
        const currentSeen = this.trackFirstSeenTime.get(this.currentTrackId) || 0;
        const bestSeen = this.trackFirstSeenTime.get(bestCandidate.track.id) || 0;
        if (bestSeen < currentSeen) {
          // Reversion attempt! Check if the old track (bestCandidate) is currently live.
          const bestHistory = this.trackRMSHistory.get(bestCandidate.track.id) || [];
          const bestLastReading = bestHistory.length > 0 ? bestHistory[bestHistory.length - 1] : 0;
          const bestIsLive = bestLastReading > this.RMS_SILENCE_THRESHOLD;
          
          if (!bestIsLive) {
            console.warn('[Audio Hook] Reversion BLOCKED - new track kept. Switching from newer track ' + this.currentTrackId + ' back to older inactive track ' + bestCandidate.track.id + ' was refused.');
            return; // Stay on the new track!
          }
          
          const currentHistory = this.trackRMSHistory.get(this.currentTrackId) || [];
          const bestHistoryLog = this.trackRMSHistory.get(bestCandidate.track.id) || [];
          console.warn('[Audio Hook] TRACK REVERSION DETECTED! Switching from newer track ' + this.currentTrackId + ' (first seen: ' + currentSeen + ', RMS history: [' + currentHistory.join(', ') + ']) back to older track ' + bestCandidate.track.id + ' (first seen: ' + bestSeen + ', RMS history: [' + bestHistoryLog.join(', ') + '])');
        }
      }

      const bestPriority = bestCandidate.priority;
      const bestRMS = this.getAverageRMS(bestCandidate.track.id);
      console.log('[Audio Hook] Poller selected ' + bestCandidate.source + ' audio track: ' + bestCandidate.track.id + ' (priority: ' + bestPriority + ', avgRMS: ' + bestRMS.toFixed(2) + ', replacing: ' + (this.currentTrackId || 'none') + ')');
      this.currentTrackSelectionTime = now;
      this.captureStreamTrack(bestCandidate.track, bestCandidate.isRaw, true); // force = true
    } else if (this.debugLogging && bestCandidate) {
      console.log('[Audio Hook] Poller: already capturing best candidate ' + bestCandidate.track.id);
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

                // Clean up when the track ends
                event.track.addEventListener('ended', () => {
                  console.log('[Audio Hook] RTCPeerConnection track ended event fired for: ' + event.track.id);
                  self.removeTrackFromLiveness(event.track.id);
                });
              }
            });

            pc.addEventListener('removetrack', (event) => {
              if (event.track) {
                console.log('[Audio Hook] RTCPeerConnection removetrack event fired for: ' + event.track.id);
                self.removeTrackFromLiveness(event.track.id);
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

    try {
      // 0. Broad Diagnostic Dump (Only runs if debugLogging is active)
      if (this.debugLogging) {
        try {
          const allAudio = this.queryAllShadow('audio');
          const allVideo = this.queryAllShadow('video');
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
        const found = this.scanForAudioElement();
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

      const runPoller = async () => {
        console.log('[Audio Hook] Starting continuous background media poller...');
        while (this.isRunning) {
          try {
            const now = Date.now();
            // Periodically log map sizes every 60 seconds
            if (!this.lastMapSizeLogTime) {
              this.lastMapSizeLogTime = now;
            }
            if (now - this.lastMapSizeLogTime >= 60000) {
              console.log('[Audio Hook] Periodic Liveness Map Sizes - trackRMSHistory: ' + this.trackRMSHistory.size + ', trackFirstSeenTime: ' + this.trackFirstSeenTime.size + ', trackLastSeenTime: ' + this.trackLastSeenTime.size);
              this.lastMapSizeLogTime = now;
            }

            // Decay RMS history for all inactive tracks
            for (const [trackId, history] of this.trackRMSHistory.entries()) {
              if (trackId !== this.currentTrackId) {
                history.push(0);
                if (history.length > this.RMS_HISTORY_SIZE) {
                  history.shift();
                }
              }
            }

            await this.scanAndAttemptCapture();
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
    
    // Ensure we track when we first see this track
    if (!this.trackFirstSeenTime.has(track.id)) {
      this.trackFirstSeenTime.set(track.id, Date.now());
    }

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

      this.isRunning = true;
      this.processor = new MediaStreamTrackProcessor({
        track
      });
      
      this.readable = this.processor.readable;
      this.reader = this.readable.getReader();
      console.log('[Audio Hook] Stream reader acquired.');
      
      await this.readLoop();
    } catch (e) {
      console.error('[Audio Hook] captureStreamTrack failed:', e);
      this.currentTrackId = null;
      this.currentTrackIsRaw = false;
      this.onError?.('[Audio Hook] MediaStreamTrackProcessor initialization error: ' + e.message);
    }
  },

  async readLoop() {
    console.log('[Audio Hook] Entering readLoop...');
    let frameCount = 0;
    try {
      while (this.isRunning && this.reader) {
        const { done, value } = await this.reader.read();
        if (done) {
          console.log('[Audio Hook] Read loop finished.');
          break;
        }

        frameCount++;
        if (frameCount % 100 === 0) {
          console.log('[Audio Hook] Received ' + frameCount + ' audio frames');
        }

        if (value instanceof AudioData) {
          try {
            const format = value.format;
            const size = value.allocationSize({ planeIndex: 0 });
            const arrayBuffer = new ArrayBuffer(size);
            value.copyTo(arrayBuffer, { planeIndex: 0 });

            let samples;
            if (format.includes('f32')) {
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
              data: Array.from(finalSamples),
              trackId: this.currentTrackId // Add track ID to frame for debugging
            });
          } catch (copyErr) {
            console.error('[Audio Hook] Error processing frame:', copyErr.message);
          } finally {
            value.close();
          }
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
    await this.page.context().addInitScript(AUDIO_CAPTURE_SCRIPT).catch(() => { });
    await this.page.exposeFunction('onAudioFrame', this.onFrame.bind(this)).catch(() => { });
    await this.page.exposeFunction('onAudioError', this.onError.bind(this)).catch(() => { });
    await this.page.exposeFunction('onRMSUpdate', this.onRMSUpdate.bind(this)).catch(() => { });

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
        await frame.evaluate(AUDIO_CAPTURE_SCRIPT).catch(() => { });
      } catch (err) {
        // Ignore cross-origin frame access limits
      }
    }
  }

  async startFrameCapture(frame) {
    try {
      await frame.waitForLoadState('domcontentloaded').catch(() => { });
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
          await frame.evaluate(() => window.audioCapture.stop()).catch(() => { });
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
  
  async onRMSUpdate(trackId, rms) {
    // Update RMS history in all frames that have audioCapture
    const frames = this.page.frames();
    for (const frame of frames) {
      try {
        const hasCapture = await frame.evaluate(() => typeof window.audioCapture !== 'undefined').catch(() => false);
        if (hasCapture) {
          await frame.evaluate(({id, value}) => {
            if (window.audioCapture && window.audioCapture.updateTrackRMS) {
              window.audioCapture.updateTrackRMS(id, value);
            }
          }, { id: trackId, value: rms }).catch(() => {});
        }
      } catch (e) {
        // Ignore cross-origin errors
      }
    }
  }

  setCallbacks(callbacks) {
    this.callback = callbacks.onFrame;
    this.errorCallback = callbacks.onError;
    this.rmsCallback = callbacks.onRMSUpdate;
  }
}
