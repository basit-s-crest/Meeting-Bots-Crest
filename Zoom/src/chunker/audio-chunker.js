import { AUDIO_CONFIG } from '../config/selectors.js';

const SAMPLE_RATE = AUDIO_CONFIG.sampleRate;
const CHUNK_MS = AUDIO_CONFIG.chunkSizeMs;
const FRAMES_PER_CHUNK = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000);

export class AudioChunker {
  constructor() {
    this.buffer = new Int16Array(0);
    this.speakerHistory = []; // Array of { speaker, startTime, endTime }
    this.chunkId = 0;
    this.startTime = Date.now();
  }

  addAudioFrame(frame) {
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
    if (this.speakerHistory.length > 0) {
      this.speakerHistory[this.speakerHistory.length - 1].endTime = timestamp;
    }
    this.speakerHistory.push({ speaker, startTime: timestamp, endTime: null });
    
    // Maintain a rolling history of the last 15 seconds to prevent memory build-up
    const cutoff = timestamp - 15000;
    this.speakerHistory = this.speakerHistory.filter(h => (h.endTime || timestamp) > cutoff);
  }

  emitChunk() {
    const chunkData = this.buffer.slice(0, FRAMES_PER_CHUNK);
    this.buffer = this.buffer.slice(FRAMES_PER_CHUNK);

    const chunkStart = this.startTime + (this.chunkId * CHUNK_MS);
    const chunkEnd = chunkStart + CHUNK_MS;
    const speaker = this.getSpeakerForWindow(chunkStart, chunkEnd);

    // Format matches Google Meet's structure: includes base64-encoded PCM audio
    const chunk = {
      chunk_id: `c${String(this.chunkId).padStart(6, '0')}`,
      start_ts: chunkStart / 1000,
      end_ts: chunkEnd / 1000,
      speaker: speaker || null,
      sample_rate: SAMPLE_RATE,
      channels: AUDIO_CONFIG.channels,
      format: 'pcm_s16le',
      audio_base64: Buffer.from(chunkData.buffer, chunkData.byteOffset, chunkData.byteLength).toString('base64'),
    };

    this.chunkId++;
    if (this.onChunk) {
      this.onChunk(chunk);
    }
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
