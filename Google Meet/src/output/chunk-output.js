import { WebSocketServer } from 'ws';

export class ChunkOutput {
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
        ws.on('close', () => this.clients.delete(ws));
      });
      this.wss.on('listening', resolve);
    });
  }

  send(chunk) {
    const message = JSON.stringify({
      chunk_id: chunk.chunk_id,
      start_ts: chunk.start_ts,
      end_ts: chunk.end_ts,
      speaker: chunk.speaker,
      sample_rate: chunk.sample_rate,
      channels: chunk.channels,
      format: chunk.format,
      audio_base64: chunk.audio_data.toString('base64'),
    });

    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  async stop() {
    for (const client of this.clients) client.close();
    if (this.wss) await new Promise(r => this.wss.close(r));
  }
}

export class CallbackOutput {
  constructor(callback) {
    this.callback = callback;
  }

  send(chunk) {
    this.callback(chunk);
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