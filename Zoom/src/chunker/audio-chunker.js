import { AUDIO_CONFIG } from '../config/selectors.js';
import { AudioProcessor } from '../audio/audio-processor.js';
import { AudioDiarization } from '../speaker/audio-diarization.js';

const SAMPLE_RATE = AUDIO_CONFIG.sampleRate;
const CHUNK_MS = AUDIO_CONFIG.chunkSizeMs;
const FRAMES_PER_CHUNK = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000);

export class AudioChunker {
  constructor(options = {}) {
    this.buffer = new Int16Array(0);
    this.speakerHistory = []; // Array of { speaker, startTime, endTime, confidence }
    this.chunkId = 0;
    this.startTime = Date.now();
    
    // Current speaker state (updated immediately on speaker events)
    this.currentSpeaker = null;
    this.currentSpeakerConfidence = 0;
    this.currentSpeakerSource = 'none';
    this.currentTrackId = null; // Current audio track being captured
    
    // Initialize audio processor
    this.audioProcessor = new AudioProcessor(SAMPLE_RATE);
    
    // Initialize audio diarization
    this.audioDiarization = new AudioDiarization();
    
    // Configuration options
    this.enableAudioProcessing = options.enableAudioProcessing !== false;
    this.enableVAD = options.enableVAD !== false;
    this.enableNoiseReduction = options.enableNoiseReduction !== false;
    this.enableNormalization = options.enableNormalization !== false;
    this.enableAntiAliasing = options.enableAntiAliasing !== false;
    this.enableAudioDiarization = options.enableAudioDiarization !== false;
    
    // Speaker initialization state
    this.initialSpeakerDetected = false;
    this.pendingChunks = []; // Buffer chunks until speaker is known
    this.maxPendingChunks = 10; // Maximum chunks to buffer (5 seconds)
    
    // Statistics
    this.stats = {
      totalChunks: 0,
      voiceChunks: 0,
      silenceChunks: 0,
      totalGain: 0,
      avgGain: 1.0
    };
    
    // Callbacks
    this.onChunk = () => {};
    this.onRMSUpdate = null; // Will be set by lifecycle to report RMS for track liveness
  }

  addAudioFrame(frame) {
    // Update current track ID if provided
    if (frame.trackId) {
      this.currentTrackId = frame.trackId;
    }
    
    const newData = new Int16Array(frame.data);
    const newBuffer = new Int16Array(this.buffer.length + newData.length);
    newBuffer.set(this.buffer);
    newBuffer.set(newData, this.buffer.length);
    this.buffer = newBuffer;

    while (this.buffer.length >= FRAMES_PER_CHUNK) {
      this.emitChunk();
    }
  }

  addSpeakerEvent({ speaker, timestamp, confidence = 1.0, source = 'dom' }) {
    // DETECTION LAG COMPENSATION (inspired by Google Meet approach)
    // The DOM detection (via MutationObserver) has inherent latency (~1000ms for Zoom).
    // By the time DOM detects a speaker change, audio chunks for the new speaker 
    // have already been emitted. Back-dating the boundary shifts it earlier so those
    // "transition chunks" get attributed to the correct new speaker.
    const DETECTION_LAG_MS = source === 'dom' ? 1000 : 0; // Only compensate for DOM detection
    const adjustedTimestamp = timestamp - DETECTION_LAG_MS;

    // Close previous speaker's interval at ADJUSTED (earlier) timestamp
    if (this.speakerHistory.length > 0) {
      this.speakerHistory[this.speakerHistory.length - 1].endTime = adjustedTimestamp;
    }
    
    // New speaker's interval starts at ADJUSTED (earlier) timestamp
    this.speakerHistory.push({ 
      speaker, 
      startTime: adjustedTimestamp, 
      endTime: null, 
      confidence: confidence,
      source: source // 'dom' or 'audio'
    });
    
    console.log(`[AudioChunker] Speaker event: ${speaker} at ${timestamp}ms (adjusted to ${adjustedTimestamp}ms, lag compensation: ${DETECTION_LAG_MS}ms)`);
    
    // BUG FIX: Update current speaker state immediately for all subsequent chunks
    // This ensures chunks emitted AFTER this event show the new speaker, not the stale one
    // Note: This does NOT bypass lag compensation - the adjusted timestamp is still used
    // in speakerHistory for retroactive attribution of past chunks via getSpeakerForWindow()
    // But for NEW chunks being emitted now, we want the current state to reflect the update
    this.currentSpeaker = speaker;
    this.currentSpeakerConfidence = confidence;
    this.currentSpeakerSource = source;
    console.log(`[AudioChunker] Active speaker updated: ${speaker} (${source}, conf: ${(confidence * 100).toFixed(0)}%)`);
    
    // Mark that we've detected the initial speaker
    if (!this.initialSpeakerDetected && speaker && source === 'dom') {
      console.log(`[AudioChunker] Initial speaker detected: ${speaker}`);
      this.initialSpeakerDetected = true;
      
      // Flush pending chunks with the correct speaker name (initial detection only)
      // This handles the first few seconds when speaker is unknown
      this.flushPendingChunks(speaker, confidence, adjustedTimestamp);
    }
    
    // Maintain a rolling history of the last 15 seconds to prevent memory build-up
    const cutoff = timestamp - 15000;
    this.speakerHistory = this.speakerHistory.filter(h => (h.endTime || timestamp) > cutoff);
  }
  
