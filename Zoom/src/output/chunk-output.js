import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Base directory for outputs: Zoom/output/
const DEFAULT_OUTPUT_DIR = path.resolve(__dirname, '../../output');

export class FileChunkOutput {
  constructor(options = {}) {
    this.outputDir = options.outputDir || DEFAULT_OUTPUT_DIR;
    this.chunksDir = path.join(this.outputDir, 'chunks');
    this.manifestPath = path.join(this.outputDir, 'manifest.json');
    this.manifest = {
      meeting_id: options.meetingId || 'test_meeting',
      started_at: new Date().toISOString(),
      chunks: []
    };
  }

  async start() {
    // Create folders
    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.mkdirSync(this.chunksDir, { recursive: true });

    // Initialize or reset manifest
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    console.log(`[Output Handler] Local file output initialized at: ${this.outputDir}`);
  }

  send(chunk) {
    const chunkFileName = `${chunk.chunk_id}.json`;
    const chunkFilePath = path.join(this.chunksDir, chunkFileName);

    // 1. Write the full chunk file (with base64 audio data)
    fs.writeFileSync(chunkFilePath, JSON.stringify(chunk, null, 2), 'utf8');

    // 2. Add summary to manifest (without base64 audio data to keep it readable)
    const summary = {
      chunk_id: chunk.chunk_id,
      start_ts: chunk.start_ts,
      end_ts: chunk.end_ts,
      speaker: chunk.speaker,
      sample_rate: chunk.sample_rate,
      channels: chunk.channels,
      format: chunk.format,
      file_path: `./chunks/${chunkFileName}`
    };

    this.manifest.chunks.push(summary);
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    console.log(`[Output Handler] Saved chunk ${chunk.chunk_id} (Speaker: ${chunk.speaker})`);
  }

  async stop() {
    this.manifest.ended_at = new Date().toISOString();
    fs.writeFileSync(this.manifestPath, JSON.stringify(this.manifest, null, 2), 'utf8');
    console.log(`[Output Handler] Manifest finalized at: ${this.manifestPath}`);
  }
}

export class WebSocketChunkOutput {
  constructor(port = 8080) {
    this.port = port;
    this.wss = null;
    this.clients = new Set();
  }

  async start() {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port });
      this.wss.on('connection', (ws) => {
        this.clients.add(ws);
        console.log(`[Output Handler] WebSocket client connected (${this.clients.size} active)`);
        ws.on('close', () => {
          this.clients.delete(ws);
          console.log(`[Output Handler] WebSocket client disconnected`);
        });
      });
      this.wss.on('listening', () => {
        console.log(`[Output Handler] WebSocket server listening on ws://localhost:${this.port}`);
        resolve();
      });
    });
  }

  send(chunk) {
    const message = JSON.stringify(chunk);

    for (const client of this.clients) {
      if (client.readyState === 1) { // WebSocket.OPEN
        client.send(message);
      }
    }
  }

  async stop() {
    for (const client of this.clients) {
      client.close();
    }
    if (this.wss) {
      await new Promise(r => this.wss.close(r));
    }
  }
}

export function createOutput(type, config = {}) {
  switch (type) {
    case 'file':
      return new FileChunkOutput(config);
    case 'websocket':
      return new WebSocketChunkOutput(config.port || 8080);
    default:
      throw new Error(`Unknown output type: ${type}`);
  }
}
