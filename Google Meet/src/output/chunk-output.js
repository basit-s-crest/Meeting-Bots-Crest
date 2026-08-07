import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export class ChunkOutput {
  constructor(port = 8080) {
    this.port = port;
    this.server = null;
    this.wss = null;
    this.clients = new Set();
  }

  async start() {
    return new Promise((resolve, reject) => {
      console.log(`Starting HTTP and WebSocket server on port ${this.port}...`);
      try {
        // Create HTTP server to serve the ws-client.html page
        this.server = createServer(async (req, res) => {
          try {
            // Serve the ws-client.html file for any request
            const clientHtmlPath = join(__dirname, '../../ws-client.html');
            const html = await readFile(clientHtmlPath, 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end(`Internal Server Error: ${err.message}`);
          }
        });

        this.wss = new WebSocketServer({ server: this.server });

        this.wss.on('connection', (ws) => {
          console.log('New WebSocket client connected');
          this.clients.add(ws);
          
          ws.on('close', () => {
            console.log('WebSocket client disconnected');
            this.clients.delete(ws);
          });
          
          ws.on('error', (err) => {
            console.error('WebSocket client error:', err);
          });
        });

        this.server.listen(this.port, () => {
          console.log(`\n==================================================================`);
          console.log(`Visualizer is available at: http://localhost:${this.port}`);
          console.log(`WebSocket server is listening on: ws://localhost:${this.port}`);
          console.log(`==================================================================\n`);
          resolve();
        });

        this.server.on('error', (err) => {
          console.error(`Server error on port ${this.port}:`, err);
          reject(err);
        });
      } catch (err) {
        console.error('Failed to start server:', err);
        reject(err);
      }
    });
  }

  send(chunk) {
    const message = JSON.stringify({
      type: 'audio_chunk',
      chunk_id: chunk.chunk_id,
      start_ts: chunk.start_ts,
      end_ts: chunk.end_ts,
      speaker: chunk.speaker, // rough fallback only — NOT ground truth, see speaker_event
      sample_rate: chunk.sample_rate,
      channels: chunk.channels,
      format: chunk.format,
      audio_base64: chunk.audio_data.toString('base64'),
    });

    console.log(`[ChunkOutput] Streaming chunk ${chunk.chunk_id} to ${this.clients.size} connected client(s)`);
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === 1) {
          client.send(message);
        } else {
          console.log(`[ChunkOutput] Skipping client with state: ${client.readyState}`);
        }
      } catch (err) {
        console.error('[ChunkOutput] Error sending to client:', err.message);
      }
    }
  }

  /**
   * Broadcasts a precise speaker-turn boundary the moment it's detected,
   * decoupled from the 500ms audio chunk grid. This is the ground-truth
   * signal the backend should use for speaker attribution — audio_chunk's
   * `speaker` field is only a majority-vote fallback and loses sub-chunk
   * precision.
   */
  sendSpeakerEvent({ speaker, timestamp }) {
    const message = JSON.stringify({
      type: 'speaker_event',
      speaker,
      timestamp_ts: timestamp / 1000, // epoch seconds, same unit as chunk start_ts/end_ts
    });

    console.log(`[ChunkOutput] Streaming speaker_event "${speaker}" to ${this.clients.size} connected client(s)`);
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === 1) {
          client.send(message);
        }
      } catch (err) {
        console.error('[ChunkOutput] Error sending speaker_event:', err.message);
      }
    }
  }

  /**
   * Broadcasts the current participant roster (names only, bot excluded).
   * Used to populate the "pick your name" dropdown on the approval page.
   */
  sendRosterEvent(names) {
    if (!Array.isArray(names)) return;
    const message = JSON.stringify({ type: 'roster', names });
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN || client.readyState === 1) {
          client.send(message);
        }
      } catch (err) {
        console.error('[ChunkOutput] Error sending roster event:', err.message);
      }
    }
  }

  async stop() {
    console.log('Stopping ChunkOutput servers...');
    for (const client of this.clients) {
      try {
        client.close();
      } catch {}
    }
    this.clients.clear();

    if (this.wss) {
      await new Promise(r => this.wss.close(r));
    }
    if (this.server) {
      await new Promise(r => this.server.close(r));
    }
    console.log('ChunkOutput servers stopped.');
  }
}

export class CallbackOutput {
  constructor(callback) {
    this.callback = callback;
  }

  send(chunk) {
    this.callback({ type: 'audio_chunk', ...chunk });
  }

  sendSpeakerEvent(event) {
    this.callback({ type: 'speaker_event', ...event });
  }

  sendRosterEvent(names) {
    this.callback({ type: 'roster', names });
  }

  async stop() {}
}

export function createOutput(type, config) {
  switch (type) {
    case 'websocket': return new ChunkOutput(config?.port);
    case 'callback': return new CallbackOutput(config?.callback);
    default: throw new Error(`Unknown output type: ${type}`);
  }
}