  /**
   * Flush buffered chunks and apply speaker name retroactively
   */
  flushPendingChunks(speaker, confidence, timestamp) {
    if (this.pendingChunks.length === 0) return;
    
    console.log(`[AudioChunker] Flushing ${this.pendingChunks.length} pending chunks with speaker: ${speaker}`);
    
    // Add speaker event to cover the pending chunk period
    const oldestChunk = this.pendingChunks[0];
    this.speakerHistory.push({
      speaker: speaker,
      startTime: oldestChunk.start_ts * 1000, // Convert back to ms
      endTime: timestamp,
      confidence: confidence,
      source: 'dom'
    });
    
    // Update all pending chunks with the speaker name
    for (const chunk of this.pendingChunks) {
      chunk.speaker = speaker;
      chunk.speaker_confidence = confidence;
      chunk.speaker_source = 'dom';
      
      // Emit the chunk
      if (this.onChunk) {
        this.onChunk(chunk);
      }
    }
    
    // Clear pending chunks
    this.pendingChunks = [];
  }

  emitChunk() {
    let chunkData = this.buffer.slice(0, FRAMES_PER_CHUNK);
    this.buffer = this.buffer.slice(FRAMES_PER_CHUNK);

    const chunkStart = this.startTime + (this.chunkId * CHUNK_MS);
    const chunkEnd = chunkStart + CHUNK_MS;
    
    // Apply audio processing if enabled
    let vadResult = null;
    let processedGain = 1.0;
    
    if (this.enableAudioProcessing) {
      const processed = this.audioProcessor.processFrame(
        chunkData,
        SAMPLE_RATE,
        SAMPLE_RATE,
        {
          enableVAD: this.enableVAD,
          enableNoiseReduction: this.enableNoiseReduction,
          enableNormalization: this.enableNormalization,
          enableAntiAliasing: false // Already at target rate
        }
      );
      
      chunkData = processed.samples;
      vadResult = processed.vad;
      processedGain = processed.gain;
      
      // Update statistics
      this.stats.totalGain += processedGain;
      if (vadResult && vadResult.isVoice) {
        this.stats.voiceChunks++;
      } else {
        this.stats.silenceChunks++;
      }
    }

    // Determine the source of truth for the speaker resolution
    let speaker = null;
    let speakerConfidence = 0;
    let speakerSource = 'none';
    let resolutionPath = '';

    if (this.currentSpeaker !== null) {
      speaker = this.currentSpeaker;
      speakerConfidence = this.currentSpeakerConfidence;
      speakerSource = this.currentSpeakerSource;
      resolutionPath = 'currentSpeaker';
    } else {
      const domSpeakerInfo = this.getSpeakerForWindow(chunkStart, chunkEnd);
      speaker = domSpeakerInfo.speaker;
      speakerConfidence = domSpeakerInfo.confidence;
      speakerSource = domSpeakerInfo.source;
      resolutionPath = 'speakerHistory lookup';
    }

    // Use audio diarization ONLY as fallback when DOM speaker is not available
    // DOM detection has absolute priority to avoid conflicts
    if (this.enableAudioDiarization && vadResult && vadResult.isVoice) {
      const diarizationResult = this.audioDiarization.processFrame(
        chunkData,
        chunkStart,
        speaker // Pass the known speaker name from DOM if available (for learning)
      );
      
      // ONLY use audio diarization if DOM has no speaker
      if (!speaker && diarizationResult.speakerId) {
        // No DOM speaker, use audio diarization as fallback
        speaker = diarizationResult.speakerName;
        speakerConfidence = diarizationResult.confidence;
        speakerSource = 'audio';
        resolutionPath = 'audio diarization fallback';
      }
    }

    // Calculate RMS energy of the Int16 samples
    const rms = vadResult ? vadResult.rms : this.calculateRMS(chunkData);
    
    // Track current audio source for debugging
    const currentTrackId = this.currentTrackId || 'unknown';
    
    const logSpeaker = speaker || (vadResult && vadResult.isVoice ? 'unknown' : 'silence');
    const vadStatus = vadResult ? `VAD: ${vadResult.isVoice ? 'VOICE' : 'SILENCE'} (conf: ${(vadResult.confidence * 100).toFixed(0)}%)` : '';
    const gainInfo = this.enableAudioProcessing ? ` gain: ${processedGain.toFixed(2)}x` : '';
    const trackInfo = ` track: ${currentTrackId}`;
    
    console.log(`[AudioChunker] Chunk speaker resolved via: ${resolutionPath}`);
    console.log(`[AudioChunker] Chunk c${String(this.chunkId).padStart(6, '0')}, speaker: ${logSpeaker} (${speakerSource}, conf: ${(speakerConfidence * 100).toFixed(0)}%), RMS: ${rms.toFixed(2)}, ${vadStatus}${gainInfo}${trackInfo}`);

    // Report RMS back to audio capture for liveness tracking
    if (this.onRMSUpdate && currentTrackId && currentTrackId !== 'unknown') {
      this.onRMSUpdate(currentTrackId, rms);
    }

    // Format matches Google Meet's structure: includes base64-encoded PCM audio + enhanced metadata
    const chunk = {
      chunk_id: `c${String(this.chunkId).padStart(6, '0')}`,
      start_ts: chunkStart / 1000,
      end_ts: chunkEnd / 1000,
      speaker: speaker || null,
      speaker_confidence: speakerConfidence,
      speaker_source: speakerSource,
      sample_rate: SAMPLE_RATE,
      channels: AUDIO_CONFIG.channels,
      format: 'pcm_s16le',
      audio_base64: Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength).toString('base64'),
      // Enhanced metadata
      vad: vadResult ? {
        is_voice: vadResult.isVoice,
        confidence: vadResult.confidence
      } : null,
      audio_metrics: {
        rms: rms,
        gain_applied: processedGain
      }
    };

