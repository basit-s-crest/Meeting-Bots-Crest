import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';

import { processManager } from './process-manager.js';
import { deepgramProxyGoogle } from './deepgram-proxy-google.js';
import { deepgramProxyZoom } from './deepgram-proxy-zoom.js';
import { generateFirefliesReport, calculateSpeakerStats, saveSchedulingData } from './report-generator.js';
import { supabase } from './supabase-client.js';
import { uploadReport } from './supabase-helper.js';
import { convertMarkdownToDocx, saveMarkdownAsDocx } from './docx-generator.js';
import { getOAuth2Client, saveRefreshToken, loadRefreshToken, uploadReportToGoogleDrive } from './google-drive-helper.js';
import { calendarRouter } from './calendar/calendar-router.js';
import { ingestSegment, queryMemory, processMeeting, getProjectMemory } from './memory-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env file from the root directory (override: true ensures .env values take precedence over system env vars)
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
console.log(`[Server] Loaded Deepgram API Key: ${DEEPGRAM_API_KEY ? 'Present (Configured)' : 'Missing'}`);

const app = express();
app.use(cors({ origin: 'http://localhost:3001', credentials: true }));
app.use(express.json());

// Serve static frontend files
const frontendPublicPath = path.resolve(__dirname, '../frontend/public');
app.use(express.static(frontendPublicPath));

// Google Calendar Scheduling Routes
app.use('/api/calendar', calendarRouter);

