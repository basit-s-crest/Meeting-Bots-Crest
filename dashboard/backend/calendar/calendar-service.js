import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { google } from 'googleapis';
import * as chrono from 'chrono-node';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const envPath = path.resolve(__dirname, '../../../.env');

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const DEFAULT_DURATION = 30;

/**
 * Returns the configured CALENDAR_TIMEZONE or default 'Asia/Kolkata'.
 */
export function getTimezone() {
  return process.env.CALENDAR_TIMEZONE || DEFAULT_TIMEZONE;
}

/**
 * Returns the default duration in minutes from environment variables, fallback to 30.
 */
export function getDefaultDurationMinutes() {
  if (process.env.DEFAULT_DURATION_MINUTES) {
    const val = parseInt(process.env.DEFAULT_DURATION_MINUTES, 10);
    if (!isNaN(val) && val > 0) {
      return val;
    }
  }
  return DEFAULT_DURATION;
}

function getCandidateTokenPaths() {
  return [
    path.resolve(__dirname, '../google_calendar_refresh_token.json'),
    path.resolve(process.cwd(), 'dashboard/backend/google_calendar_refresh_token.json'),
    path.resolve(process.cwd(), 'google_calendar_refresh_token.json')
  ];
}

/**
 * Saves refresh token to dedicated JSON file and updates process.env in memory.
 */
export function saveRefreshToken(token) {
  try {
    const targetPath = getCandidateTokenPaths()[0];
    fs.writeFileSync(targetPath, JSON.stringify({ refresh_token: token }), 'utf8');
    process.env.GOOGLE_CALENDAR_REFRESH_TOKEN = token;
    console.log(`[Calendar Service] Refresh token saved successfully to ${targetPath}.`);
  } catch (err) {
    console.error('[Calendar Service] Failed to save refresh token:', err.message);
    throw err;
  }
}

/**
 * Loads refresh token from dedicated JSON file, falling back to process.env.
 */
export function loadRefreshToken() {
  for (const tokenPath of getCandidateTokenPaths()) {
    if (fs.existsSync(tokenPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        if (data.refresh_token) {
          return data.refresh_token;
        }
      } catch (e) {
        console.error(`[Calendar Service] Error reading refresh token file at ${tokenPath}:`, e.message);
      }
    }
  }
  return process.env.GOOGLE_CALENDAR_REFRESH_TOKEN || null;
}

/**
 * Creates and returns the Google OAuth2 client.
 */
export function getOAuth2Client() {
  const clientID = process.env.GOOGLE_CALENDAR_CLIENT_ID || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_CALENDAR_REDIRECT_URI || process.env.GOOGLE_REDIRECT_URI;
  
  if (!clientID || !clientSecret || !redirectUri) {
    throw new Error('Google Calendar client credentials (ID, Secret, Redirect URI) are not configured in the .env file.');
  }
  
  return new google.auth.OAuth2(clientID, clientSecret, redirectUri);
}

/**
 * Returns an authenticated Google Calendar client.
 */
export async function getCalendarClient() {
  const refreshToken = loadRefreshToken();
  if (!refreshToken) {
    throw new Error('No refresh token found. Please authenticate via /api/calendar/auth first.');
  }
  const oauth2Client = getOAuth2Client();
  oauth2Client.setCredentials({ refresh_token: refreshToken });
  try {
    await oauth2Client.getAccessToken();
  } catch (err) {
    throw new Error(`Failed to refresh Google Calendar access token: ${err.message}`);
  }
  return google.calendar({ version: 'v3', auth: oauth2Client });
}

/**
 * Parses natural-language instruction to extract the title and start/end dates.
 */
export function parseInstruction(instruction) {
  if (!instruction || typeof instruction !== 'string') {
    throw new Error('Instruction must be a non-empty string.');
  }
  
  const tz = getTimezone();
  const now = new Date();
  
  // Convert current time to string in target timezone and parse it as a Date.
  // The resulting Date's local components represent the current local time in the target timezone.
  const targetLocalString = now.toLocaleString('en-US', { timeZone: tz });
  const referenceDate = new Date(targetLocalString);
  
  const parsedResults = chrono.parse(instruction, referenceDate);
  if (!parsedResults || parsedResults.length === 0) {
    throw new Error('Could not parse any date or time expression from the instruction.');
  }
  
  const result = parsedResults[0];
  const startComponents = result.start;
  
  // Ensure we have confident time and date parsing
  const hasTime = startComponents.isCertain('hour');
  const hasDate = startComponents.isCertain('day') || startComponents.isCertain('month') || startComponents.isCertain('year');
  
  if (!hasTime) {
    throw new Error("The time of the event is not specified. Please clarify the time (e.g., 'tomorrow at 5pm').");
  }
  if (!hasDate) {
    throw new Error("The date of the event is not specified. Please clarify the date.");
  }
  
  // Extract components
  const year = startComponents.get('year');
  const month = startComponents.get('month'); // 1-indexed
  const day = startComponents.get('day');
  const hour = startComponents.get('hour');
  const minute = startComponents.get('minute') || 0;
  const second = startComponents.get('second') || 0;
  
  // Extract the title by removing only the matched date-time expression based on its index
  const matchText = result.text;
  const matchIndex = result.index;
  const matchLength = matchText.length;
  
  let title = instruction.substring(0, matchIndex) + instruction.substring(matchIndex + matchLength);
  
  // Clean up title text by only trimming filler words from the leading and trailing edges.
  // Using ^ and $ anchors prevents removing filler words like "with" in the middle.
  title = title.replace(/\b(at|on|for|in|to|with)\s*$/gi, '').trim();
  title = title.replace(/^\s*\b(at|on|for|in|to|with)\b/gi, '').trim();
  title = title.replace(/\s+/g, ' ').trim();
  
  if (!title) {
    title = 'Meeting';
  }
  
  const pad = (num) => String(num).padStart(2, '0');
  
  // Format timezone-naive ISO string for start
  const startIsoStr = `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}`;
  
  // Calculate end time components using timezone-naive math with UTC Date object
  const duration = getDefaultDurationMinutes();
  const localStartDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const localEndDate = new Date(localStartDate.getTime() + duration * 60 * 1000);
  
  const endYear = localEndDate.getUTCFullYear();
  const endMonth = localEndDate.getUTCMonth() + 1;
  const endDay = localEndDate.getUTCDate();
  const endHour = localEndDate.getUTCHours();
  const endMinute = localEndDate.getUTCMinutes();
  const endSecond = localEndDate.getUTCSeconds();
  
  const endIsoStr = `${endYear}-${pad(endMonth)}-${pad(endDay)}T${pad(endHour)}:${pad(endMinute)}:${pad(endSecond)}`;
  
  return {
    title,
    startIsoStr,
    endIsoStr,
    tz,
    matchText
  };
}

