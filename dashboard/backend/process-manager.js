import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { saveSessionStart, saveSessionEnd } from './supabase-helper.js';
import { uploadTranscriptToGoogleDrive, uploadReportToGoogleDrive } from './google-drive-helper.js';
import { generateReportWithFallback } from './report-generator.js';
import { saveMarkdownAsDocx } from './docx-generator.js';

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
  spawnBot(sessionId, { botType, meetingUrl, botName, isHeadless, wsPort, googleDriveFolderId }) {
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
        '--guest',
        '--channel', 'chrome'
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
      shell: false
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
      onStatusCallback: null,
      googleDriveFolderId
    };

    this.activeSessions.set(sessionId, sessionInfo);

    // Save session Google Drive folder metadata companion file
    if (googleDriveFolderId) {
      const metadataPath = path.join(TRANSCRIPTS_DIR, `${botType}_${sessionId}_metadata.json`);
      try {
        fs.writeFileSync(metadataPath, JSON.stringify({ googleDriveFolderId }, null, 2), 'utf8');
        console.log(`[ProcessManager] Saved session metadata to: ${metadataPath}`);
      } catch (err) {
        console.error(`[ProcessManager] Failed to save session metadata:`, err.message);
      }
    }

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

      // Auto-generate combined report/transcript and sync to Google Drive
      const filename = `${botType}_${sessionId}.jsonl`;
      const localTranscriptPath = path.join(TRANSCRIPTS_DIR, filename);

      (async () => {
        try {
          // Wait briefly to ensure file descriptors are completely flushed/closed by the child
          await new Promise(r => setTimeout(r, 1000));

          if (!fs.existsSync(localTranscriptPath)) {
            console.warn(`[ProcessManager] Transcript file not found at exit: ${localTranscriptPath}`);
            return;
          }

          console.log(`[ProcessManager] Auto-generating combined report and transcript for session ${sessionId}...`);
          const reportMarkdown = await generateReportWithFallback(localTranscriptPath);
          
          // Save markdown locally
          const reportFilename = `${botType}_${sessionId}_report.md`;
          const reportPath = path.join(TRANSCRIPTS_DIR, reportFilename);
          fs.writeFileSync(reportPath, reportMarkdown, 'utf8');

          // Save DOCX locally
          const docxFilename = `${botType}_${sessionId}_report.docx`;
          const docxPath = path.join(TRANSCRIPTS_DIR, docxFilename);
          await saveMarkdownAsDocx(reportMarkdown, docxPath);
          console.log(`[ProcessManager] Local report and DOCX generated successfully for ${sessionId}`);

          // Upload to Google Drive if folder ID is configured
          const driveFolderId = sessionInfo.googleDriveFolderId;
          if (driveFolderId) {
            console.log(`[ProcessManager] Uploading combined document to Google Drive folder: ${driveFolderId}`);
            await uploadReportToGoogleDrive(filename, driveFolderId);
          }
        } catch (err) {
          console.error(`[ProcessManager] Auto-report generation/Drive sync failed for ${sessionId}:`, err.message);
        }
      })();
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

      if (session.type === 'teams') {
        console.log(`[ProcessManager] Sending graceful stop command to Teams session ${sessionId} stdin`);
        
        if (child.stdin && child.stdin.writable) {
          child.stdin.write('stop\n');
        } else {
          // If stdin is not writable, send SIGINT (or fallback to taskkill if on Windows after timeout)
          if (process.platform !== 'win32') {
            child.kill('SIGINT');
          }
        }

        // Fallback force kill after 3 seconds if not already exited
        setTimeout(() => {
          if (!killed) {
            console.log(`[ProcessManager] Teams graceful stop timed out after 3s, force killing...`);
            if (process.platform === 'win32') {
              spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
            } else {
              child.kill('SIGKILL');
            }
            this.activeSessions.delete(sessionId);
            resolve();
          }
        }, 3000);
        
      } else {
        // ORIGINAL BEHAVIOR FOR MEET/ZOOM
        if (process.platform === 'win32') {
          // Windows needs taskkill with /t to kill the child processes spawned via shell: true
          console.log(`[ProcessManager] Killing process tree for session ${sessionId} via taskkill`);
          spawn('taskkill', ['/pid', String(child.pid), '/f', '/t']);
        } else {
          child.kill('SIGINT');
        }
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
      }
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
