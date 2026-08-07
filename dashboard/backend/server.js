import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import fs from 'fs';
import net from 'net';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import cors from 'cors';
import { Groq } from 'groq-sdk';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

import { processManager, setOnBotStartCallback, setOnBotStopCallback } from './process-manager.js';

import { deepgramProxyGoogle } from './deepgram-proxy-google.js';
import { deepgramProxyZoom } from './deepgram-proxy-zoom.js';
import { generateFirefliesReport, calculateSpeakerStats, saveSchedulingData } from './report-generator.js';
import { supabase } from './supabase-client.js';
import { uploadReport, downloadStorageFile, getAttendeeEmailsForSession } from './supabase-helper.js';
import { convertMarkdownToDocx, saveMarkdownAsDocx } from './docx-generator.js';
import { getOAuth2Client, saveRefreshToken, loadRefreshToken, deleteRefreshToken, uploadReportToGoogleDrive } from './google-drive-helper.js';
import { sendReportEmailToAttendees } from './email-service.js';
import { liveSchedulingDetector, setSessionRoster, clearSessionRoster } from './live-scheduling.js';
import { approvalRouter } from './approval/approval-router.js';
import { calendarRouter } from './calendar/calendar-router.js';
import { startCalendarPoller } from './calendar/calendar-poller.js';
import { handleWebhookNotification } from './calendar/calendar-webhook.js';

import { ingestSegment, queryMemory, processMeeting, getProjectMemory, createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting } from './memory-client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load env file from the root directory (override: true ensures .env values take precedence over system env vars)
dotenv.config({ path: path.resolve(__dirname, '../../.env'), override: true });

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY;
console.log(`[Server] Loaded Deepgram API Key: ${DEEPGRAM_API_KEY ? 'Present (Configured)' : 'Missing'}`);

const app = express();
app.use(cors({ origin: 'http://localhost:3001', credentials: true }));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('\x1b[31m[Server] FATAL ERROR: JWT_SECRET environment variable is missing in .env!\x1b[0m');
  console.error('\x1b[31m[Server] Please set JWT_SECRET in your .env file to start the server securely.\x1b[0m');
  process.exit(1);
}

// Middleware to verify JWT token
const authMiddleware = (req, res, next) => {
  // Test environment bypass ONLY if x-test-user-id header is explicitly provided
  if (process.env.NODE_ENV === 'test' && req.headers['x-test-user-id']) {
    req.user = { id: req.headers['x-test-user-id'], email: 'test@example.com', name: 'Test User' };
    return next();
  }

  let bearerToken = null;
  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer ')) {
    bearerToken = req.headers.authorization.split(' ')[1];
  }

  let cookieToken = null;
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';').reduce((acc, c) => {
      const parts = c.trim().split('=');
      if (parts.length >= 2) {
        acc[parts[0]] = parts.slice(1).join('=');
      }
      return acc;
    }, {});
    cookieToken = cookies['token'];
  }

  // 1. Authorization: Bearer header takes primary precedence
  if (bearerToken) {
    try {
      const decoded = jwt.verify(bearerToken, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token. Please log in again.' });
    }
  }

  // 2. Cookie takes secondary precedence if Bearer header is absent
  if (cookieToken) {
    try {
      const decoded = jwt.verify(cookieToken, JWT_SECRET);
      req.user = decoded;
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
    }
  }

  // 3. Test fallback only for automated unit tests
  if (process.env.NODE_ENV === 'test') {
    const testUserId = req.headers['x-test-user-id'] || 'test-user-id';
    req.user = { id: testUserId, email: 'dev@localhost', name: 'Dev User' };
    return next();
  }

  // 4. Reject if neither token is present
  return res.status(401).json({ error: 'Authentication required. Please log in.' });
};

// Middleware to verify project ownership
const projectGuard = async (req, res, next) => {
  try {
    // 1. Resolve Project ID from various possible input locations
    let projectId = req.params.projectId || req.query.projectId || req.query.project_id || req.body.projectId || req.body.project_id;

    // 2. If no direct Project ID, try to resolve via Session ID or Filename
    const sessionId = req.params.sessionId || req.body.sessionId || req.query.sessionId || req.body.session_id || req.query.session_id;
    const filename = req.params.filename || req.body.filename || req.query.filename;

    if (!projectId && (sessionId || filename)) {
      let finalSessionId = sessionId;
      if (filename) {
        const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
        finalSessionId = match ? match[2] : filename.replace('.jsonl', '');
      }

      if (finalSessionId) {
        const { data: session } = await supabase
          .from('meeting_sessions')
          .select('project_id')
          .eq('session_id', finalSessionId)
          .single();
        if (session) {
          projectId = session.project_id;
        }
      }
    }

    if (!projectId) {
      return next();
    }

    // 3. Verify ownership of the resolved project
    const { data: project, error } = await supabase
      .from('projects')
      .select('user_id')
      .eq('id', projectId)
      .single();

    if (error || !project) {
      return res.status(404).json({ error: 'Project not found.' });
    }

    if (project.user_id && project.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied: You do not own this project.' });
    }

    req.resolvedProjectId = projectId;
    next();
  } catch (err) {
    console.error('[Server] projectGuard error:', err.message);
    res.status(500).json({ error: 'Internal server authorization error' });
  }
};

