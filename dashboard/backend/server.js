import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

import { processManager } from './process-manager.js';
import { deepgramProxy } from './deepgram-proxy.js';
import { generateFirefliesReport, calculateSpeakerStats } from './report-generator.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env file from the root directory (override: true ensures .env values take precedence over system env vars)
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
console.log(`[Server] Loaded Deepgram API Key: ${DEEPGRAM_API_KEY ? 'Present (Configured)' : 'Missing'}`);

const app = express();
app.use(express.json());

// Serve static frontend files
const frontendPublicPath = path.resolve(__dirname, '../frontend/public');
app.use(express.static(frontendPublicPath));

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Port finder helper
async function getFreePort(startPort = 8090) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(startPort, () => {
      srv.close(() => resolve(startPort));
    });
    srv.on('error', () => {
      resolve(getFreePort(startPort + 1));
    });
  });
}

// Map of sessionId -> set of connected client WebSocket connections
const clientSockets = new Map(); // sessionId -> Set(WebSocket)

// Helper to broadcast messages to all UI clients of a session
function broadcastToClients(sessionId, type, data) {
  const sockets = clientSockets.get(sessionId);
  if (!sockets) return;
  
  const message = JSON.stringify({ type, data });
  for (const client of sockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

/**
 * REST API: Start a bot session
 */
app.post('/api/sessions/start', async (req, res) => {
  const { botType, meetingUrl, botName, isHeadless } = req.body;

  if (!botType || !meetingUrl) {
    return res.status(400).json({ error: 'Missing required parameters: botType and meetingUrl' });
  }

  // Google Meet and Zoom require Deepgram transcription, so verify API key
  if ((botType === 'google-meet' || botType === 'zoom') && !DEEPGRAM_API_KEY) {
    return res.status(400).json({ 
      error: 'Deepgram API Key is missing. Please add DEEPGRAM_API_KEY to the .env file in the project root.' 
    });
  }

  const sessionId = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const wsPort = await getFreePort(8090);

  try {
    const sessionInfo = processManager.spawnBot(sessionId, {
      botType,
      meetingUrl,
      botName: botName || 'Meeting Bot',
      isHeadless: isHeadless !== false,
      wsPort
    });

    // Handle process events/callbacks
    sessionInfo.onStatusCallback = (status) => {
      broadcastToClients(sessionId, 'status', { status });
    };

    sessionInfo.onTranscriptCallback = (transcriptEvent) => {
      // Teams returns transcripts directly
      broadcastToClients(sessionId, 'transcript', transcriptEvent);
    };

    // If Google Meet or Zoom, we connect to their WebSocket stream to extract audio and push to Deepgram
    if (botType === 'google-meet' || botType === 'zoom') {
      connectToBotAudioStream(sessionId, wsPort);
    }

    res.json({
      success: true,
      sessionId,
      wsPort,
      botType,
      status: 'starting'
    });
  } catch (err) {
    console.error('[Server] Failed to launch bot:', err);
    res.status(500).json({ error: `Failed to launch bot process: ${err.message}` });
  }
});

/**
 * REST API: Stop a bot session
 */
app.post('/api/sessions/stop', async (req, res) => {
  const { sessionId } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  try {
    deepgramProxy.closeSession(sessionId);
    await processManager.killBot(sessionId);
    res.json({ success: true, sessionId });
  } catch (err) {
    res.status(500).json({ error: `Failed to stop bot session: ${err.message}` });
  }
});

/**
 * REST API: List active sessions
 */
app.get('/api/sessions', (req, res) => {
  const list = [];
  for (const [id, session] of processManager.activeSessions.entries()) {
    list.push({
      sessionId: id,
      type: session.type,
      status: session.status,
      wsPort: session.wsPort
    });
  }
  res.json({ sessions: list });
});

/**
 * REST API: Get saved transcripts
 */
app.get('/api/transcripts', (req, res) => {
  const transcriptsDir = path.join(__dirname, 'transcripts');
  if (!fs.existsSync(transcriptsDir)) {
    return res.json({ transcripts: [] });
  }

  try {
    const files = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
    const list = files.map(f => {
      const stats = fs.statSync(path.join(transcriptsDir, f));
      return {
        fileName: f,
        sessionId: f.replace(/^(teams|meet|zoom)_/, '').replace(/\.jsonl$/, ''),
        created: stats.birthtime,
        size: stats.size
      };
    });
    res.json({ transcripts: list });
  } catch (err) {
    res.status(500).json({ error: `Failed to read transcripts directory: ${err.message}` });
  }
});

/**
 * REST API: Read individual transcript file
 */
app.get('/api/transcripts/:filename', (req, res) => {
  const filename = req.params.filename;
  const filePath = path.join(__dirname, 'transcripts', filename);

  if (!fs.existsSync(filePath) || path.relative(path.join(__dirname, 'transcripts'), filePath).startsWith('..')) {
    return res.status(404).json({ error: 'Transcript file not found' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
    res.json({ lines });
  } catch (err) {
    res.status(500).json({ error: `Failed to read transcript: ${err.message}` });
  }
});

/**
 * REST API: Generate post-meeting report
 */
app.post('/api/transcripts/:filename/generate-report', async (req, res) => {
  const filename = req.params.filename;
  
  // Sanitize: reject if it contains '..' or has non-alphanumeric/underscore/hyphen/dot characters
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const filePath = path.join(transcriptsDir, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Transcript file not found' });
  }

  try {
    const reportMarkdown = await generateFirefliesReport(filePath);
    
    // Save report file
    const reportFilename = filename.replace('.jsonl', '_report.md');
    const reportPath = path.join(transcriptsDir, reportFilename);
    fs.writeFileSync(reportPath, reportMarkdown, 'utf8');

    res.json({ success: true });
  } catch (err) {
    console.error(`[Server] Report generation failed for ${filename}:`, err.message);
    
    if (err.message.includes('GROQ_API_KEY not set')) {
      return res.status(503).json({ error: 'GROQ_API_KEY not set in .env' });
    } else if (err.message.includes('Groq API Error')) {
      return res.status(503).json({ error: err.message });
    }
    res.status(500).json({ error: `Report generation failed: ${err.message}` });
  }
});

/**
 * REST API: Get post-meeting report and speaker analytics
 */
app.get('/api/transcripts/:filename/report', (req, res) => {
  const filename = req.params.filename;
  
  // Sanitize: reject if it contains '..' or has non-alphanumeric/underscore/hyphen/dot characters
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const filePath = path.join(transcriptsDir, filename);
  const reportFilename = filename.replace('.jsonl', '_report.md');
  const reportPath = path.join(transcriptsDir, reportFilename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Transcript file not found' });
  }

  if (!fs.existsSync(reportPath)) {
    return res.status(404).json({ error: 'Report not yet generated' });
  }

  try {
    const reportMarkdown = fs.readFileSync(reportPath, 'utf8');
    
    // Calculate speaker statistics from source .jsonl file for the progress bars
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
    const stats = calculateSpeakerStats(lines);

    res.json({
      report: reportMarkdown,
      analytics: stats.analytics
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to retrieve report: ${err.message}` });
  }
});

/**
 * Backend WebSocket logic: connect to Google Meet/Zoom's output port
 */
function connectToBotAudioStream(sessionId, wsPort) {
  const url = `ws://localhost:${wsPort}`;
  let botSocket = null;
  let attempts = 0;
  const maxAttempts = 120; // 60 seconds total wait

  const tryConnect = () => {
    attempts++;
    console.log(`[Server] Connecting to bot audio stream at ${url} (Attempt ${attempts}/${maxAttempts})...`);
    
    botSocket = new WebSocket(url);

    botSocket.on('open', () => {
      console.log(`[Server] Connected to bot audio stream for session ${sessionId}`);
      broadcastToClients(sessionId, 'status', { status: 'capturing' });

      // Create transcript log file for Meet/Zoom
      const transcriptsDir = path.join(__dirname, 'transcripts');
      const logPath = path.join(transcriptsDir, `${processManager.getSession(sessionId)?.type || 'session'}_${sessionId}.jsonl`);
      const logStream = fs.createWriteStream(logPath, { flags: 'a' });

      // Initialize Deepgram Proxy connection
      deepgramProxy.initializeSession(sessionId, {
        apiKey: DEEPGRAM_API_KEY,
        onTranscript: (event) => {
          // Send to UI clients
          broadcastToClients(sessionId, 'transcript', event);
          // Write to local jsonl file if final
          if (event.isFinal) {
            logStream.write(JSON.stringify(event) + '\n');
          }
        },
        onError: (err) => {
          console.error(`[Server][Deepgram][${sessionId}] Error:`, err.message);
        }
      });
    });

    botSocket.on('message', (data) => {
      try {
        const chunk = JSON.parse(data.toString());
        
        // Log chunk metadata in the proxy (timings and speakers)
        deepgramProxy.logChunkMetadata(sessionId, {
          start_ts: chunk.start_ts,
          end_ts: chunk.end_ts,
          speaker: chunk.speaker
        });

        // Extract raw audio data
        const audioBuffer = Buffer.from(chunk.audio_base64, 'base64');
        
        // Push raw binary stream to Deepgram
        deepgramProxy.sendAudio(sessionId, audioBuffer);

        // Bubble up raw audio energy levels for frontend visualization
        // Compute simple RMS of PCM chunk
        const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
        let sum = 0;
        for (let i = 0; i < pcmSamples.length; i++) {
          sum += pcmSamples[i] * pcmSamples[i];
        }
        const rms = Math.sqrt(sum / pcmSamples.length);
        
        broadcastToClients(sessionId, 'visualizer', { 
          rms, 
          speaker: chunk.speaker 
        });

      } catch (err) {
        console.error(`[Server] Error parsing bot chunk for ${sessionId}:`, err.message);
      }
    });

    botSocket.on('close', () => {
      console.log(`[Server] Bot audio stream closed for session ${sessionId}`);
      deepgramProxy.closeSession(sessionId);
    });

    botSocket.on('error', (err) => {
      if (attempts < maxAttempts && processManager.activeSessions.has(sessionId)) {
        setTimeout(tryConnect, 500);
      } else {
        console.error(`[Server] Failed to connect to bot audio stream at ${url}:`, err.message);
      }
    });
  };

  setTimeout(tryConnect, 1000); // Give the bot a second to start its WS server
}

/**
 * Handle UI WebSocket connection handshakes
 */
server.on('upgrade', (request, socket, head) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  if (urlObj.pathname === '/ws/transcripts') {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, request) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const sessionId = urlObj.searchParams.get('sessionId');

  if (!sessionId) {
    ws.close(1008, 'Missing sessionId parameter');
    return;
  }

  console.log(`[Server] UI Client connected to session ${sessionId}`);

  if (!clientSockets.has(sessionId)) {
    clientSockets.set(sessionId, new Set());
  }
  clientSockets.get(sessionId).add(ws);

  // Send current status immediately
  const session = processManager.getSession(sessionId);
  if (session) {
    ws.send(JSON.stringify({
      type: 'status',
      data: { status: session.status }
    }));
  }

  ws.on('close', () => {
    console.log(`[Server] UI Client disconnected from session ${sessionId}`);
    const sockets = clientSockets.get(sessionId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        clientSockets.delete(sessionId);
      }
    }
  });
});

// Port configuration
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n==================================================================`);
  console.log(`Central Meeting Bot Dashboard is running at: http://localhost:${PORT}`);
  console.log(`==================================================================\n`);
});
