/**
 * Stub class for future Deepgram STT client.
 * Non-functional for this phase.
 */
export class DeepgramClient {
  constructor(apiKey) {
    this.apiKey = apiKey;
    console.log('[DeepgramClient] Initialized stub.');
  }

  async connect() {
    console.log('[DeepgramClient] Connect requested (stub — doing nothing).');
  }

  sendAudio(buffer) {
    // Stub
  }

  onTranscript(callback) {
    this.callback = callback;
  }

  async close() {
    console.log('[DeepgramClient] Close requested (stub — doing nothing).');
  }
}