// Memory Service Routes (cross-meeting query + project memory)
app.post('/api/memory/query', async (req, res) => {
  try {
    const result = await queryMemory(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/projects/:id', async (req, res) => {
  try {
    const data = await getProjectMemory(req.params.id);
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET list of all projects
app.get('/api/projects', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*');
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[Server] GET /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST create a new project
app.post('/api/projects', async (req, res) => {
  try {
    const { name, description } = req.body;
    const { data, error } = await supabase
      .from('projects')
      .insert({ name, description })
      .select()
      .single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error('[Server] POST /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Google Drive OAuth Routes
app.get('/api/auth/google', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    return res.status(500).send('Google Client credentials are not configured in the .env file.');
  }
  try {
    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/drive.file']
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[Server] Failed to generate Google auth URL:', err.message);
    res.status(500).send('Google authentication initiation failed.');
  }
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code in query.');
  }
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    if (tokens.refresh_token) {
      saveRefreshToken(tokens.refresh_token);
    } else {
      console.log('[Google Auth] No refresh token returned in callback.');
    }
    res.redirect('/');
  } catch (err) {
    console.error('[Server] Google OAuth callback code exchange failed:', err.message);
    res.status(500).send('Google authentication failed during code exchange.');
  }
});

app.get('/api/auth/google/status', (req, res) => {
  const token = loadRefreshToken();
  const configured = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
  res.json({ connected: !!token && configured });
});

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
  let { botType, meetingUrl, botName, isHeadless, googleDriveFolderId, projectId } = req.body;

  if (!botType || !meetingUrl) {
    return res.status(400).json({ error: 'Missing required parameters: botType and meetingUrl' });
  }

  // Auto-detect and correct bot type based on URL structure to prevent mismatched bot launching
  const lowerUrl = meetingUrl.toLowerCase();
  if (lowerUrl.includes('meet.google.com') && botType !== 'google-meet') {
    botType = 'google-meet';
  } else if (lowerUrl.includes('zoom.us') && botType !== 'zoom') {
    botType = 'zoom';
  } else if ((lowerUrl.includes('teams.microsoft.com') || lowerUrl.includes('teams.live.com') || lowerUrl.includes('/meet/')) && botType !== 'teams') {
    botType = 'teams';
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
      wsPort,
      googleDriveFolderId,
      projectId
    });

    // Handle process events/callbacks
    sessionInfo.onStatusCallback = (status) => {
      broadcastToClients(sessionId, 'status', { status });
    };

    sessionInfo.onTranscriptCallback = (transcriptEvent) => {
      // Teams returns transcripts directly
      broadcastToClients(sessionId, 'transcript', transcriptEvent);
      if (transcriptEvent.isFinal) {
        ingestSegment(sessionId, {
          speaker: transcriptEvent.speaker,
          text: transcriptEvent.text,
          startTs: 0,
          endTs: 0,
          isFinal: true,
          projectId,
        });
      }
    };

    // If Google Meet or Zoom, we connect to their WebSocket stream to extract audio and push to Deepgram
    if (botType === 'google-meet' || botType === 'zoom') {
      connectToBotAudioStream(sessionId, wsPort, botType, projectId);
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
    deepgramProxyGoogle.closeSession(sessionId);
    deepgramProxyZoom.closeSession(sessionId);
    await processManager.killBot(sessionId);
    // Trigger post-meeting extraction (fire-and-forget)
    processMeeting(sessionId);
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
app.get('/api/transcripts', async (req, res) => {
  try {
    // 1. Fetch sessions from Supabase database
    let dbQuery = supabase
      .from('meeting_sessions')
      .select('*')
      .order('created_at', { ascending: false });

    // Parse and sanitize projectId filter(s) to handle edge cases ("", whitespace, array of projectIds)
    let projectIds = [];
    if (req.query.projectId !== undefined && req.query.projectId !== null) {
      const rawList = Array.isArray(req.query.projectId) ? req.query.projectId : [req.query.projectId];
      projectIds = rawList
        .filter(p => typeof p === 'string')
        .map(p => p.trim())
        .filter(p => p.length > 0);
    }

    if (projectIds.length === 1) {
      dbQuery = dbQuery.eq('project_id', projectIds[0]);
    } else if (projectIds.length > 1) {
      dbQuery = dbQuery.in('project_id', projectIds);
    }

    const { data: dbSessions, error } = await dbQuery;
    if (error) throw error;

    // Convert dbSessions to the format expected by the frontend
    const list = dbSessions.map(s => ({
      fileName: `${s.bot_type}_${s.session_id}.jsonl`,
      sessionId: s.session_id,
      created: s.created_at,
      size: 0, // DB-backed files sizes are fetched from storage metadata if needed
      isDbBacked: true,
      botType: s.bot_type,
      status: s.status,
      transcriptFileUrl: s.transcript_file_url,
      reportFileUrl: s.report_file_url
    }));

    // 2. Add local files that are not in the database (only when no specific projectId filter is requested)
    if (projectIds.length === 0) {
      for (const f of localFiles) {
        const match = f.match(/^(teams|meet|zoom)_(.+)\.jsonl$/);
        if (match) {
          const [_, type, sessionId] = match;
          if (!dbSessionIds.has(sessionId)) {
            try {
              const stats = fs.statSync(path.join(transcriptsDir, f));
              list.push({
                fileName: f,
                sessionId: sessionId,
                created: stats.birthtime,
                size: stats.size,
                isDbBacked: false,
                botType: type,
                status: 'completed'
              });
            } catch (e) {
              // Ignore missing file stats
            }
          }
        }
      }
    }

    // Sort final combined list by created date descending
    list.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ transcripts: list });
  } catch (err) {
    console.error('[Server] Supabase transcripts fetch failed:', err.message);
    res.status(500).json({ error: `Failed to fetch transcripts: ${err.message}` });
  }
});

/**
 * REST API: Read individual transcript file
 */
app.get('/api/transcripts/:filename', async (req, res) => {
  const filename = req.params.filename;
  
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const filePath = path.join(transcriptsDir, filename);

  try {
    // 1. Try to fetch from Supabase storage URL
    const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
    if (match) {
      try {
        const [_, botType, sessionId] = match;
        const { data: session, error } = await supabase
          .from('meeting_sessions')
          .select('transcript_file_url')
          .eq('session_id', sessionId)
          .single();
        
        if (!error && session && session.transcript_file_url) {
          const fetchRes = await fetch(session.transcript_file_url);
          if (fetchRes.ok) {
            const content = await fetchRes.text();
            const lines = content.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
            return res.json({ lines });
          }
        }
      } catch (dbErr) {
        console.warn(`[Server] Supabase transcript fetch failed for ${filename}, falling back to local files:`, dbErr.message);
      }
    }

    // 2. Fallback to local filesystem
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Transcript file not found' });
    }

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
  const reportFilename = filename.replace('.jsonl', '_report.md');
  const reportPath = path.join(transcriptsDir, reportFilename);
  const schedulingFilename = filename.replace('.jsonl', '_report_scheduling.json');
  const schedulingPath = path.join(transcriptsDir, schedulingFilename);
  const legacyFilename = filename.replace('.jsonl', '_scheduling.json');
  const legacySchedulingPath = path.join(transcriptsDir, legacyFilename);

  // Parse filename to query Supabase if it's DB-backed
  const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  let dbSession = null;
  let botType = 'meet';
  let sessionId = null;
  if (match) {
    const [_, type, sid] = match;
    botType = type;
    sessionId = sid;
  }

  // 1. LOCAL REPORT CACHING CHECK:
  if (fs.existsSync(reportPath)) {
    console.log(`[Server] Report already exists for ${filename}. Loading cached files.`);
    try {
      const { data, error } = await supabase
        .from('meeting_sessions')
        .select('report_file_url, transcript_file_url')
        .eq('session_id', sessionId)
        .single();
      if (!error && data) {
        dbSession = data;
      }
    } catch (dbErr) {
      console.warn(`[Server] Supabase session fetch failed in generate-report for ${filename}:`, dbErr.message);
    }
  }

  // 1. REPORT CACHING CHECK (Supabase first):
  if (dbSession && dbSession.report_file_url) {
    try {
      console.log(`[Server] Report already exists in Supabase for ${filename}. Fetching...`);
      const reportRes = await fetch(dbSession.report_file_url);
      if (reportRes.ok) {
        const reportMarkdown = await reportRes.text();
        
        // Fetch scheduling companion JSON from storage (replace report.md with scheduling.json)
        let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
        const schedUrl = dbSession.report_file_url.replace('/report.md', '/scheduling.json');
        try {
          const schedRes = await fetch(schedUrl);
          if (schedRes.ok) {
            schedulingData = await schedRes.json();
          }
        } catch (e) {
          console.warn(`[Server] Failed to fetch scheduling companion from Supabase:`, e.message);
        }

        return res.json({
          success: true,
          cached: true,
          report: reportMarkdown,
          scheduling: schedulingData
        });
      }
    } catch (fetchErr) {
      console.error(`[Server] Failed to fetch report from Supabase:`, fetchErr.message);
    }
  }

  // 2. SUPABASE STORAGE FALLBACK (For sessions recorded on another local/machine):
  const fallbackMatch = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  if (fallbackMatch) {
    const [_, supaBotType, supaSessionId] = fallbackMatch;
    try {
      const { data: session, error: dbErr } = await supabase
        .from('meeting_sessions')
        .select('report_file_url, transcript_file_url')
        .eq('session_id', supaSessionId)
        .single();

      if (!dbErr && session) {
        // If report markdown is stored in Supabase Storage, fetch and return it directly
        if (session.report_file_url) {
          console.log(`[Server] Fetching report from Supabase storage for ${supaSessionId}...`);
          const reportRes = await fetch(session.report_file_url);
          if (reportRes.ok) {
            const reportMarkdown = await reportRes.text();
            fs.writeFileSync(reportPath, reportMarkdown, 'utf8');
            let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
            if (fs.existsSync(schedulingPath)) {
              schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
            } else if (fs.existsSync(legacySchedulingPath)) {
              try {
                schedulingData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
                fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
                fs.unlinkSync(legacySchedulingPath);
                console.log(`[Server] Migrated legacy scheduling file in generate-report: ${schedulingFilename}`);
              } catch (e) {
                console.error('[Server] Failed to migrate legacy scheduling file in generate-report check:', e.message);
              }
            }
            return res.json({
              success: true,
              cached: true,
              report: reportMarkdown,
              scheduling: schedulingData
            });
          }
        }

        // If report is not in storage, but transcript file is in storage and not on local disk, download transcript
        if (!fs.existsSync(filePath) && session.transcript_file_url) {
          console.log(`[Server] Fetching transcript from Supabase storage for ${supaSessionId}...`);
          const transcriptRes = await fetch(session.transcript_file_url);
          if (transcriptRes.ok) {
            const transcriptContent = await transcriptRes.text();
            fs.writeFileSync(filePath, transcriptContent, 'utf8');
            console.log(`[Server] Successfully downloaded transcript to ${filePath}`);
          }
        }
      }
    } catch (supaErr) {
      console.warn(`[Server] Supabase storage fallback check failed for ${filename}:`, supaErr.message);
    }
  }

  // 2. TRANSCRIPT CHECK (Local check with Supabase download fallback):
  let isTranscriptTemp = false;
  if (!fs.existsSync(filePath)) {
    if (dbSession && dbSession.transcript_file_url) {
      try {
        console.log(`[Server] Local transcript missing, fetching from Supabase for ${filename}...`);
        const transRes = await fetch(dbSession.transcript_file_url);
        if (transRes.ok) {
          const transContent = await transRes.text();
          fs.writeFileSync(filePath, transContent, 'utf8');
          isTranscriptTemp = true;
          console.log(`[Server] Saved fetched transcript locally to: ${filePath}`);
        } else {
          return res.status(404).json({ error: `Transcript file not found locally or on Supabase (Status: ${transRes.status})` });
        }
      } catch (fetchErr) {
        return res.status(500).json({ error: `Failed to fetch transcript from Supabase: ${fetchErr.message}` });
      }
    } else {
      return res.status(404).json({ error: 'Transcript file not found' });
    }
  }

  try {
    const { markdown, scheduling } = await generateFirefliesReport(filePath);
    
    // Save report file locally temporarily
    fs.writeFileSync(reportPath, markdown, 'utf8');

    // Migrate legacy file if it exists but the new one does not
    if (!fs.existsSync(schedulingPath) && fs.existsSync(legacySchedulingPath)) {
      try {
        const legacyData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
        fs.writeFileSync(schedulingPath, JSON.stringify(legacyData, null, 2), 'utf8');
        fs.unlinkSync(legacySchedulingPath);
        console.log(`[Server] Migrated legacy scheduling file before save: ${schedulingFilename}`);
      } catch (migErr) {
        console.error('[Server] Failed to migrate legacy file before save:', migErr.message);
      }
    }

    const schedulingData = await saveSchedulingData(schedulingPath, scheduling);

    // Update Supabase row and upload report
    if (sessionId) {
      // Parse filename to update Supabase row and upload report
      const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
      if (match) {
        const [_, botType, sessionId] = match;
        console.log(`[Server] Uploading report to Supabase for session: ${sessionId}`);
        await uploadReport(sessionId, botType);
      }

      // Upload reports to Google Drive if metadata exists with folder ID
      const metadataPath = path.join(transcriptsDir, filename.replace('.jsonl', '_metadata.json'));
      if (fs.existsSync(metadataPath)) {
        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
          if (metadata.googleDriveFolderId) {
            // Generate temporary DOCX for Drive upload fallback if needed
            const docxFilename = filename.replace('.jsonl', '_report.docx');
            const docxPath = path.join(transcriptsDir, docxFilename);
            try {
              await saveMarkdownAsDocx(markdown, docxPath);
            } catch (docxErr) {
              console.error(`[Server] Failed to generate temp DOCX for Drive upload:`, docxErr.message);
            }

            // Await Drive upload
            await uploadReportToGoogleDrive(filename, metadata.googleDriveFolderId);

            // Clean up temp docx
            if (fs.existsSync(docxPath)) fs.unlinkSync(docxPath);
          }
        } catch (err) {
          console.error(`[Server] Failed to process Google Drive report upload:`, err.message);
        }
      }
    }

    // Strict Local Clean-up: Delete all local temp files immediately
    try {
      if (isTranscriptTemp && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      if (fs.existsSync(schedulingPath)) fs.unlinkSync(schedulingPath);
      console.log(`[Server] Temp files cleaned up after report generation.`);
    } catch (cleanErr) {
      console.error(`[Server] Failed to clean up temp files:`, cleanErr.message);
    }

    res.json({
      success: true,
      report: markdown,
      scheduling: schedulingData
    });
  } catch (err) {
    console.error('[Server] Failed to generate report:', err.message);
    
    // Clean up if we failed
    try {
      if (isTranscriptTemp && fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(reportPath)) fs.unlinkSync(reportPath);
      if (fs.existsSync(schedulingPath)) fs.unlinkSync(schedulingPath);
    } catch (e) {}

    res.status(500).json({ error: `Report generation failed: ${err.message}` });
  }
});

/**
 * REST API: Get post-meeting report and speaker analytics
 */
app.get('/api/transcripts/:filename/report', async (req, res) => {
  const filename = req.params.filename;
  
  // Sanitize: reject if it contains '..' or has non-alphanumeric/underscore/hyphen/dot characters
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const filePath = path.join(transcriptsDir, filename);
  const reportFilename = filename.replace('.jsonl', '_report.md');
  const reportPath = path.join(transcriptsDir, reportFilename);
  const schedulingFilename = filename.replace('.jsonl', '_report_scheduling.json');
  const schedulingPath = path.join(transcriptsDir, schedulingFilename);
  const legacyFilename = filename.replace('.jsonl', '_scheduling.json');
  const legacySchedulingPath = path.join(transcriptsDir, legacyFilename);

  // Load scheduling data with legacy migration fallback
  let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
  if (fs.existsSync(schedulingPath)) {
    try {
      schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
    } catch (e) {
      console.error('[Server] Failed to parse companion scheduling JSON:', e.message);
    }
  } else if (fs.existsSync(legacySchedulingPath)) {
    try {
      schedulingData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
      fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
      fs.unlinkSync(legacySchedulingPath);
      console.log(`[Server] Migrated legacy scheduling file on GET: ${schedulingFilename}`);
    } catch (e) {
      console.error('[Server] Failed to parse legacy companion scheduling JSON:', e.message);
    }
  }

  try {
    // 1. Try to fetch from Supabase first
    const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
    if (match) {
      try {
        const [_, botType, sessionId] = match;
        const { data: session, error } = await supabase
          .from('meeting_sessions')
          .select('report_file_url, transcript_file_url')
          .eq('session_id', sessionId)
          .single();
        
        if (!error && session && session.report_file_url) {
          const reportRes = await fetch(session.report_file_url);
          if (reportRes.ok) {
            const reportMarkdown = await reportRes.text();
            
            // Fetch scheduling companion from Supabase Storage (replace report.md with scheduling.json)
            const schedUrl = session.report_file_url.replace('/report.md', '/scheduling.json');
            try {
              const schedRes = await fetch(schedUrl);
              if (schedRes.ok) {
                schedulingData = await schedRes.json();
              }
            } catch (schedErr) {
              console.warn(`[Server] Failed to fetch scheduling companion from Supabase:`, schedErr.message);
            }

            // Get transcript contents to calculate statistics
            let lines = [];
            if (session.transcript_file_url) {
              const transRes = await fetch(session.transcript_file_url);
              if (transRes.ok) {
                const transText = await transRes.text();
                lines = transText.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
              }
            }
            
            // Local fallback for transcript calculations if storage fails
            if (lines.length === 0 && fs.existsSync(filePath)) {
              const fileContent = fs.readFileSync(filePath, 'utf8');
              lines = fileContent.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
            }

            const stats = calculateSpeakerStats(lines);
            return res.json({
              report: reportMarkdown,
              analytics: stats.analytics,
              scheduling: schedulingData
            });
          }
        }
      } catch (dbErr) {
        console.warn(`[Server] Supabase report fetch failed for ${filename}, falling back to local files:`, dbErr.message);
      }
    }

    // 2. Fallback to local files if not in database
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Transcript file not found' });
    }

    if (!fs.existsSync(reportPath)) {
      return res.status(404).json({ error: 'Report not yet generated' });
    }

    const reportMarkdown = fs.readFileSync(reportPath, 'utf8');
    
    // Calculate speaker statistics from source .jsonl file for the progress bars
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
    const stats = calculateSpeakerStats(lines);

    res.json({
      report: reportMarkdown,
      analytics: stats.analytics,
      scheduling: schedulingData
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to retrieve report: ${err.message}` });
  }
});

/**
 * REST API: Download generated docx report file
 */
app.get('/api/transcripts/:filename/docx', async (req, res) => {
  const filename = req.params.filename;
  
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const docxFilename = filename.replace('.jsonl', '_report.docx');
  const filePath = path.join(transcriptsDir, docxFilename);

  try {
    // 1. Try to check if it's DB-backed and generate DOCX on-demand
    const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
    if (match) {
      const [_, botType, sessionId] = match;
      const { data: session, error } = await supabase
        .from('meeting_sessions')
        .select('report_file_url')
        .eq('session_id', sessionId)
        .single();
      
      if (!error && session && session.report_file_url) {
        // Fetch report markdown from Supabase
        const reportRes = await fetch(session.report_file_url);
        if (reportRes.ok) {
          const reportMarkdown = await reportRes.text();
          // Generate DOCX buffer on-demand
          const docxBuffer = await convertMarkdownToDocx(reportMarkdown);
          
          res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
          res.setHeader('Content-Disposition', `attachment; filename="${filename.replace('.jsonl', '_report.docx')}"`);
          return res.send(docxBuffer);
        }
      }
    }

    // 2. Fallback to local markdown file if not in database
    const localReportPath = filePath.replace('_report.docx', '_report.md');
    if (!fs.existsSync(localReportPath)) {
      return res.status(404).json({ error: 'Report not yet generated' });
    }

    const reportMarkdown = fs.readFileSync(localReportPath, 'utf8');
    const docxBuffer = await convertMarkdownToDocx(reportMarkdown);

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    res.setHeader('Content-Disposition', `attachment; filename="${docxFilename}"`);
    return res.send(docxBuffer);
  } catch (err) {
    res.status(500).json({ error: `Failed to download Word Document: ${err.message}` });
  }
});

/**
 * Backend WebSocket logic: connect to Google Meet/Zoom's output port
 */
function connectToBotAudioStream(sessionId, wsPort, botType, projectId) {
  const url = `ws://localhost:${wsPort}`;
  let botSocket = null;
  let attempts = 0;
  const maxAttempts = 120; // 60 seconds total wait

  // Select the right Deepgram proxy based on bot type.
  // Google Meet uses the new SpeakerBinder (speaker_event messages as ground truth).
  // Zoom uses the old chunk-history + mapTimeToSpeaker (speaker embedded in chunks).
  const dgProxy = botType === 'zoom' ? deepgramProxyZoom : deepgramProxyGoogle;

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
      dgProxy.initializeSession(sessionId, {
        apiKey: DEEPGRAM_API_KEY,
        onTranscript: (event) => {
          // Send to UI clients
          broadcastToClients(sessionId, 'transcript', event);
          // Write to local jsonl file if final
          if (event.isFinal) {
            logStream.write(JSON.stringify(event) + '\n');
            // Push to memory service for cross-meeting search
            ingestSegment(sessionId, {
              speaker: event.speaker,
              text: event.text,
              startTs: 0,
              endTs: 0,
              isFinal: true,
              projectId,
            });
          }
        },
        onError: (err) => {
          console.error(`[Server][Deepgram][${sessionId}] Error:`, err.message);
        }
      });
    });

    botSocket.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (botType === 'zoom') {
          // ── Zoom path: speaker info is embedded in each audio chunk ──
          // Store chunk metadata (timestamps + speaker) for mapTimeToSpeaker matching.
          dgProxy.logChunkMetadata(sessionId, {
            start_ts: msg.start_ts,
            end_ts: msg.end_ts,
            speaker: msg.speaker
          });

          const audioBuffer = Buffer.from(msg.audio_base64, 'base64');
          dgProxy.sendAudio(sessionId, audioBuffer);

          // Bubble up raw audio energy levels for frontend visualization
          const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
          let sum = 0;
          for (let i = 0; i < pcmSamples.length; i++) {
            sum += pcmSamples[i] * pcmSamples[i];
          }
          const rms = Math.sqrt(sum / pcmSamples.length);
          broadcastToClients(sessionId, 'visualizer', { rms, speaker: msg.speaker });

        } else {
          // ── Google Meet path: speaker_event messages are ground truth ──
          if (msg.type === 'speaker_event') {
            dgProxy.logSpeakerBoundary(sessionId, {
              timestamp: msg.timestamp_ts,
              speaker: msg.speaker
            });
            return;
          }

          const chunk = msg;

          // Anchor the binder's timeline to the FIRST audio chunk's start_ts
          if (typeof chunk.start_ts === 'number') {
            dgProxy.logStreamStart(sessionId, chunk.start_ts);
          }

          const audioBuffer = Buffer.from(chunk.audio_base64, 'base64');
          dgProxy.sendAudio(sessionId, audioBuffer);

          // Bubble up raw audio energy levels for frontend visualization
          const pcmSamples = new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.byteLength / 2);
          let sum = 0;
          for (let i = 0; i < pcmSamples.length; i++) {
            sum += pcmSamples[i] * pcmSamples[i];
          }
          const rms = Math.sqrt(sum / pcmSamples.length);
          broadcastToClients(sessionId, 'visualizer', { rms, speaker: chunk.speaker });
        }

      } catch (err) {
        console.error(`[Server] Error parsing bot chunk for ${sessionId}:`, err.message);
      }
    });

    botSocket.on('close', () => {
      console.log(`[Server] Bot audio stream closed for session ${sessionId}`);
      dgProxy.closeSession(sessionId);
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
if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n==================================================================`);
    console.log(`Central Meeting Bot Dashboard is running at: http://localhost:${PORT}`);
    console.log(`==================================================================\n`);
  });
}

export { app, server };
