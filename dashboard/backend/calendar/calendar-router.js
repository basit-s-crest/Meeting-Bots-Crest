import express from 'express';
import fs from 'fs';
import path from 'path';
import {
  getOAuth2Client,
  saveRefreshToken,
  loadRefreshToken,
  parseInstruction,
  createCalendarEvent,
  handleGoogleApiError,
  getDefaultDurationMinutes,
  listUpcomingEvents,
  extractMeetingDetails
} from './calendar-service.js';

import { supabase } from '../supabase-client.js';
import { autoJoinScheduler } from './auto-join-scheduler.js';

/**
 * Downloads the scheduling companion JSON from Supabase Storage to local transcripts folder on demand.
 */
async function downloadSchedulingFromSupabase(filename, schedulingPath) {
  const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  if (!match) return false;
  
  const [_, botType, sessionId] = match;
  try {
    const { data: session, error } = await supabase
      .from('meeting_sessions')
      .select('report_file_url')
      .eq('session_id', sessionId)
      .single();
    
    if (error || !session || !session.report_file_url) {
      return false;
    }
    
    const schedUrl = session.report_file_url.replace('/report.md', '/scheduling.json');
    const schedRes = await fetch(schedUrl);
    if (schedRes.ok) {
      const schedulingData = await schedRes.json();
      fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
      console.log(`[Calendar Router] Successfully downloaded scheduling companion from Supabase: ${path.basename(schedulingPath)}`);
      return true;
    }
  } catch (err) {
    console.warn(`[Calendar Router] Failed to download scheduling companion fallback from Supabase:`, err.message);
  }
  return false;
}

/**
 * Uploads the updated scheduling companion JSON file to Supabase Storage.
 */
async function uploadSchedulingToSupabase(filename, schedulingPath) {
  const match = filename.match(/^(teams|meet|google-meet|zoom)_(.+)\.jsonl$/);
  if (!match) return;
  
  const [_, botType, sessionId] = match;
  try {
    const fileBuffer = fs.readFileSync(schedulingPath);
    const storagePath = `sessions/${sessionId}/scheduling.json`;
    const { error } = await supabase.storage
      .from('transcripts')
      .upload(storagePath, fileBuffer, {
        contentType: 'application/json',
        upsert: true
      });
    if (error) throw error;
    console.log(`[Calendar Router] Successfully uploaded scheduling companion to Supabase Storage: ${storagePath}`);
  } catch (err) {
    console.error(`[Calendar Router] Failed to upload scheduling companion to Supabase:`, err.message);
  }
}

export const calendarRouter = express.Router();

/**
 * Route: Initiates Google Calendar OAuth setup.
 * Redirects the user to the Google OAuth consent screen.
 */
calendarRouter.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI;

  if (!clientId || !clientSecret || !redirectUri) {
    return res.status(500).send('Google Calendar API credentials are not configured in the .env file.');
  }
  
  try {
    const oauth2Client = getOAuth2Client();
    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar.events']
    });
    res.redirect(authUrl);
  } catch (err) {
    console.error('[Calendar Router] Failed to generate auth URL:', err.message);
    res.status(500).send('Google authentication initiation failed.');
  }
});

/**
 * Route: Google Calendar OAuth callback handler.
 * Exchanges the code for tokens, writes refresh token to google_calendar_refresh_token.json, and updates process.env.
 */
calendarRouter.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) {
    return res.status(400).send('Missing authorization code in query.');
  }
  
  try {
    const oauth2Client = getOAuth2Client();
    const { tokens } = await oauth2Client.getToken(code);
    
    if (tokens.refresh_token) {
      saveRefreshToken(tokens.refresh_token);
      res.send('Successfully authenticated! The refresh token has been saved to google_calendar_refresh_token.json and loaded in memory. You can close this window now.');
    } else {
      console.warn('[Calendar Router Auth] Warning: No refresh token returned in callback.');
      res.send('Authentication completed, but no refresh token was returned. If this is a re-authentication, you must revoke the app permission in your Google account settings first to force a new refresh token.');
    }
  } catch (err) {
    console.error('[Calendar Router] OAuth callback exchange failed:', err.message);
    res.status(500).send(`Google authentication failed during code exchange: ${err.message}`);
  }
});