    this.chunkId++;
    this.stats.totalChunks++;
    this.stats.avgGain = this.stats.totalGain / this.stats.totalChunks;
    
    // If initial speaker not detected yet and we have voice, buffer the chunk
    if (!this.initialSpeakerDetected && vadResult && vadResult.isVoice && !speaker) {
      console.log(`[AudioChunker] Buffering chunk ${chunk.chunk_id} until speaker is detected`);
      this.pendingChunks.push(chunk);
      
      // Safety: Don't buffer forever, flush after max pending
      if (this.pendingChunks.length >= this.maxPendingChunks) {
        console.log(`[AudioChunker] Max pending chunks reached, flushing with 'Unknown' speaker`);
        this.initialSpeakerDetected = true; // Stop buffering
        for (const pendingChunk of this.pendingChunks) {
          if (this.onChunk) {
            this.onChunk(pendingChunk);
          }
        }
        this.pendingChunks = [];
      }
      return; // Don't emit yet
    }
    
    // Emit the chunk immediately if speaker is known or it's silence
    if (this.onChunk) {
      this.onChunk(chunk);
    }
  }
  
  /**
   * Calculate RMS energy
   */
  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  getSpeakerForWindow(start, end) {
    if (this.speakerHistory.length === 0) {
      return { speaker: null, confidence: 0, source: 'none' };
    }

    // SIMPLIFIED APPROACH (inspired by Google Meet)
    // With lag compensation in addSpeakerEvent(), we can use simple max overlap logic
    // Find the speaker with maximum overlap for this time window
    let bestSpeaker = null;
    let bestOverlap = 0;
    let bestConfidence = 0;
    let bestSource = 'none';

    for (const entry of this.speakerHistory) {
      const entryEnd = entry.endTime || end;
      const overlapStart = Math.max(start, entry.startTime);
      const overlapEnd = Math.min(end, entryEnd);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = entry.speaker;
        bestConfidence = entry.confidence || 1.0;
        bestSource = entry.source || 'dom';
      }
    }

    return {
      speaker: bestSpeaker,
      confidence: bestConfidence,
      source: bestSource
    };
  }

  flush() {
    while (this.buffer.length > 0) {
      this.emitChunk();
    }
    
    // Log final statistics
    console.log('[AudioChunker] Final Statistics:');
    console.log(`  Total Chunks: ${this.stats.totalChunks}`);
    console.log(`  Voice Chunks: ${this.stats.voiceChunks} (${(this.stats.voiceChunks / this.stats.totalChunks * 100).toFixed(1)}%)`);
    console.log(`  Silence Chunks: ${this.stats.silenceChunks} (${(this.stats.silenceChunks / this.stats.totalChunks * 100).toFixed(1)}%)`);
    console.log(`  Average Gain: ${this.stats.avgGain.toFixed(2)}x`);
    
    if (this.enableAudioDiarization) {
      console.log('[AudioChunker] Speaker Diarization Statistics:');
      const speakerStats = this.audioDiarization.getSpeakerStats();
      speakerStats.forEach(stat => {
        console.log(`  ${stat.name}: ${stat.frameCount} frames, pitch: ${stat.pitch} Hz, energy: ${stat.energy}`);
      });
    }
  }

  /**
   * Get current statistics
   */
  getStats() {
    return {
      ...this.stats,
      speakers: this.enableAudioDiarization ? this.audioDiarization.getSpeakerStats() : []
    };
  }

  onChunk(chunk) {}
}