// Auth Route: User Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required fields.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format.' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);

    const { data: newUser, error: createError } = await supabase
      .from('users')
      .insert({
        name,
        email: email.toLowerCase(),
        password_hash: passwordHash
      })
      .select('id, name, email, created_at')
      .single();

    if (createError) throw createError;

    const token = jwt.sign({ id: newUser.id, email: newUser.email, name: newUser.name }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    res.status(201).json({ user: newUser, token });
  } catch (err) {
    console.error('[Server] Signup error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auth Route: User Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    const { data: user } = await supabase
      .from('users')
      .select('*')
      .eq('email', email.toLowerCase())
      .maybeSingle();

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }

    const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
    res.cookie('token', token, {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      maxAge: 24 * 60 * 60 * 1000
    });

    const userProfile = { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
    res.json({ user: userProfile, token });
  } catch (err) {
    console.error('[Server] Login error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Auth Route: User Logout
app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('token');
  res.json({ success: true, message: 'Logged out successfully.' });
});

// Auth Route: Get Profile
app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ user: req.user });
});

// Serve static frontend files
const frontendPublicPath = path.resolve(__dirname, '../frontend/public');
// Google Calendar Push Notification Webhook (Unauthenticated for Google push servers)
app.post('/api/calendar/webhook', handleWebhookNotification);

// Real-time Event Stream (Server-Sent Events) for instant backend-to-frontend notifications
const sseClients = new Map(); // userId -> Set<Response>

export function broadcastToUser(userId, eventType, data) {
  if (!userId) return;
  const userClients = sseClients.get(String(userId));
  if (!userClients || userClients.size === 0) return;
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const clientRes of userClients) {
    try {
      clientRes.write(payload);
    } catch (e) {
      userClients.delete(clientRes);
    }
  }
}

export function broadcastGlobalEvent(eventType, data) {
  const payload = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const userClients of sseClients.values()) {
    for (const clientRes of userClients) {
      try {
        clientRes.write(payload);
      } catch (e) {
        userClients.delete(clientRes);
      }
    }
  }
}

setOnBotStartCallback(async (data) => {
  console.log(`[EventStream] Emitting bot_started event for session ${data.sessionId}`);

  // Automatically connect backend to bot audio stream for Deepgram transcription
  if (data.sessionId && data.wsPort) {
    connectToBotAudioStream(data.sessionId, data.wsPort, data.botType || 'google-meet', data.projectId);
  }

  let targetUserId = null;
  if (data.projectId && supabase) {
    try {
      const { data: proj } = await supabase
        .from('projects')
        .select('user_id')
        .eq('id', data.projectId)
        .single();
      if (proj && proj.user_id) {
        targetUserId = proj.user_id;
      }
    } catch (err) {
      console.error('[EventStream] Error fetching project owner for bot_started event:', err.message);
    }
  }

  if (targetUserId) {
    console.log(`[EventStream] Broadcasting bot_started to target user ${targetUserId}`);
    broadcastToUser(targetUserId, 'bot_started', data);
  } else {
    console.log(`[EventStream] Broadcasting bot_started globally (no target user found)`);
    broadcastGlobalEvent('bot_started', data);
  }
});

setOnBotStopCallback((data) => {
  const finalReason = data.reason || 'unknown';
  console.log(`[EventStream] Emitting bot_stopped event for session ${data.sessionId} with reason: ${finalReason}`);
  broadcastGlobalEvent('bot_stopped', { sessionId: data.sessionId, reason: finalReason });
});


app.get('/api/events/subscribe', authMiddleware, (req, res) => {
  const origin = req.headers.origin || 'http://localhost:3001';
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true'
  });

  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to event stream' })}\n\n`);

  const userId = String(req.user.id);
  if (!sseClients.has(userId)) {
    sseClients.set(userId, new Set());
  }
  const userClients = sseClients.get(userId);
  userClients.add(res);

  req.on('close', () => {
    userClients.delete(res);
    if (userClients.size === 0) {
      sseClients.delete(userId);
    }
  });
});


