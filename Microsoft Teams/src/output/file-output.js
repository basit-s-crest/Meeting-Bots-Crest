import fs from 'fs/promises';
import path from 'path';
import { IOutput } from './output-interface.js';

export class FileOutput extends IOutput {
  /**
   * @param {string} filePath
   */
  constructor(filePath = './transcript.jsonl') {
    super();
    this.filePath = path.resolve(filePath);
    console.log(`[FileOutput] Logging transcript to: ${this.filePath}`);
    console.log('[FileOutput] Ready, waiting for events...');
  }

  /**
   * Write a transcript event to the JSONL file.
   * @param {{ timestamp: string, speaker: string, text: string }} event
   */
  async write(event) {
    try {
      // Ensure the directory exists
      const dir = path.dirname(this.filePath);
      await fs.mkdir(dir, { recursive: true });

      // Serialize event as a single line and append it
      const line = JSON.stringify(event) + '\n';
      await fs.appendFile(this.filePath, line, 'utf8');
      console.log(`[FileOutput] Wrote entry: ${JSON.stringify(event)}`);
    } catch (err) {
      console.error(`[FileOutput] Failed to write event to file: ${err.message}`, event);
    }
  }

  async close() {
    console.log('[FileOutput] Flushed and closed output logger.');
  }
}
