/**
 * Base Output Interface representing the contract for writing out transcript events.
 */
export class IOutput {
  /**
   * Write a transcript event to the output destination.
   * @param {{ timestamp: string, speaker: string, text: string }} event
   */
  async write(event) {
    throw new Error('write(event) must be implemented by subclass');
  }

  /**
   * Close or flush any pending output writers.
   */
  async close() {
    throw new Error('close() must be implemented by subclass');
  }
}
