import { AUDIO_CONFIG } from '../config/selectors.js';

const SAMPLE_RATE = AUDIO_CONFIG.sampleRate;
const CHUNK_MS = AUDIO_CONFIG.chunkSizeMs;
const FRAMES_PER_CHUNK = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000);
const BYTES_PER_FRAME = 2; // int16

export class AudioChunker {
  constructor() {
    this.buffer = new Int16Array(0);
    this.currentSpeaker = null;
    this.speakerHistory = []; // { speaker, startTime, endTime }
    this.chunkId = 0;
    this.bufferTimelineStart = null;
  }

  addAudioFrame(frame) {
    const now = Date.now();
    const frameSamples = frame.data.length;
    const frameDurationMs = (frameSamples / frame.sampleRate) * 1000;

    if (this.buffer.length === 0 || !this.bufferTimelineStart) {
      this.bufferTimelineStart = now - frameDurationMs;
    } else {
      const expectedEnd = this.bufferTimelineStart + (this.buffer.length / SAMPLE_RATE) * 1000;
      const delay = now - expectedEnd;
      if (delay > 1000) {
        console.log(`[AudioChunker] Audio gap of ${delay.toFixed(0)}ms detected. Flushing current buffer.`);
        this.flush();
        this.bufferTimelineStart = now - frameDurationMs;
      }
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

  addSpeakerEvent({ speaker, timestamp }) {
    // The DOM poll detects a speaker change with some latency (poll interval + debounce).
    // To prevent User B's early chunks being attributed to User A, we back-date the
    // previous speaker's end time by the approximate detection lag (poll interval = 150ms).
    // This shifts the speaker boundary earlier so transition chunks go to the new speaker.
    const DETECTION_LAG_MS = 150; // matches pollInterval in SpeakerDetector
    const adjustedTimestamp = timestamp - DETECTION_LAG_MS;

    // Close off the previous speaker interval at the adjusted (earlier) timestamp
    if (this.speakerHistory.length > 0) {
      this.speakerHistory[this.speakerHistory.length - 1].endTime = adjustedTimestamp;
    }

    if (speaker) {
      this.currentSpeaker = speaker;
      // New speaker's interval starts at the adjusted (earlier) boundary
      this.speakerHistory.push({ speaker, startTime: adjustedTimestamp, endTime: null });
    }
    // null speaker = silence gap — we close A's interval above but don't push
    // a null entry. The gap chunks will have no speaker match in getSpeakerForWindow,
    // which is correct.

    // Keep last 30 seconds of history
    const cutoff = timestamp - 30000;
    this.speakerHistory = this.speakerHistory.filter(h => (h.endTime || timestamp) > cutoff);
  }

  emitChunk() {
    const chunkData = this.buffer.slice(0, FRAMES_PER_CHUNK);
    this.buffer = this.buffer.slice(FRAMES_PER_CHUNK);

    const chunkDurationMs = (chunkData.length / SAMPLE_RATE) * 1000;
    const chunkStart = this.bufferTimelineStart;
    const chunkEnd = chunkStart + chunkDurationMs;
    
    // Advance timeline for the remaining buffer
    this.bufferTimelineStart = chunkEnd;

    const speaker = this.getSpeakerForWindow(chunkStart, chunkEnd);

    // Calculate RMS energy of the Int16 samples
    let sum = 0;
    for (let i = 0; i < chunkData.length; i++) {
      sum += chunkData[i] * chunkData[i];
    }
    const rms = Math.sqrt(sum / chunkData.length);
    console.log(`[AudioChunker] Emitted chunk c${String(this.chunkId).padStart(6, '0')}, speaker: ${speaker || 'silence'}, RMS energy: ${rms.toFixed(2)}`);

    const chunk = {
      chunk_id: `c${String(this.chunkId).padStart(6, '0')}`,
      start_ts: chunkStart / 1000,
      end_ts: chunkEnd / 1000,
      speaker: speaker || null,
      sample_rate: SAMPLE_RATE,
      channels: AUDIO_CONFIG.channels,
      format: 'pcm_s16le',
      audio_data: Buffer.from(chunkData.buffer),
    };

    this.chunkId++;
    if (this.onChunk) this.onChunk(chunk);
  }

  getSpeakerForWindow(start, end) {
    if (this.speakerHistory.length === 0) return null;

    let bestSpeaker = null;
    let bestOverlap = 0;

    for (const entry of this.speakerHistory) {
      const entryEnd = entry.endTime || end;
      const overlapStart = Math.max(start, entry.startTime);
      const overlapEnd = Math.min(end, entryEnd);
      const overlap = Math.max(0, overlapEnd - overlapStart);

      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestSpeaker = entry.speaker;
      }
    }

    return bestSpeaker;
  }

  flush() {
    while (this.buffer.length > 0) {
      this.emitChunk();
    }
  }

  onChunk(chunk) {}
}