/**
 * Creates Google Calendar event.
 */
export async function createCalendarEvent(title, startIsoStr, endIsoStr, tz, description = null, location = null) {
  const calendar = await getCalendarClient();
  
  const requestBody = {
    summary: title,
    start: {
      dateTime: startIsoStr,
      timeZone: tz
    },
    end: {
      dateTime: endIsoStr,
      timeZone: tz
    }
  };

  if (description) requestBody.description = description;
  if (location) requestBody.location = location;
  
  const response = await calendar.events.insert({
    calendarId: 'primary',
    requestBody
  });
  
  return response.data;
}

/**
 * Normalizes Google Calendar errors into structured HTTP status and messages.
 */
export function handleGoogleApiError(error) {
  console.error('[Calendar Service] Google Calendar API Error details:', error);
  
  const errMsg = error.message || '';
  const errData = error.response?.data?.error || '';
  const status = error.status || error.code || 500;
  
  // Check for expired/revoked/invalid credentials (invalid_grant)
  if (
    errMsg.includes('invalid_grant') || 
    (typeof errData === 'string' && errData.includes('invalid_grant')) ||
    errData.message?.includes('invalid_grant') ||
    errMsg.includes('No refresh token')
  ) {
    return {
      status: 401,
      error: "Google Calendar authentication failed (invalid_grant or token expired/revoked). Please re-authenticate via the setup flow at /api/calendar/auth."
    };
  }
  
  if (status === 401) {
    return {
      status: 401,
      error: "Google Calendar credentials have expired or are invalid. Please re-authenticate."
    };
  }
  
  if (
    status === 429 || 
    status === 403 || 
    errMsg.toLowerCase().includes('quota') || 
    errMsg.toLowerCase().includes('rate limit')
  ) {
    return {
      status: 429,
      error: "Google Calendar API rate limit or quota exceeded. Please try again later."
    };
  }
  
  if (status === 400) {
    return {
      status: 400,
      error: `Malformed request to Google Calendar: ${errMsg}`
    };
  }
  
  return {
    status: 500,
    error: `Google Calendar service error: ${errMsg}`
  };
}

/**
 * Query primary calendar events in the given time frame.
 * @param {Date} timeMin 
 * @param {Date} timeMax 
 */
export async function listUpcomingEvents(timeMin, timeMax) {
  const calendar = await getCalendarClient();
  const response = await calendar.events.list({
    calendarId: 'primary',
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
    orderBy: 'startTime',
  });
  return response.data.items || [];
}

/**
 * Searches location, description, and conferenceData fields for meeting links.
 * Returns { url, type } or null.
 * @param {Object} event 
 */
export function extractMeetingDetails(event) {
  if (!event) return null;

  const entryPointUris = event.conferenceData?.entryPoints?.map(ep => ep.uri || '') || [];

  const sources = [
    event.hangoutLink || '',
    ...entryPointUris,
    event.location || '',
    event.description || '',
    event.summary || '',
    event.htmlLink || ''
  ];
  
  const meetRegex = /(https:\/\/meet\.google\.com\/[a-z0-9\-]+)/i;
  const zoomRegex = /(https:\/\/[a-z0-9\.-]*zoom\.us\/[^\s>"\',\)]+)/i;
  const teamsRegex = /(https:\/\/[a-z0-9\.-]*teams\.(microsoft|live)\.com\/[^\s>"\',\)]+)/i;

  for (const str of sources) {
    if (!str) continue;
    if (meetRegex.test(str)) {
      return { url: str.match(meetRegex)[0], type: 'google-meet' };
    }
    if (zoomRegex.test(str)) {
      return { url: str.match(zoomRegex)[0], type: 'zoom' };
    }
    if (teamsRegex.test(str)) {
      return { url: str.match(teamsRegex)[0], type: 'teams' };
    }
  }
  return null;
}