// Endpoint to update active session's assigned project ID dynamically from frontend modal
app.post('/api/sessions/update-project', authMiddleware, async (req, res) => {
  try {
    const { sessionId, projectId } = req.body;
    if (!sessionId || !projectId) {
      return res.status(400).json({ error: 'Missing sessionId or projectId' });
    }

    // Update in-memory active session if currently running
    const active = processManager.activeSessions.get(sessionId);
    if (active) {
      active.projectId = projectId;
      console.log(`[Server] Updated in-memory active session ${sessionId} to project ${projectId}`);
    }

    // Also update the stable sessionProjectIds map for transcript routing
    sessionProjectIds.set(sessionId, projectId);

    // Update session record in Supabase database
    if (supabase) {
      await supabase
        .from('meeting_sessions')
        .update({ project_id: projectId })
        .eq('session_id', sessionId);
    }

    res.json({ success: true, sessionId, projectId });
  } catch (err) {
    console.error('[Server] Error updating session project ID:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Endpoint to fetch details of a single active or stored session
app.get('/api/sessions/:sessionId', authMiddleware, async (req, res) => {
  try {
    const { sessionId } = req.params;

    // Check in-memory active sessions first
    const active = processManager.activeSessions.get(sessionId);
    if (active) {
      return res.json({
        session: {
          sessionId,
          botType: active.type,
          status: active.status || 'capturing',
          wsPort: active.wsPort,
          meetingUrl: active.meetingUrl,
          botName: active.botName,
          projectId: active.projectId,
          googleDriveFolderId: active.googleDriveFolderId
        }
      });
    }

    // Fallback to Supabase database if session has stopped/stored
    if (supabase) {
      const { data, error } = await supabase
        .from('meeting_sessions')
        .select('*')
        .eq('session_id', sessionId)
        .single();
      if (data) {
        return res.json({
          session: {
            sessionId: data.session_id,
            botType: data.bot_type,
            status: data.status || 'stopped',
            meetingUrl: data.meeting_url,
            botName: data.bot_name,
            projectId: data.project_id
          }
        });
      }
    }

    res.status(404).json({ error: 'Session not found' });
  } catch (err) {
    console.error('[Server] Error fetching session by ID:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Google Calendar Scheduling & Management Routes
app.use('/api/calendar', authMiddleware, projectGuard, calendarRouter);
app.use('/api/approvals', approvalRouter);

// Memory Service Routes (cross-meeting query + project memory)
app.post('/api/memory/query', authMiddleware, projectGuard, async (req, res) => {
  try {
    const result = await queryMemory(req.body);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/memory/projects/:projectId', authMiddleware, projectGuard, async (req, res) => {
  try {
    const data = await getProjectMemory(req.params.projectId);
    res.json(data || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Live Meetings CRUD API endpoints
app.post('/api/meetings', authMiddleware, projectGuard, async (req, res) => {
  try {
    const meetingData = req.body;
    if (!meetingData.session_id || !meetingData.bot_type || !meetingData.meeting_url) {
      return res.status(400).json({ error: 'Missing required parameters: session_id, bot_type, meeting_url' });
    }
    const result = await createMeeting(meetingData);
    if (!result) throw new Error('Failed to create meeting session');
    res.json(result);
  } catch (err) {
    console.error('[Server] POST /api/meetings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meetings', authMiddleware, projectGuard, async (req, res) => {
  try {
    const projectId = req.query.projectId || req.query.project_id;
    const includeArchived = req.query.includeArchived !== 'false';

    // If no projectId specified, filter meetings by the user's projects
    let allowedProjectIds = [];
    if (!projectId) {
      const { data: userProjects } = await supabase
        .from('projects')
        .select('id')
        .eq('user_id', req.user.id);
      allowedProjectIds = (userProjects || []).map(p => p.id);
      if (allowedProjectIds.length === 0) {
        return res.json({ meetings: [] });
      }
    }

    const filterValidMeetings = (meetings) => {
      return (meetings || []).filter(m => {
        if (m.status === 'active' || m.status === 'starting') return true;
        if (m.status === 'empty') return false;
        return Boolean(m.transcript_file_url);
      });
    };

    const result = await listMeetings(projectId, includeArchived);
    if (result && result.meetings) {
      let filtered = result.meetings;
      if (!projectId) {
        filtered = filtered.filter(m => allowedProjectIds.includes(m.project_id));
      }
      return res.json({ meetings: filterValidMeetings(filtered) });
    }
    // Direct Supabase fallback
    let query = supabase.from('meeting_sessions').select('*').order('created_at', { ascending: false });
    if (projectId) {
      query = query.eq('project_id', projectId);
    } else {
      query = query.in('project_id', allowedProjectIds);
    }
    if (!includeArchived) query = query.neq('status', 'archived');
    const { data, error } = await query;
    if (error) throw error;
    res.json({ meetings: filterValidMeetings(data) });
  } catch (err) {
    console.error('[Server] GET /api/meetings error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meetings/:sessionId', authMiddleware, projectGuard, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const result = await getMeeting(sessionId);
    if (result && result.meeting) return res.json(result);
    const { data, error } = await supabase.from('meeting_sessions').select('*').eq('session_id', sessionId).single();
    if (error) throw error;
    res.json({ meeting: data });
  } catch (err) {
    console.error('[Server] GET /api/meetings/:sessionId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/meetings/:sessionId', authMiddleware, projectGuard, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const updateData = req.body;
    const result = await updateMeeting(sessionId, updateData);
    if (result && result.success) return res.json(result);
    
    // Direct Supabase fallback
    const { data, error } = await supabase
      .from('meeting_sessions')
      .update(updateData)
      .eq('session_id', sessionId)
      .select()
      .single();
    if (error) throw error;
    res.json({ success: true, meeting: data });
  } catch (err) {
    console.error('[Server] PUT /api/meetings/:sessionId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/meetings/:sessionId', authMiddleware, projectGuard, async (req, res) => {
  try {
    const sessionId = req.params.sessionId;

    // 1. Delete via Python memory service if available
    try {
      await deleteMeeting(sessionId);
    } catch (e) {
      console.warn(`[Server] Python memory service delete for ${sessionId} notice:`, e.message);
    }

    // 2. Cascading deletion on Supabase
    try {
      await supabase.from('transcript_segments').delete().eq('session_id', sessionId);
      await supabase.from('meeting_events').delete().eq('session_id', sessionId);
      await supabase.from('meeting_sessions').delete().eq('session_id', sessionId);
    } catch (dbErr) {
      console.warn(`[Server] Supabase delete for ${sessionId} notice:`, dbErr.message);
    }

    // 3. Clean up local transcript/report files matching sessionId
    try {
      const transcriptsDir = path.join(__dirname, 'transcripts');
      if (fs.existsSync(transcriptsDir)) {
        const files = fs.readdirSync(transcriptsDir);
        for (const file of files) {
          if (file.includes(sessionId)) {
            fs.unlinkSync(path.join(transcriptsDir, file));
            console.log(`[Server] Deleted local file: ${file}`);
          }
        }
      }
    } catch (fsErr) {
      console.warn(`[Server] Local file cleanup for ${sessionId} notice:`, fsErr.message);
    }

    res.json({ success: true, session_id: sessionId });
  } catch (err) {
    console.error('[Server] DELETE /api/meetings/:sessionId error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/transcripts/:filename', authMiddleware, projectGuard, async (req, res) => {
  const filename = req.params.filename;
  const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  const sessionId = match ? match[2] : filename.replace('.jsonl', '');
  
  try {
    try { await deleteMeeting(sessionId); } catch (e) {}
    try {
      await supabase.from('transcript_segments').delete().eq('session_id', sessionId);
      await supabase.from('meeting_events').delete().eq('session_id', sessionId);
      await supabase.from('meeting_sessions').delete().eq('session_id', sessionId);
    } catch (e) {}

    const transcriptsDir = path.join(__dirname, 'transcripts');
    if (fs.existsSync(transcriptsDir)) {
      const files = fs.readdirSync(transcriptsDir);
      for (const file of files) {
        if (file.includes(sessionId) || file === filename) {
          try { fs.unlinkSync(path.join(transcriptsDir, file)); } catch (e) {}
        }
      }
    }
    res.json({ success: true, filename, sessionId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET list of all projects
app.get('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('user_id', req.user.id);
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[Server] GET /api/projects error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST create a new project
app.post('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { name, description } = req.body;
    const { data, error } = await supabase
      .from('projects')
      .insert({ name, description, user_id: req.user.id })
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

// Google Drive Disconnect — clears the saved refresh token
app.post('/api/auth/google/disconnect', (req, res) => {
  try {
    deleteRefreshToken();
    res.json({ success: true, message: 'Google Drive disconnected successfully.' });
  } catch (err) {
    res.status(500).json({ error: `Failed to disconnect Google Drive: ${err.message}` });
  }
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

// Map of sessionId -> Array<{ speaker: string, text: string, timestamp: string }> for live Q&A context
const sessionTranscripts = new Map();

// Helper to broadcast messages to all UI clients of a session
function broadcastToClients(sessionId, type, data) {
  // Accumulate FINAL transcript segments in server-side buffer for live Q&A context
  if (type === 'transcript' && data && data.isFinal === true && data.text) {
    if (!sessionTranscripts.has(sessionId)) {
      sessionTranscripts.set(sessionId, []);
    }
    sessionTranscripts.get(sessionId).push({
      speaker: data.speaker || 'Unknown',
      text: data.text.trim(),
      timestamp: data.timestamp || new Date().toISOString()
    });
  }

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
app.post('/api/sessions/start', authMiddleware, projectGuard, async (req, res) => {
  let { botType, meetingUrl, botName, isHeadless, googleDriveFolderId, projectId, attendeeEmails } = req.body;

  if (!botType || !meetingUrl) {
    return res.status(400).json({ error: 'Missing required parameters: botType and meetingUrl' });
  }

  // Validate attendeeEmails format if provided
  let sanitizedAttendeeEmails = [];
  if (attendeeEmails !== undefined && attendeeEmails !== null) {
    if (!Array.isArray(attendeeEmails)) {
      return res.status(400).json({ error: 'attendeeEmails must be an array of email strings' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    for (const email of attendeeEmails) {
      if (typeof email !== 'string' || !emailRegex.test(email.trim())) {
        return res.status(400).json({ error: `Invalid email address format: "${email}"` });
      }
    }
    // Deduplicate and trim
    sanitizedAttendeeEmails = [...new Set(attendeeEmails.map(e => e.trim().toLowerCase()))];
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
      projectId,
      attendeeEmails: sanitizedAttendeeEmails
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
        // Feed the live scheduling-intent detector.
        liveSchedulingDetector.ingest(sessionId, transcriptEvent);
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
app.post('/api/sessions/stop', authMiddleware, async (req, res) => {
  const { sessionId, projectId, reason } = req.body;

  if (!sessionId) {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  const finalReason = reason || 'dashboard_leave';

  try {
    // Persist projectId and exit_reason to active session and Supabase before killing the bot
    if (projectId) {
      const active = processManager.activeSessions.get(sessionId);
      if (active) {
        active.projectId = projectId;
      }
      if (supabase) {
        await supabase
          .from('meeting_sessions')
          .update({ project_id: projectId, exit_reason: finalReason })
          .eq('session_id', sessionId);
      }
    }

    deepgramProxyGoogle.closeSession(sessionId);
    deepgramProxyZoom.closeSession(sessionId);
    await processManager.killBot(sessionId);
    sessionTranscripts.delete(sessionId);
    clearSessionRoster(sessionId);
    liveSchedulingDetector.clear(sessionId);
    // Trigger post-meeting extraction (fire-and-forget)
    processMeeting(sessionId);
    res.json({ success: true, sessionId, reason: finalReason });
  } catch (err) {
    res.status(500).json({ error: `Failed to stop bot session: ${err.message}` });
  }
});

/**
 * REST API: List active sessions
 */
app.get('/api/sessions', authMiddleware, async (req, res) => {
  try {
    const list = [];
    for (const [id, session] of processManager.activeSessions.entries()) {
      // Check project access if the session is linked to a project
      if (session.projectId) {
        const { data: project } = await supabase
          .from('projects')
          .select('user_id')
          .eq('id', session.projectId)
          .single();
        const canAccess = !project || !project.user_id || project.user_id === req.user.id;
        if (!canAccess) continue;
      }
      list.push({
        sessionId: id,
        type: session.type,
        status: session.status,
        wsPort: session.wsPort,
        projectId: session.projectId
      });
    }

    res.json({ sessions: list });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Helper to self-heal stale database session statuses left over from prior server runs or crashes
 */
export async function cleanupStaleSessions() {
  if (!supabase) return;
  try {
    const activeIds = Array.from(processManager.activeSessions.keys());
    const { data: staleSessions } = await supabase
      .from('meeting_sessions')
      .select('session_id')
      .in('status', ['capturing', 'starting', 'joining', 'active', 'in_progress']);

    if (staleSessions && staleSessions.length > 0) {
      const staleIds = staleSessions
        .map(s => s.session_id)
        .filter(id => !activeIds.includes(id));

      if (staleIds.length > 0) {
        await supabase
          .from('meeting_sessions')
          .update({ status: 'completed' })
          .in('session_id', staleIds);
        console.log(`[Server] Self-healed ${staleIds.length} stale session statuses to 'completed'.`);
      }
    }
  } catch (err) {
    console.error('[Server] Error cleaning up stale sessions:', err.message);
  }
}

/**
 * REST API: Get saved transcripts
 */
app.get('/api/transcripts', authMiddleware, async (req, res) => {
  try {
    await cleanupStaleSessions();
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

    if (projectIds.length > 0) {
      // Direct project lookup — supports legacy projects with user_id: null
      for (const pid of projectIds) {
        const { data: project } = await supabase
          .from('projects')
          .select('user_id')
          .eq('id', pid)
          .single();
        if (!project) {
          return res.status(404).json({ error: `Project ${pid} not found` });
        }
        if (project.user_id && project.user_id !== req.user.id) {
          return res.status(403).json({ error: 'Access denied: You do not own this project.' });
        }
      }
      dbQuery = dbQuery.in('project_id', projectIds);
    } else {
      // No projectId filter — fall back to user's owned projects
      const { data: userProjects } = await supabase
        .from('projects')
        .select('id')
        .eq('user_id', req.user.id);
      const allowedProjectIds = (userProjects || []).map(p => p.id);
      if (allowedProjectIds.length === 0) {
        return res.json({ transcripts: [] });
      }
      dbQuery = dbQuery.in('project_id', allowedProjectIds);
    }

    const { data: dbSessions, error } = await dbQuery;
    if (error) throw error;

    // Keep all valid meeting sessions for the project except deleted ones
    // and filter out completed sessions with no transcript file (empty/no-speech meetings)
    const validDbSessions = (dbSessions || []).filter(s => {
      if (s.status === 'deleted') return false;
      if (s.status === 'active' || s.status === 'starting' || s.status === 'capturing') return true;
      if (s.status === 'empty') return false;
      if (s.status === 'completed' && !s.transcript_file_url) return false;
      return true;
    });


    // Convert validDbSessions to the format expected by the frontend
    const list = validDbSessions.map(s => ({
      fileName: `${s.bot_type}_${s.session_id}.jsonl`,
      sessionId: s.session_id,
      title: s.title || s.bot_name || 'Meeting Session',
      botName: s.bot_name,
      created: s.created_at,
      size: 0, // DB-backed files sizes are fetched from storage metadata if needed
      isDbBacked: true,
      botType: s.bot_type,
      status: s.status === 'empty' ? 'completed' : s.status,
      transcriptFileUrl: s.transcript_file_url,
      reportFileUrl: s.report_file_url
    }));

    // 2. Add local files that are not in the database (only when no specific projectId filter is requested)
    if (projectIds.length === 0) {
      const transcriptsDir = path.join(__dirname, 'transcripts');
      const dbSessionIds = new Set(validDbSessions.map(s => s.session_id));
      let localFiles = [];
      try {
        if (fs.existsSync(transcriptsDir)) {
          localFiles = fs.readdirSync(transcriptsDir).filter(f => f.endsWith('.jsonl'));
        }
      } catch (e) {}

      for (const f of localFiles) {
        const match = f.match(/^(teams|meet|zoom)_(.+)\.jsonl$/);
        if (match) {
          const [_, type, sessionId] = match;
          if (!dbSessionIds.has(sessionId)) {
            try {
              const stats = fs.statSync(path.join(transcriptsDir, f));
              if (stats.size > 0) {
                list.push({
                  fileName: f,
                  sessionId: sessionId,
                  created: stats.birthtime,
                  size: stats.size,
                  isDbBacked: false,
                  botType: type,
                  status: 'completed'
                });
              }
            } catch (e) {
              // Ignore missing file stats
            }
          }
        }
      }
    }

    // Sort final combined list by created date descending
    list.sort((a, b) => new Date(b.created) - new Date(a.created));

    res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({ transcripts: list });
  } catch (err) {
    console.error('[Server] Supabase transcripts fetch failed:', err.message);
    res.status(500).json({ error: `Failed to fetch transcripts: ${err.message}` });
  }
});

/**
 * REST API: Read individual transcript file
 */
app.get('/api/transcripts/:filename', authMiddleware, projectGuard, async (req, res) => {
  const filename = req.params.filename;
  
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid or unauthorized file name' });
  }

  const transcriptsDir = path.join(__dirname, 'transcripts');
  const filePath = path.join(transcriptsDir, filename);

  const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  const sessionId = match ? match[2] : filename.replace('.jsonl', '');

  const normalizeLines = (rawLines) => {
    return rawLines.map(l => ({
      speaker: l.speaker || l.speaker_label || l.name || 'Speaker',
      text: l.text || l.content || l.transcript || '',
      timestamp: l.timestamp || (l.start_ts !== undefined ? `${l.start_ts}s` : undefined)
    })).filter(l => l.text.trim().length > 0 || l.speaker !== 'Speaker');
  };

  try {
    // 1. Try to fetch from Supabase storage URL
    if (match) {
      try {
        const { data: session, error } = await supabase
          .from('meeting_sessions')
          .select('transcript_file_url')
          .eq('session_id', sessionId)
          .single();
        
        if (!error && session && session.transcript_file_url) {
          const fetchRes = await fetch(session.transcript_file_url);
          if (fetchRes.ok) {
            const content = await fetchRes.text();
            const raw = content.split('\n').filter(l => l.trim().length > 0).map(l => {
              try { return JSON.parse(l); } catch { return null; }
            }).filter(Boolean);
            return res.json({ lines: normalizeLines(raw) });
          }
        }
      } catch (dbErr) {
        console.warn(`[Server] Supabase transcript storage fetch failed for ${filename}:`, dbErr.message);
      }
    }

    // 2. Fallback to local filesystem if file exists
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      const raw = content.split('\n').filter(l => l.trim().length > 0).map(l => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
      return res.json({ lines: normalizeLines(raw) });
    }

    // 3. Fallback to querying transcript_segments table directly from Supabase
    try {
      const { data: dbSegments, error: segErr } = await supabase
        .from('transcript_segments')
        .select('speaker_label, text, start_ts')
        .eq('session_id', sessionId)
        .order('created_at', { ascending: true });

      if (!segErr && dbSegments && dbSegments.length > 0) {
        const lines = dbSegments.map(s => ({
          speaker: s.speaker_label || 'Speaker',
          text: s.text,
          timestamp: s.start_ts !== undefined ? `${s.start_ts}s` : undefined
        }));
        return res.json({ lines });
      }
    } catch (segFetchErr) {
      console.warn(`[Server] DB transcript_segments query failed for ${sessionId}:`, segFetchErr.message);
    }

    // 4. Return empty lines gracefully if session exists but transcript has no content yet
    return res.json({ lines: [] });
  } catch (err) {
    res.status(500).json({ error: `Failed to read transcript: ${err.message}` });
  }
});

/**
 * REST API: Generate post-meeting report
 */
app.post('/api/transcripts/:filename/generate-report', authMiddleware, projectGuard, async (req, res) => {
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
      const reportMarkdown = await downloadStorageFile(dbSession.report_file_url);
      if (reportMarkdown) {
        let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
        const schedUrl = dbSession.report_file_url.replace('/report.md', '/scheduling.json');
        try {
          const schedText = await downloadStorageFile(schedUrl);
          if (schedText) schedulingData = JSON.parse(schedText);
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
        dbSession = session;

        // If report markdown is stored in Supabase Storage, fetch and return it directly
        if (session.report_file_url) {
          console.log(`[Server] Fetching report from Supabase storage for ${supaSessionId}...`);
          try {
            const reportMarkdown = await downloadStorageFile(session.report_file_url);
            if (reportMarkdown) {
              fs.writeFileSync(reportPath, reportMarkdown, 'utf8');

              let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
              const schedUrl = session.report_file_url.replace('/report.md', '/scheduling.json');
              try {
                const schedText = await downloadStorageFile(schedUrl);
                schedulingData = JSON.parse(schedText);
                fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
              } catch (e) {
                if (fs.existsSync(schedulingPath)) {
                  schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
                } else if (fs.existsSync(legacySchedulingPath)) {
                  try {
                    schedulingData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
                    fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
                    fs.unlinkSync(legacySchedulingPath);
                    console.log(`[Server] Migrated legacy scheduling file in generate-report fallback: ${schedulingFilename}`);
                  } catch (migErr) {
                    console.error('[Server] Failed to migrate legacy scheduling file in fallback check:', migErr.message);
                  }
                }
              }

              return res.json({
                success: true,
                cached: true,
                report: reportMarkdown,
                scheduling: schedulingData
              });
            }
          } catch (fetchErr) {
            console.warn(`[Server] Failed to download report from Supabase storage for ${supaSessionId}:`, fetchErr.message);
          }
        }

        // If report is not in storage, but transcript file is in storage and not on local disk, download transcript
        if (!fs.existsSync(filePath) && session.transcript_file_url) {
          console.log(`[Server] Local transcript missing, downloading from Supabase storage for ${supaSessionId}...`);
          try {
            const transcriptContent = await downloadStorageFile(session.transcript_file_url);
            if (transcriptContent) {
              fs.writeFileSync(filePath, transcriptContent, 'utf8');
              console.log(`[Server] Successfully downloaded transcript to ${filePath}`);
            }
          } catch (tErr) {
            console.warn(`[Server] Failed to download transcript from Supabase storage:`, tErr.message);
          }
        }
      }
    } catch (supaErr) {
      console.warn(`[Server] Supabase storage check failed for ${filename}:`, supaErr.message);
    }
  }

  // 2. LOCAL REPORT CACHING CHECK (Fallback if not found in Supabase):
  if (fs.existsSync(reportPath)) {
    console.log(`[Server] Report already exists locally for ${filename}. Loading cached files.`);
    const reportMarkdown = fs.readFileSync(reportPath, 'utf8');
    let schedulingData = { scheduling_detected: false, scheduling: null, status: 'none' };
    if (fs.existsSync(schedulingPath)) {
      try {
        schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
      } catch (e) {}
    }
    return res.json({
      success: true,
      cached: true,
      report: reportMarkdown,
      scheduling: schedulingData
    });
  }

  // 3. TRANSCRIPT CHECK:
  if (!fs.existsSync(filePath)) {
    return res.status(400).json({ error: 'Meeting is empty or no speech was recorded. AI summary report cannot be generated.' });
  }

  const transcriptStats = fs.statSync(filePath);
  if (transcriptStats.size === 0) {
    return res.status(400).json({ error: 'Meeting is empty or no speech was recorded. AI summary report cannot be generated.' });
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

    // Parse filename to update Supabase row and upload report
    const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
    if (match) {
      const [_, botType, sessionId] = match;
      console.log(`[Server] Uploading report to Supabase for session: ${sessionId}`);
      await uploadReport(sessionId, botType);
    }
    // Update Supabase row and upload report
    if (sessionId) {
      // Parse filename to update Supabase row and upload report
      const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
      if (match) {
        const [_, botType, targetSessionId] = match;
        console.log(`[Server] Uploading report to Supabase for session: ${targetSessionId}`);
        const publicUrl = await uploadReport(targetSessionId, botType);

        // Send report emails if attendees are registered
        try {
          const emails = await getAttendeeEmailsForSession(targetSessionId);
          if (emails && emails.length > 0) {
            console.log(`[Server] Triggering bulk email report distribution for session ${targetSessionId}...`);
            await sendReportEmailToAttendees({
              sessionId: targetSessionId,
              reportMarkdown: markdown,
              reportUrl: publicUrl,
              attendeeEmails: emails,
              localReportPath: reportPath
            });
          }
        } catch (emailErr) {
          console.error(`[Server] Failed to send report emails for session ${targetSessionId}:`, emailErr.message);
        }
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
app.get('/api/transcripts/:filename/report', authMiddleware, projectGuard, async (req, res) => {
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
          try {
            const reportMarkdown = await downloadStorageFile(session.report_file_url);
            
            // Fetch scheduling companion from Supabase Storage (replace report.md with scheduling.json)
            const schedUrl = session.report_file_url.replace('/report.md', '/scheduling.json');
            try {
              const schedText = await downloadStorageFile(schedUrl);
              schedulingData = JSON.parse(schedText);
            } catch (schedErr) {
              console.warn(`[Server] Failed to fetch scheduling companion from Supabase:`, schedErr.message);
            }

            // Get transcript contents to calculate statistics
            let lines = [];
            if (session.transcript_file_url) {
              try {
                const transText = await downloadStorageFile(session.transcript_file_url);
                lines = transText.split('\n').filter(l => l.trim().length > 0).map(JSON.parse);
              } catch (tErr) {}
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
          } catch (fetchErr) {
            console.warn(`[Server] Supabase report download failed for ${filename}:`, fetchErr.message);
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
app.get('/api/transcripts/:filename/docx', authMiddleware, projectGuard, async (req, res) => {
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

const connectedAudioSessions = new Set();
// Stable projectId per session, survives activeSessions cleanup so final transcript segments go to the right project
const sessionProjectIds = new Map();

/**
 * Backend WebSocket logic: connect to Google Meet/Zoom's output port
 */
function connectToBotAudioStream(sessionId, wsPort, botType, projectId) {
  if (!sessionId || !wsPort) return;
  if (connectedAudioSessions.has(sessionId)) {
    console.log(`[Server] Already connected to audio stream for session ${sessionId}`);
    return;
  }
  connectedAudioSessions.add(sessionId);

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
    let logStream = null;

    botSocket.on('open', () => {
      console.log(`[Server] Connected to bot audio stream for session ${sessionId}`);
      broadcastToClients(sessionId, 'status', { status: 'capturing' });

      // Create transcript log file for Meet/Zoom
      const transcriptsDir = path.join(__dirname, 'transcripts');
      const actualBotType = processManager.getSession(sessionId)?.type || botType || 'session';
      const logPath = path.join(transcriptsDir, `${actualBotType}_${sessionId}.jsonl`);
      logStream = fs.createWriteStream(logPath, { flags: 'a' });

      // Set stable projectId for transcript routing
      sessionProjectIds.set(sessionId, projectId);

      // Initialize Deepgram Proxy connection
      dgProxy.initializeSession(sessionId, {
        apiKey: DEEPGRAM_API_KEY,
        onTranscript: (event) => {
          // Send to UI clients
          broadcastToClients(sessionId, 'transcript', event);
          // Write to local jsonl file if final
          if (event.isFinal) {
            logStream.write(JSON.stringify(event) + '\n');
          }
          // Push to memory service for cross-meeting search (Supabase)
          if (event.isFinal) {
            // Use stable sessionProjectIds map — survives activeSessions cleanup on bot exit
            const currentProjectId = sessionProjectIds.get(sessionId) || projectId;
            ingestSegment(sessionId, {
              speaker: event.speaker,
              text: event.text,
              startTs: 0,
              endTs: 0,
              isFinal: true,
              projectId: currentProjectId,
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

          if (msg.type === 'roster') {
            // Live participant roster (bot excluded) — populate approval dropdown.
            if (Array.isArray(msg.names)) {
              setSessionRoster(sessionId, msg.names);
            }
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
      try { logStream.end(); } catch (e) {}
      // Delay cleanup so inflight transcript segments can still resolve
      setTimeout(() => sessionProjectIds.delete(sessionId), 5000);
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

  // Replay existing transcript history to late-connecting UI client
  const pastLines = sessionTranscripts.get(sessionId) || [];
  for (const line of pastLines) {
    ws.send(JSON.stringify({
      type: 'transcript',
      data: {
        speaker: line.speaker || 'Unknown',
        text: line.text || '',
        isFinal: true,
        timestamp: line.timestamp || new Date().toISOString()
      }
    }));
  }

  ws.on('message', async (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'qa_question' && msg.data) {
        await handleLiveQAQuestion(sessionId, ws, msg.data);
      }
    } catch (err) {
      console.error(`[Server][WS] Error handling message for ${sessionId}:`, err.message);
    }
  });

  ws.on('close', () => {
    console.log(`[Server] UI Client disconnected from session ${sessionId}`);
    const sockets = clientSockets.get(sessionId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size === 0) {
        clientSockets.delete(sessionId);
        if (!processManager.activeSessions.has(sessionId)) {
          sessionTranscripts.delete(sessionId);
        }
      }
    }
  });
});

/**
 * Handle incoming live Q&A questions from UI WebSocket clients.
 * Streams answers token-by-token using Groq LLM (llama-3.3-70b-versatile).
 */
async function handleLiveQAQuestion(sessionId, ws, data) {
  const questionId = data.id || `qa_${Date.now()}`;
  const questionText = (data.question || '').trim();

  if (!questionText) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'qa_error',
        data: { id: questionId, error: 'Question text cannot be empty.' }
      }));
    }
    return;
  }

  // 1. Context Precedence:
  // Primary: sessionTranscripts.get(sessionId)
  // Fallback: data.contextOverride (client-sent liveLines text) only if server buffer is empty/missing
  let formattedContext = '';
  const serverBuffer = sessionTranscripts.get(sessionId);

  if (serverBuffer && serverBuffer.length > 0) {
    formattedContext = serverBuffer
      .map((item, idx) => {
        const lineId = item.lineId || `L${idx}`;
        const ts = item.timestamp || 'Live';
        return `[${lineId} | ${ts} | ${item.speaker}]: ${item.text}`;
      })
      .join('\n');
  } else if (data.contextOverride && typeof data.contextOverride === 'string') {
    formattedContext = data.contextOverride.trim();
  }

  // Graceful response if transcript context is empty
  if (!formattedContext || !formattedContext.trim()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'qa_answer_complete',
        data: {
          id: questionId,
          fullAnswer: "That hasn't come up in the meeting yet (no transcript lines recorded so far).",
          citations: [],
          isFinal: true
        }
      }));
    }
    return;
  }

  // 2. Truncate context to most recent ~15,000 words if transcript is very long
  const words = formattedContext.split(/\s+/);
  if (words.length > 15000) {
    formattedContext = '...[earlier transcript omitted]\n' + words.slice(-15000).join(' ');
  }

  // 3. Verify Groq API Key
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    console.error(`[Server][LiveQA] GROQ_API_KEY missing from .env`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'qa_error',
        data: { id: questionId, error: 'GROQ_API_KEY is not configured in .env' }
      }));
    }
    return;
  }

  // 4. Construct System Prompt & Call Groq LLM with streaming
  const systemPrompt = `You are a helpful AI Meeting Assistant answering questions during a live meeting.
Answer the user's question accurately and concisely using ONLY the provided meeting transcript context.

CRITICAL INSTRUCTIONS:
- You must answer ONLY based on what is explicitly stated in the transcript.
- If the question cannot be answered using the transcript context (or the topic has not been discussed), explicitly state: "That hasn't come up in the meeting yet."
- Do not make up facts, hallucinate, or reason beyond what was actually spoken in the meeting transcript.
- At the VERY END of your output, after your answer text, output a sentinel line "---CITATIONS---" followed on the next line by a JSON array of citations for the transcript line(s) that directly grounded your answer.
- Each citation object MUST have:
  - "lineId": the line tag string (e.g. "L0", "L1")
  - "speaker": the speaker's name
  - "timestamp": the timestamp string
- ONLY include citations when the answer is genuinely grounded in specific transcript lines. If the answer is "That hasn't come up in the meeting yet." or no lines apply, output an empty JSON array [] after ---CITATIONS---. Do NOT cite arbitrary lines.

EXAMPLE OUTPUT:
The team agreed to discuss the architecture on Friday.
---CITATIONS---
[{"lineId": "L1", "speaker": "Ishita Bhojani", "timestamp": "14:02:15"}]`;

  const userPrompt = `Live Meeting Transcript Context:\n${formattedContext}\n\nUser Question: ${questionText}`;

  try {
    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      model: 'llama-3.3-70b-versatile',
      temperature: 0.3,
      max_tokens: 1024,
      stream: true
    });

    let rawFullOutput = '';
    let hasHitSentinel = false;

    for await (const chunk of completion) {
      // Abort stream loop immediately if socket was closed mid-stream
      if (ws.readyState !== WebSocket.OPEN) {
        console.log(`[Server][LiveQA] Socket closed mid-stream for session ${sessionId}, aborting LLM stream.`);
        return;
      }

      const token = chunk.choices[0]?.delta?.content || '';
      if (token) {
        rawFullOutput += token;

        // Check if sentinel marker has been encountered
        if (!hasHitSentinel && rawFullOutput.includes('---CITATIONS---')) {
          hasHitSentinel = true;
        }

        // Only stream token chunks to client if we haven't reached the sentinel block
        if (!hasHitSentinel) {
          ws.send(JSON.stringify({
            type: 'qa_answer_chunk',
            data: { id: questionId, chunk: token, isFinal: false }
          }));
        }
      }
    }

    // Split answer text and citations sentinel block safely
    let answerText = rawFullOutput;
    let citationsJsonStr = '[]';

    if (rawFullOutput.includes('---CITATIONS---')) {
      const parts = rawFullOutput.split('---CITATIONS---');
      answerText = (parts[0] || '').trim();
      citationsJsonStr = (parts[1] || '').trim();
    } else {
      answerText = rawFullOutput.trim();
    }

    // Parse citation JSON block safely
    let citations = [];
    try {
      if (citationsJsonStr) {
        const cleanJsonStr = citationsJsonStr.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        const parsed = JSON.parse(cleanJsonStr);
        if (Array.isArray(parsed)) {
          citations = parsed
            .filter(c => c && typeof c === 'object' && c.lineId)
            .map(c => ({
              lineId: String(c.lineId || '').trim(),
              speaker: String(c.speaker || 'Speaker').trim(),
              timestamp: String(c.timestamp || 'Live').trim()
            }));
        }
      }
    } catch (parseErr) {
      console.warn(`[Server][LiveQA] Citation JSON parse error: ${parseErr.message}, falling back to empty citations.`);
      citations = [];
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'qa_answer_complete',
        data: {
          id: questionId,
          fullAnswer: answerText || "That hasn't come up in the meeting yet.",
          citations: citations,
          isFinal: true
        }
      }));
    }
  } catch (err) {
    console.error(`[Server][LiveQA] Groq API error for session ${sessionId}:`, err.message);
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'qa_error',
        data: { id: questionId, error: err.message || 'Failed to generate AI answer.' }
      }));
    }
  }
}

// Port configuration
if (process.env.NODE_ENV !== 'test') {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`\n==================================================================`);
    console.log(`Central Meeting Bot Dashboard is running at: http://localhost:${PORT}`);
    console.log(`==================================================================\n`);
    startCalendarPoller();
    cleanupStaleSessions().catch(() => {});
  });

}

export { app, server };
