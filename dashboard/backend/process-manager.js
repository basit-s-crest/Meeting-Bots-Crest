import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import net from 'net';
import readline from 'readline';
import { saveSessionStart, saveSessionEnd, uploadReport, getAttendeeEmailsForSession } from './supabase-helper.js';
import { uploadTranscriptToGoogleDrive, uploadReportToGoogleDrive } from './google-drive-helper.js';
import { generateReportWithFallback, saveSchedulingData } from './report-generator.js';
import { saveMarkdownAsDocx } from './docx-generator.js';
import { processMeeting } from './memory-client.js';
import { sendReportEmailToAttendees } from './email-service.js';

let onBotStartCallback = null;
let onBotStopCallback = null;

export function setOnBotStartCallback(fn) {
  onBotStartCallback = fn;
}

export function setOnBotStopCallback(fn) {
  onBotStopCallback = fn;
}

/**
 * Helper to find a free port for WebSocket server
 */

export async function getFreePort(startPort = 8090) {
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


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Directory configurations
const ROOT_DIR = path.resolve(__dirname, '../..');
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');

if (!fs.existsSync(TRANSCRIPTS_DIR)) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
}

function aggregateTranscriptFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return;
    const lines = content.split('\n');
    const parsed = [];

    // Pass 1: collect lines and build channel -> confident speaker map
    const channelSpeakerMap = new Map();
    const allKnownSpeakers = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const data = JSON.parse(line);
        const channel = (typeof data.channel === 'number') ? data.channel : null;
        let speaker = (data.speaker || '').trim();

        const isGeneric = !speaker ||
          speaker === 'null' ||
          speaker === 'Unknown' ||
          speaker.toLowerCase().startsWith('speaker_') ||
          speaker.toLowerCase().startsWith('speaker ');

        if (!isGeneric) {
          if (channel !== null && !channelSpeakerMap.has(channel)) {
            channelSpeakerMap.set(channel, speaker);
          }
          allKnownSpeakers.add(speaker);
        }
        parsed.push({ ...data, channel });
      } catch (e) {
        parsed.push(line);
      }
    }

    // Pass 2: backfill unknown/provisional channel speakers and normalize alias formatting
    const normalizedList = [];
    for (const item of parsed) {
      if (typeof item === 'string') {
        normalizedList.push(item);
        continue;
      }
      let speaker = (item.speaker || '').trim();
      const channel = item.channel;

      const isGeneric = !speaker ||
        speaker === 'null' ||
        speaker === 'Unknown' ||
        speaker.toLowerCase().startsWith('speaker_') ||
        speaker.toLowerCase().startsWith('speaker ');

      if (isGeneric && channel !== null && channelSpeakerMap.has(channel)) {
        speaker = channelSpeakerMap.get(channel);
      }

      // If still generic and only 1 known remote speaker exists in the meeting, attribute to them
      if (isGeneric && allKnownSpeakers.size === 1) {
        speaker = Array.from(allKnownSpeakers)[0];
      }

      const text = (item.text || '').trim();
      if (!text) continue;

      normalizedList.push({
        speaker: speaker || 'Speaker',
        text,
        timestamp: item.timestamp,
        channel
      });
    }

    // Pass 3: aggregate consecutive turns from the same speaker or matching alias into one clean block
    const aggregated = [];
    for (const item of normalizedList) {
      if (typeof item === 'string') {
        aggregated.push(item);
        continue;
      }
      const last = aggregated[aggregated.length - 1];
      const normCur = item.speaker.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
      const normLast = (last && last.speaker) ? last.speaker.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim() : '';

      const isSameSpeaker = last && (
        last.speaker === item.speaker ||
        normCur === normLast ||
        (normCur.includes(normLast) && normLast.length >= 4) ||
        (normLast.includes(normCur) && normCur.length >= 4)
      );

      if (isSameSpeaker) {
        // Prefer the cleaner human display name
        if (item.speaker.length > last.speaker.length && !item.speaker.includes('0') && !item.speaker.includes('1')) {
          last.speaker = item.speaker;
        }
        // Deduplicate words if the segment was repeated
        const curText = item.text.trim();
        if (!last.text.endsWith(curText)) {
          last.text += ' ' + curText;
        }
      } else {
        aggregated.push({
          speaker: item.speaker,
          text: item.text.trim(),
          timestamp: item.timestamp
        });
      }
    }

    const outputContent = aggregated.map(item => {
      if (typeof item === 'string') return item;
      return JSON.stringify(item);
    }).join('\n') + '\n';

    fs.writeFileSync(filePath, outputContent, 'utf8');
    console.log(`[ProcessManager] Successfully aggregated transcript file: ${filePath}`);
  } catch (err) {
    console.error(`[ProcessManager] Failed to aggregate transcript file:`, err.message);
  }
}

class ProcessManager {
  constructor() {
    this.activeSessions = new Map(); // sessionId -> { childProcess, type, status, wsPort, outputPath, tailInterval }
  }

