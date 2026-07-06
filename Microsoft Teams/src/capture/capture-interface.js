/**
 * Base Capture Interface representing the contract for any text transcript capture source.
 * Both CaptionScraper and future audio-based capture/STT modules must implement this interface.
 */
export class ICapture {
  constructor() {
    this.transcriptCallback = null;
  }

  /**
   * Register a callback that is invoked when new transcript text is captured.
   * The callback is passed an event with the shape:
   * {
   *   timestamp: string,  // ISO-8601 string
   *   speaker: string,    // Speaker display name
   *   text: string        // Captured text
   * }
   */
  onTranscript(callback) {
    this.transcriptCallback = callback;
  }

  /**
   * Emit a captured transcript event to the registered callback.
   */
  emit(speaker, text, timestamp = new Date().toISOString()) {
    if (this.transcriptCallback) {
      this.transcriptCallback({
        timestamp,
        speaker: speaker || 'Unknown Speaker',
        text: text ? text.trim() : ''
      });
    }
  }

  /**
   * Initialize and attach any scripts/hooks to the page context.
   * @param {import('playwright').Page} page
   */
  async initialize(page) {
    throw new Error('initialize(page) must be implemented by subclass');
  }

  /**
   * Start capturing transcript events.
   */
  async start() {
    throw new Error('start() must be implemented by subclass');
  }

  /**
   * Stop capturing.
   */
  async stop() {
    throw new Error('stop() must be implemented by subclass');
  }
}