/**
 * Route: Checks OAuth config and connection status.
 */
calendarRouter.get('/auth/status', (req, res) => {
  const hasToken = !!loadRefreshToken();
  const isConfigured = !!(
    (process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID) &&
    (process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET) &&
    (process.env.GOOGLE_CALENDAR_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI)
  );
  res.json({
    connected: hasToken && isConfigured,
    configured: isConfigured,
    hasRefreshToken: hasToken
  });
});

/**
 * Route: Natural language scheduling.
 * Parses sentence to extract title and date/time, then inserts event.
 */
calendarRouter.post('/schedule', async (req, res) => {
  const { instruction } = req.body;
  
  if (!instruction || typeof instruction !== 'string' || !instruction.trim()) {
    console.log('[Calendar Router] Schedule attempt failed: Missing or empty instruction');
    return res.status(400).json({ error: 'Missing or invalid parameter: instruction' });
  }
  
  let parsedInfo;
  try {
    parsedInfo = parseInstruction(instruction);
  } catch (err) {
    console.log(`[Calendar Router] Schedule attempt failed (parse error): "${instruction}" -> ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
  
  const { title, startIsoStr, endIsoStr, tz, matchText } = parsedInfo;
  
  try {
    const event = await createCalendarEvent(title, startIsoStr, endIsoStr, tz);
    
    console.log(`[Calendar Router] Schedule SUCCESS:
  - Raw instruction: "${instruction}"
  - Matched expression: "${matchText}"
  - Extracted title: "${title}"
  - Parsed start (ISO): ${startIsoStr} (Timezone: ${tz})
  - Created Event ID: ${event.id}`);
    
    return res.json({
      success: true,
      id: event.id,
      htmlLink: event.htmlLink,
      title,
      start: startIsoStr,
      end: endIsoStr,
      timezone: tz
    });
  } catch (err) {
    const normErr = handleGoogleApiError(err);
    console.log(`[Calendar Router] Schedule FAILURE:
  - Raw instruction: "${instruction}"
  - Matched expression: "${matchText}"
  - Extracted title: "${title}"
  - Error: ${normErr.error}`);
    
    return res.status(normErr.status).json({ error: normErr.error });
  }
});

/**
 * Route: Confirms a scheduling suggestion extracted from a meeting report.
 * Idempotency check: if status is already "confirmed", returns the existing event details immediately.
 * Fail-safe state: only writes status: "confirmed" on successful calendar event creation.
 */
calendarRouter.post('/confirm-report-schedule', async (req, res) => {
  const { filename, title, date, time, zoomLink } = req.body;
  
  if (!filename || !title || !date || !time) {
    return res.status(400).json({ error: 'Missing required parameters: filename, title, date, time' });
  }
  
  // Sanitize filename to prevent directory traversal
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  
  const transcriptsDir = path.join(process.cwd(), 'transcripts');
  const schedulingFilename = filename.replace('.jsonl', '_report_scheduling.json');
  const schedulingPath = path.join(transcriptsDir, schedulingFilename);
  const legacyFilename = filename.replace('.jsonl', '_scheduling.json');
  const legacySchedulingPath = path.join(transcriptsDir, legacyFilename);
  
  // Load existing companion file (with legacy migration fallback)
  if (!fs.existsSync(schedulingPath)) {
    if (fs.existsSync(legacySchedulingPath)) {
      try {
        const legacyData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
        fs.writeFileSync(schedulingPath, JSON.stringify(legacyData, null, 2), 'utf8');
        fs.unlinkSync(legacySchedulingPath);
        console.log(`[Calendar Router] Migrated legacy scheduling file on confirm: ${schedulingFilename}`);
      } catch (err) {
        console.error('[Calendar Router] Failed to migrate legacy file on confirm:', err.message);
      }
    } else {
      // Try to download from Supabase Storage
      await downloadSchedulingFromSupabase(filename, schedulingPath);
    }
  }
  
  if (!fs.existsSync(schedulingPath)) {
    return res.status(404).json({ error: 'Scheduling suggestion metadata not found' });
  }
  
  let schedulingData;
  try {
    schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
  } catch (err) {
    return res.status(500).json({ error: `Failed to load scheduling metadata: ${err.message}` });
  }
  
  // Idempotency check
  if (schedulingData.status === 'confirmed') {
    console.log(`[Calendar Router] Suggestion for ${filename} already confirmed (idempotency guard). Returning cached event.`);
    return res.json({
      success: true,
      id: schedulingData.event_id,
      htmlLink: schedulingData.htmlLink,
      cached: true
    });
  }
  
  // Prepare event start and end times in local timezone representation
  const tz = schedulingData.scheduling?.timezone || process.env.CALENDAR_TIMEZONE || 'Asia/Kolkata';
  const duration = getDefaultDurationMinutes();
  
  const [y, m, d] = date.split('-').map(Number);
  const [h, min] = time.split(':').map(Number);
  const pad = (num) => String(num).padStart(2, '0');
  
  const startIsoStr = `${y}-${pad(m)}-${pad(d)}T${pad(h)}:${pad(min)}:00`;
  
  const localStartDate = new Date(Date.UTC(y, m - 1, d, h, min, 0));
  const localEndDate = new Date(localStartDate.getTime() + duration * 60 * 1000);
  const endYear = localEndDate.getUTCFullYear();
  const endMonth = localEndDate.getUTCMonth() + 1;
  const endDay = localEndDate.getUTCDate();
  const endHour = localEndDate.getUTCHours();
  const endMinute = localEndDate.getUTCMinutes();
  const endSecond = localEndDate.getUTCSeconds();
  
  const endIsoStr = `${endYear}-${pad(endMonth)}-${pad(endDay)}T${pad(endHour)}:${pad(endMinute)}:${pad(endSecond)}`;
  
  let description = null;
  if (zoomLink) {
    if (zoomLink.includes('teams.microsoft.com') || zoomLink.includes('teams.live.com')) {
      description = `Microsoft Teams Meeting Link: ${zoomLink}`;
    } else if (zoomLink.includes('meet.google.com')) {
      description = `Google Meet Meeting Link: ${zoomLink}`;
    } else if (zoomLink.includes('zoom.us')) {
      description = `Zoom Meeting Link: ${zoomLink}`;
    } else {
      description = `Meeting Link: ${zoomLink}`;
    }
  }
  const location = zoomLink || null;
  
  try {
    const event = await createCalendarEvent(title, startIsoStr, endIsoStr, tz, description, location);
    
    // Success -> update status to "confirmed" and save event info
    schedulingData.status = 'confirmed';
    schedulingData.event_id = event.id;
    schedulingData.htmlLink = event.htmlLink;
    fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
    
    console.log(`[Calendar Router] Event successfully created for ${filename}:
  - Title: "${title}"
  - Time: ${startIsoStr} (Timezone: ${tz})
  - Event ID: ${event.id}
  - Raw mention: "${schedulingData.scheduling?.raw_mention || 'none'}"`);
    
    // Upload updated file to Supabase Storage
    await uploadSchedulingToSupabase(filename, schedulingPath);

    // Clean up local temp file
    if (fs.existsSync(schedulingPath)) {
      fs.unlinkSync(schedulingPath);
    }

    return res.json({
      success: true,
      id: event.id,
      htmlLink: event.htmlLink
    });
  } catch (err) {
    const normErr = handleGoogleApiError(err);
    console.error(`[Calendar Router] Event creation failed for ${filename}: ${normErr.error}`);
    // Clean up local temp file even if failed
    if (fs.existsSync(schedulingPath)) {
      fs.unlinkSync(schedulingPath);
    }
    // Do NOT write status: "confirmed" on error, so user can retry!
    return res.status(normErr.status).json({ error: normErr.error });
  }
});

/**
 * Route: Dismisses a scheduling suggestion.
 */
calendarRouter.post('/dismiss-report-schedule', async (req, res) => {
  const { filename } = req.body;
  
  if (!filename) {
    return res.status(400).json({ error: 'Missing filename' });
  }
  
  // Sanitize filename to prevent directory traversal
  if (!/^[a-zA-Z0-9_\-\.]+$/.test(filename) || filename.includes('..') || !filename.endsWith('.jsonl')) {
    return res.status(400).json({ error: 'Invalid file name' });
  }
  
  const transcriptsDir = path.join(process.cwd(), 'transcripts');
  const schedulingFilename = filename.replace('.jsonl', '_report_scheduling.json');
  const schedulingPath = path.join(transcriptsDir, schedulingFilename);
  const legacyFilename = filename.replace('.jsonl', '_scheduling.json');
  const legacySchedulingPath = path.join(transcriptsDir, legacyFilename);
  
  // Load existing companion file (with legacy migration fallback)
  if (!fs.existsSync(schedulingPath)) {
    if (fs.existsSync(legacySchedulingPath)) {
      try {
        const legacyData = JSON.parse(fs.readFileSync(legacySchedulingPath, 'utf8'));
        fs.writeFileSync(schedulingPath, JSON.stringify(legacyData, null, 2), 'utf8');
        fs.unlinkSync(legacySchedulingPath);
        console.log(`[Calendar Router] Migrated legacy scheduling file on dismiss: ${schedulingFilename}`);
      } catch (err) {
        console.error('[Calendar Router] Failed to migrate legacy file on dismiss:', err.message);
      }
    } else {
      // Try to download from Supabase Storage
      await downloadSchedulingFromSupabase(filename, schedulingPath);
    }
  }
  
  if (!fs.existsSync(schedulingPath)) {
    return res.status(404).json({ error: 'Scheduling suggestion metadata not found' });
  }
  
  try {
    const schedulingData = JSON.parse(fs.readFileSync(schedulingPath, 'utf8'));
    schedulingData.status = 'dismissed';
    fs.writeFileSync(schedulingPath, JSON.stringify(schedulingData, null, 2), 'utf8');
    
    console.log(`[Calendar Router] Suggestion dismissed for ${filename}`);

    // Upload updated file to Supabase Storage
    await uploadSchedulingToSupabase(filename, schedulingPath);

    // Clean up local temp file
    if (fs.existsSync(schedulingPath)) {
      fs.unlinkSync(schedulingPath);
    }

    return res.json({ success: true });
  } catch (err) {
    // Clean up local temp file even if failed
    if (fs.existsSync(schedulingPath)) {
      fs.unlinkSync(schedulingPath);
    }
    return res.status(500).json({ error: `Failed to dismiss suggestion: ${err.message}` });
  }
});

/**
 * Route: Get upcoming calendar events in next 24 hours.
 */
calendarRouter.get('/upcoming', async (req, res) => {
  try {
    const now = new Date();
    const timeMin = now;
    const timeMax = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24 hours

    const events = await listUpcomingEvents(timeMin, timeMax);
    
    // Parse events and format them for frontend
    const formatted = events.map(e => {
      const meeting = extractMeetingDetails(e);
      return {
        id: e.id,
        summary: e.summary || 'No Title',
        start: e.start.dateTime || e.start.date,
        end: e.end.dateTime || e.end.date,
        meetingUrl: meeting?.url || null,
        botType: meeting?.type || null
      };
    });

    res.json({ events: formatted });
  } catch (err) {
    const apiErr = handleGoogleApiError(err);
    res.status(apiErr.status).json({ error: apiErr.error });
  }
});

/**
 * Route: Get auto-join background scheduler status.
 */
calendarRouter.get('/auto-join/status', (req, res) => {
  res.json({ active: autoJoinScheduler.isActive });
});

/**
 * Route: Toggle auto-join background scheduler.
 */
calendarRouter.post('/auto-join/toggle', (req, res) => {
  const { enable, projectId } = req.body;
  if (enable) {
    autoJoinScheduler.start(projectId);
  } else {
    autoJoinScheduler.stop();
  }
  res.json({ active: autoJoinScheduler.isActive });
});