  /**
   * Cleans up all timers and intervals attached to a session object.
   */
  cleanupSessionTimers(sessionInfo) {
    if (sessionInfo && sessionInfo.tailInterval) {
      clearInterval(sessionInfo.tailInterval);
      sessionInfo.tailInterval = null;
    }
  }

  /**
   * Spawns the requested meeting bot process.
   */
  spawnBot(sessionId, { botType, meetingUrl, botName, isHeadless, wsPort, googleDriveFolderId, projectId, attendeeEmails = [], joinMethod = 'manual' }) {
    if (this.activeSessions.has(sessionId)) {
      throw new Error(`Session ${sessionId} is already active.`);
    }

    const headlessFlag = isHeadless ? 'true' : 'false';
    const isWin = process.platform === 'win32';
    const nodeCmd = isWin ? 'node' : 'node';

    const targetWsPort = (wsPort && !isNaN(wsPort)) ? Number(wsPort) : 8090;

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
        '--port', String(targetWsPort),
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
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });

    // Log active session startup to Supabase asynchronously
    saveSessionStart(sessionId, botType, meetingUrl, botName, projectId, attendeeEmails).catch(err => {
      console.error(`[ProcessManager] Supabase saveSessionStart error:`, err.message);
    });

    if (onBotStartCallback) {
      try {
        onBotStartCallback({ sessionId, botType, meetingUrl, botName, projectId, wsPort, joinMethod });
      } catch (err) {
        console.error(`[ProcessManager] onBotStartCallback error:`, err.message);
      }
    }


    const sessionInfo = {
      childProcess: child,
      type: botType,
      status: 'starting',
      wsPort: wsPort,
      meetingUrl: meetingUrl,
      botName: botName,
      projectId: projectId,
      joinMethod: joinMethod,
      attendeeEmails: attendeeEmails,
      outputPath: outputPath,
      tailInterval: null,
      onTranscriptCallback: null,
      onStatusCallback: null,
      googleDriveFolderId,
      exitReason: null
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

    // Listen for structured IPC messages from bot child process
    child.on('message', (msg) => {
      if (msg && msg.type === 'SESSION_REASON' && msg.reason) {
        console.log(`[ProcessManager] Structured IPC exit reason for ${sessionId}: ${msg.reason}`);
        sessionInfo.exitReason = msg.reason;
      }
    });

    // Capture logs via line-buffered interface to prevent chunk splitting
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      console.log(`[BotStdout][${botType}][${sessionId}] ${trimmed}`);

      if (trimmed.includes('REASON:')) {
        const match = trimmed.match(/REASON:\s*(\w+)/);
        if (match && !sessionInfo.exitReason) {
          sessionInfo.exitReason = match[1];
        }
      }

      if (trimmed.includes('State:') || trimmed.includes('[Lifecycle] State transition:')) {
        const stateMatch = trimmed.match(/State:\s*(\w+)/) || trimmed.match(/State transition:\s*(\w+)/);
        if (stateMatch && sessionInfo.onStatusCallback) {
          sessionInfo.status = stateMatch[1];
          sessionInfo.onStatusCallback(sessionInfo.status);
        }
      }
    });

    child.stderr.on('data', (data) => {
      console.error(`[BotStderr][${botType}][${sessionId}] ${data.toString().trim()}`);
    });

    child.on('error', (err) => {
      console.error(`[ProcessManager] Session ${sessionId} process error:`, err.message);
      this.cleanupSessionTimers(sessionInfo);
      sessionInfo.status = 'stopped';
      if (sessionInfo.onStatusCallback) {
        sessionInfo.onStatusCallback('stopped');
      }
      this.activeSessions.delete(sessionId);
    });

    child.on('exit', (code) => {
      this.cleanupSessionTimers(sessionInfo);
    });

    child.on('close', (code) => {
      console.log(`[ProcessManager] Session ${sessionId} exited with code ${code}`);
      this.cleanupSessionTimers(sessionInfo);
      sessionInfo.status = 'stopped';

      const finalReason = sessionInfo.exitReason || 'unknown';
      console.log(`[ProcessManager] Final exit reason for session ${sessionId}: ${finalReason}`);

      if (sessionInfo.onStatusCallback) {
        sessionInfo.onStatusCallback('stopped');
      }
      this.activeSessions.delete(sessionId);

      if (onBotStopCallback) {
        try {
          onBotStopCallback({ sessionId, reason: finalReason });
        } catch (err) {
          console.error(`[ProcessManager] onBotStopCallback error:`, err.message);
        }
      }

      const filename = `${botType}_${sessionId}.jsonl`;
      const localTranscriptPath = path.join(TRANSCRIPTS_DIR, filename);

      (async () => {
        try {
          // Wait briefly to ensure file descriptors are completely flushed/closed by the child
          await new Promise(r => setTimeout(r, 1000));

          if (!fs.existsSync(localTranscriptPath)) {
            console.warn(`[ProcessManager] Transcript file not found at exit: ${localTranscriptPath}`);
            await saveSessionEnd(sessionId, botType);
            return;
          }

          const stats = fs.statSync(localTranscriptPath);
          if (stats.size === 0) {
            console.warn(`[ProcessManager] Transcript file is 0 bytes for session ${sessionId}. Marking session as empty and skipping report generation.`);
            await saveSessionEnd(sessionId, botType);
            return;
          }

          // Aggregate adjacent speaker turns in the transcript file
          console.log(`[ProcessManager] Aggregating transcript file...`);
          aggregateTranscriptFile(localTranscriptPath);

          // Await Supabase log end and transcript upload
          console.log(`[ProcessManager] Saving session end and uploading transcript to Supabase...`);
          await saveSessionEnd(sessionId, botType);

          console.log(`[ProcessManager] Auto-generating combined report and transcript for session ${sessionId}...`);
          const { markdown: reportMarkdown, scheduling } = await generateReportWithFallback(localTranscriptPath);

          // Save markdown locally temporarily
          const reportFilename = `${botType}_${sessionId}_report.md`;
          const reportPath = path.join(TRANSCRIPTS_DIR, reportFilename);
          fs.writeFileSync(reportPath, reportMarkdown, 'utf8');

          // Save scheduling data companion JSON locally temporarily BEFORE uploading report
          const schedulingPath = path.join(TRANSCRIPTS_DIR, `${botType}_${sessionId}_report_scheduling.json`);
          await saveSchedulingData(schedulingPath, scheduling);

          // Await uploading report to Supabase Storage
          console.log(`[ProcessManager] Uploading report to Supabase for session: ${sessionId}`);
          const publicUrl = await uploadReport(sessionId, botType);

          // Automatically send report email to stored attendee list
          try {
            const emails = (sessionInfo && Array.isArray(sessionInfo.attendeeEmails) && sessionInfo.attendeeEmails.length > 0)
              ? sessionInfo.attendeeEmails
              : await getAttendeeEmailsForSession(sessionId);

            if (emails && emails.length > 0) {
              console.log(`[ProcessManager] Triggering bulk email report distribution for session ${sessionId}...`);
              await sendReportEmailToAttendees({
                sessionId,
                meetingTitle: sessionInfo?.botName,
                reportMarkdown,
                reportUrl: publicUrl,
                attendeeEmails: emails,
                localReportPath: reportPath
              });
            }
          } catch (emailErr) {
            console.error(`[ProcessManager] Failed to distribute report emails for ${sessionId}:`, emailErr.message);
          }

          // Upload to Google Drive if folder ID is configured
          let driveFolderId = sessionInfo.googleDriveFolderId;
          if (!driveFolderId) {
            const metadataPath = path.join(TRANSCRIPTS_DIR, `${botType}_${sessionId}_metadata.json`);
            if (fs.existsSync(metadataPath)) {
              try {
                const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
                driveFolderId = metadata.googleDriveFolderId;
              } catch (e) { }
            }
          }

          if (driveFolderId) {
            // Generate temporary DOCX for Google Drive upload fallback if needed
            const docxFilename = `${botType}_${sessionId}_report.docx`;
            const docxPath = path.join(TRANSCRIPTS_DIR, docxFilename);
            try {
              console.log(`[ProcessManager] Generating temporary DOCX for Google Drive upload fallback...`);
              await saveMarkdownAsDocx(reportMarkdown, docxPath);
            } catch (docxErr) {
              console.error(`[ProcessManager] Failed to generate temporary DOCX:`, docxErr.message);
            }

            console.log(`[ProcessManager] Uploading combined document to Google Drive folder: ${driveFolderId}`);
            await uploadReportToGoogleDrive(filename, driveFolderId);
          }

          // Strict Clean-up: Delete all local temp files immediately
          try {
            console.log(`[ProcessManager] Cleaning up local temporary files for session ${sessionId}...`);
            if (fs.existsSync(localTranscriptPath)) fs.unlinkSync(localTranscriptPath);
            if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
            if (fs.existsSync(schedulingPath)) fs.unlinkSync(schedulingPath);

            const docxFilename = `${botType}_${sessionId}_report.docx`;
            const docxPath = path.join(TRANSCRIPTS_DIR, docxFilename);
            if (fs.existsSync(docxPath)) fs.unlinkSync(docxPath);

            console.log(`[ProcessManager] Local storage successfully cleared for session ${sessionId}.`);
          } catch (cleanErr) {
            console.error(`[ProcessManager] Failed to clean up local files:`, cleanErr.message);
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
  async killBot(sessionId, explicitReason = 'dashboard_leave') {
    const session = this.activeSessions.get(sessionId);
    if (!session) {
      console.warn(`[ProcessManager] Attempted to kill inactive session ${sessionId}`);
      return;
    }

    session.exitReason = explicitReason;
    console.log(`[ProcessManager] Terminating session ${sessionId} (reason: ${explicitReason})`);
    
    this.cleanupSessionTimers(session);

    return new Promise((resolve) => {
      const child = session.childProcess;
      let killed = false;

      // Handle process exit during kill
      child.once('exit', () => {
        killed = true;
        this.cleanupSessionTimers(session);
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
            } catch { }
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
