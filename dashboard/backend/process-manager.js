import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { saveSessionStart, saveSessionEnd } from './supabase-helper.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory configurations
const ROOT_DIR = path.resolve(__dirname, '../..');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');

if (!fs.existsSync(TRANSCRIPTS_DIR)) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

class ProcessManager {
  constructor() {
    this.activeSessions = new Map(); // sessionId -> { childProcess, type, status, wsPort, outputPath, tailInterval }
  }

  /**
   * Spawns the requested meeting bot process.
   */
  spawnBot(sessionId, { botType, meetingUrl, botName, isHeadless, wsPort }) {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already active.`);
    }

    const headlessFlag = isHeadless ? 'true' : 'false';
    const isWin = process.platform === 'win32';
    const nodeCmd = isWin ? 'node' : 'node';

    let cwd = '';
    let scriptPath = '';
    let args = [];
    let outputPath = '';

    if (botType === 'google-meet') {
      cwd = path.join(ROOT_DIR, 'Google Meet');
      scriptPath = 'src/index.js';
      args = [
        scriptPath,
        '--url', meetingUrl,
        '--name', botName,
        '--output', 'websocket',
        '--port', String(wsPort),
        '--user-data-dir', './.user_data',
        '--channel', 'chrome'
      ];
      if (!isHeadless) {
        args.push('--headful');
      } else {
        // Enforce headless via env or let it default
        process.env.HEADLESS = 'true';
      }
    } else if (botType === 'zoom') {
      cwd = path.join(ROOT_DIR, 'Zoom');
      scriptPath = 'src/index.js';
      args = [
        scriptPath,
        '--url', meetingUrl,
        '--name', botName,
        '--output', 'websocket',
        '--port', String(wsPort)
      ];
      if (!isHeadless) {
        args.push('--headful');
      } else {
        process.env.HEADLESS = 'true';
      }
    } else if (botType === 'teams') {
      cwd = path.join(ROOT_DIR, 'Microsoft Teams');
      scriptPath = 'src/index.js';
      outputPath = path.join(TRANSCRIPTS_DIR, `teams_${sessionId}.jsonl`);
      args = [
        scriptPath,
        '--url', meetingUrl,
        '--name', botName,
        '--output', outputPath,
        '--capture', 'captions',
        '--guest'
      ];
      if (!isHeadless) {
        args.push('--headful');
      } else {
        process.env.HEADLESS = 'true';
      }
    } else {
      throw new Error(`Unsupported bot type: ${botType}`);
    }

    console.log(`[ProcessManager] Spawning ${botType} bot for session ${sessionId}`);
    console.log(`[ProcessManager] Command: ${nodeCmd} ${args.join(' ')}`);
    console.log(`[ProcessManager] Working directory: ${cwd}`);

    // Ensure we preserve env variables but can override HEADLESS if necessary
    const env = { ...process.env, HEADLESS: headlessFlag, PARENT_PID: String(process.pid) };

    const child = spawn(nodeCmd, args, {
      cwd,
      env,
      shell: isWin // Important for Windows to execute node command pathing cleanly
    });

    // Log active session startup to Supabase asynchronously
    saveSessionStart(sessionId, botType, meetingUrl, botName).catch(err => {
      console.error(`[ProcessManager] Supabase saveSessionStart error:`, err.message);
    });

    const sessionInfo = {
      childProcess: child,
      type: botType,
      status: 'starting',
      wsPort: wsPort,
      outputPath: outputPath,
      tailInterval: null,
      onTranscriptCallback: null,
      onStatusCallback: null
    };

    this.activeSessions.set(sessionId, sessionInfo);

    // Capture logs
    child.stdout.on('data', (data) => {
      const log = data.toString().trim();
      console.log(`[BotStdout][${botType}][${sessionId}] ${log}`);
      
      // Parse state updates if printed
      if (log.includes('State:') || log.includes('[Lifecycle] State transition:')) {
        const stateMatch = log.match(/State:\s*(\w+)/) || log.match(/State transition:\s*(\w+)/);
        if (stateMatch && sessionInfo.onStatusCallback) {
          sessionInfo.status = stateMatch[1];
          sessionInfo.onStatusCallback(sessionInfo.status);
        }
      }
      
      // NOTE: Replaced stdout transcript parsing for Teams to prevent duplication.
      // The file tail watcher (startTeamsFileTail) acts as the single source of truth.
    });

    child.stderr.on('data', (data) => {
      console.error(`[BotStderr][${botType}][${sessionId}] ${data.toString().trim()}`);
    });

    child.on('close', (code) => {
      console.log(`[ProcessManager] Session ${sessionId} exited with code ${code}`);
      if (sessionInfo.tailInterval) {
        clearInterval(sessionInfo.tailInterval);
      }
      sessionInfo.status = 'stopped';
      if (sessionInfo.onStatusCallback) {
        sessionInfo.onStatusCallback('stopped');
      }
      this.activeSessions.delete(sessionId);

      // Log session end and upload transcript to Supabase asynchronously
      saveSessionEnd(sessionId, botType).catch(err => {
        console.error(`[ProcessManager] Supabase saveSessionEnd error:`, err.message);
      });
    });

    // If Teams bot, we also set up a file tail watcher on the output JSONL file as a backup/primary data source
    if (botType === 'teams' && outputPath) {
      this.startTeamsFileTail(sessionId, sessionInfo);
    }

    return sessionInfo;
  }

  /**
   * Monitor output JSONL files for Teams and emit new lines as transcripts
   */
  startTeamsFileTail(sessionId, sessionInfo) {
    let lastSize = 0;
    
    // Periodically poll file size changes
    sessionInfo.tailInterval = setInterval(() => {
      try {
        if (!fs.existsSync(sessionInfo.outputPath)) return;
        const stats = fs.statSync(sessionInfo.outputPath);
        if (stats.size > lastSize) {
          const stream = fs.createReadStream(sessionInfo.outputPath, {
            start: lastSize,
            end: stats.size
          });
          
          let data = '';
          stream.on('data', (chunk) => {
            data += chunk.toString();
          });
          
          stream.on('end', () => {
            lastSize = stats.size;
            const lines = data.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
              try {
                const event = JSON.parse(line);
                if (sessionInfo.onTranscriptCallback) {
                  sessionInfo.onTranscriptCallback({
                    speaker: event.speaker || 'Unknown',
                    text: event.text || '',
                    timestamp: event.timestamp || new Date().toISOString(),
                    isFinal: true
                  });
                }
              } catch (err) {
                console.error('[ProcessManager] Error parsing JSONL line:', err.message);
              }
            }
          });
        }
      } catch (err) {
        console.error('[ProcessManager] Teams file tailing error:', err.message);
      }
    }, 1000);
  }

  /**
   * Kills the requested bot process gracefully, then forcefully if needed.
   */
  async killBot(sessionId) {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.warn(`[ProcessManager] Attempted to kill inactive session ${sessionId}`);
      return;
    }

    console.log(`[ProcessManager] Terminating session ${sessionId}`);
    
    if (session.tailInterval) {
      clearInterval(session.tailInterval);
    }

    return new Promise((resolve) => {
      const child = session.childProcess;
      let killed = false;

      // Handle process exit during kill
      child.once('exit', () => {
        killed = true;
        this.activeSessions.delete(sessionId);
        resolve();
      });

      // Try graceful stdin stop first
      if (child.stdin && child.stdin.writable) {
        console.log(`[ProcessManager] Sending graceful stop command to session ${sessionId} stdin`);
        child.stdin.write('stop\n');
      } else {
        // Try SIGINT (fallback)
        child.kill('SIGINT');
      }

      // Fallback SIGINT in case stdin didn't trigger exit immediately
      setTimeout(() => {
        if (!killed) {
          console.log(`[ProcessManager] Graceful stop did not exit yet, sending SIGINT to ${sessionId}`);
          try {
            child.kill('SIGINT');
          } catch {}
        }
      }, 1500);

      // Force kill fallback after 5 seconds
      setTimeout(() => {
        if (!killed) {
          console.log(`[ProcessManager] Force killing session ${sessionId} with SIGKILL`);
          child.kill('SIGKILL');
          this.activeSessions.delete(sessionId);
          resolve();
        }
      }, 5000);
    });
  }

  /**
   * Retrieve session info.
   */
  getSession(sessionId) {
    return this.activeSessions.get(sessionId);
  }
}

export const processManager = new ProcessManager();
