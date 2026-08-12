import { AUDIO_CONFIG } from '../config/selectors.js';

const SAMPLE_RATE = AUDIO_CONFIG.sampleRate;
const CHUNK_MS = AUDIO_CONFIG.chunkSizeMs;
const FRAMES_PER_CHUNK = Math.floor(SAMPLE_RATE * CHUNK_MS / 1000);
const BYTES_PER_FRAME = 2; // int16

/**
 * Per-channel AudioChunker.
 *
 * Audio arrives from the capture layer as per-participant frames
 * ({ channel, data, sampleRate }). Each channel has its own buffer and timeline,
 * so every participant's audio is chunked independently — the mixed-stream
 * attribution problem disappears because the audio itself is never mixed.
 *
 * The chunk's `speaker` field is intentionally NOT assigned here: channel↔speaker
 * binding is a separate signal (channel_speaker_event) carried from the bot's
 * speaker detector. Backend attribution keys off the stable `channel` id.
 */
export class AudioChunker {
  constructor() {
    /** @type {Map<number, { buffer: Int16Array, timelineStart: number|null }>} */
    this.channels = new Map();
    this.chunkId = 0;
    this.stats = {
      totalChunks: 0,
      voiceChunks: 0,
      silenceChunks: 0,
      totalGain: 1.0,
      avgGain: 1.0
    };
  }

  addAudioFrame(frame) {
    const channel = frame.channel;
    if (channel === undefined || channel === null) {
      // Backward-compat: mixed frames without a channel go to channel 0.
      return this.addAudioFrame({ ...frame, channel: 0 });
    }

    const now = Date.now();
    const frameSamples = frame.data.length;
    const frameDurationMs = (frameSamples / frame.sampleRate) * 1000;

    let st = this.channels.get(channel);
    if (!st) {
      st = { buffer: new Int16Array(0), timelineStart: null };
      this.channels.set(channel, st);
    }

    if (st.buffer.length === 0 || st.timelineStart === null) {
      st.timelineStart = now - frameDurationMs;
    } else {
      const expectedEnd = st.timelineStart + (st.buffer.length / SAMPLE_RATE) * 1000;
      const delay = now - expectedEnd;
      if (delay > 1000) {
        console.log(`[AudioChunker] Channel ${channel} audio gap of ${delay.toFixed(0)}ms detected. Flushing buffer.`);
        this.emitChunkForChannel(channel, st);
        st.timelineStart = now - frameDurationMs;
      }
    }

    const newData = new Int16Array(frame.data);
    const newBuffer = new Int16Array(st.buffer.length + newData.length);
    newBuffer.set(st.buffer);
    newBuffer.set(newData, st.buffer.length);
    st.buffer = newBuffer;

    while (st.buffer.length >= FRAMES_PER_CHUNK) {
      this.emitChunkForChannel(channel, st);
    }
  }

  emitChunkForChannel(channel, st) {
    if (st.buffer.length === 0) return;
    const chunkData = st.buffer.slice(0, FRAMES_PER_CHUNK);
    st.buffer = st.buffer.slice(FRAMES_PER_CHUNK);

    const chunkDurationMs = (chunkData.length / SAMPLE_RATE) * 1000;
    const chunkStart = st.timelineStart;
    const chunkEnd = chunkStart + chunkDurationMs;
    st.timelineStart = chunkEnd;

    // Calculate RMS energy of the Int16 samples
    let sum = 0;
    for (let i = 0; i < chunkData.length; i++) {
      sum += chunkData[i] * chunkData[i];
    }
    const rms = Math.sqrt(sum / chunkData.length);

    // VAD estimate for the chunk (per-channel)
    let isVoice = false;
    let voiceConfidence = 0;
    if (rms > 500) {
      isVoice = true;
      voiceConfidence = Math.min(1, (rms - 500) / 3000);
    }
    if (isVoice) this.stats.voiceChunks++; else this.stats.silenceChunks++;

    console.log(`[AudioChunker] ch${channel} chunk c${String(this.chunkId).padStart(6, '0')}, ${isVoice ? 'VOICE' : 'silence'}, RMS: ${rms.toFixed(2)}`);

    const chunk = {
      chunk_id: `c${String(this.chunkId).padStart(6, '0')}`,
      channel,
      start_ts: chunkStart / 1000,
      end_ts: chunkEnd / 1000,
      speaker: null, // NOT assigned here — see channel_speaker_event
      sample_rate: SAMPLE_RATE,
      channels: AUDIO_CONFIG.channels,
      format: 'pcm_s16le',
      audio_data: Buffer.from(chunkData.buffer),
      vad: { is_voice: isVoice, confidence: voiceConfidence },
      audio_metrics: { rms }
    };

    this.chunkId++;
    this.stats.totalChunks++;
    this.stats.avgGain = this.stats.totalGain / this.stats.totalChunks;

    if (this.onChunk) this.onChunk(chunk);
  }

  flush() {
    for (const [channel, st] of this.channels) {
      if (st.buffer.length > 0) {
        this.emitChunkForChannel(channel, st);
      }
    }
    console.log('[AudioChunker] Final Statistics:');
    console.log(`  Total Chunks: ${this.stats.totalChunks}`);
    console.log(`  Voice Chunks: ${this.stats.voiceChunks} (${(this.stats.voiceChunks / this.stats.totalChunks * 100).toFixed(1)}%)`);
    console.log(`  Silence Chunks: ${this.stats.silenceChunks} (${(this.stats.silenceChunks / this.stats.totalChunks * 100).toFixed(1)}%)`);
  }

  getStats() {
    return {
      ...this.stats,
      activeChannels: this.channels.size
    };
  }

  onChunk(chunk) {}
}
