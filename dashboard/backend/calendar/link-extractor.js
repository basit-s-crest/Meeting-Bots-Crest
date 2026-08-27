/**
 * Extracts meeting link and detects platform type (Google Meet, Zoom, MS Teams)
 * from a Google Calendar event object.
 *
 * Checks hangoutLink, conferenceData, location, and description fields.
 *
 * @param {Object} event - Google Calendar event object
 * @returns {Object|null} { platform: 'google-meet'|'zoom'|'teams', url: string } or null
 */
export function extractMeetingLink(event) {
  if (!event) return null;

  // 1. Check Google Meet native properties (hangoutLink & conferenceData)
  if (event.hangoutLink && event.hangoutLink.includes('meet.google.com')) {
    return { platform: 'google-meet', url: event.hangoutLink.trim() };
  }

  if (event.conferenceData?.entryPoints) {
    for (const ep of event.conferenceData.entryPoints) {
      if (ep.uri && ep.uri.includes('meet.google.com')) {
        return { platform: 'google-meet', url: ep.uri.trim() };
      }
    }
  }

  // 2. Scan location and description text fields for platform URL patterns
  const rawText = `${event.location || ''} ${event.description || ''}`;

  // Extract URLs from any HTML href attributes first so <a href="...">Link</a> isn't lost
  const hrefUrls = [];
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let hrefMatch;
  while ((hrefMatch = hrefRegex.exec(rawText)) !== null) {
    hrefUrls.push(hrefMatch[1]);
  }

  // Also build cleaned plain text
  const cleanText = rawText
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  const textToScan = `${hrefUrls.join(' ')} ${cleanText} ${rawText}`
    .replace(/&amp;/g, '&');

  // Google Meet Regex (supports meet.google.com/xxx-yyyy-zzz with or without https and query params)
  const meetMatch = textToScan.match(/(?:https?:\/\/)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?:\?[^\s"<>]+)?/i);
  if (meetMatch) {
    const url = meetMatch[0].startsWith('http') ? meetMatch[0] : `https://${meetMatch[0]}`;
    return { platform: 'google-meet', url: url.trim() };
  }

  // Zoom Regex (Matches zoom.us/j/123456789 or zoom.us/my/room, subdomains, etc.)
  const zoomMatch = textToScan.match(/(?:https?:\/\/)?[a-z0-9.\-]*zoom\.us\/(?:j|my|wc)\/[a-zA-Z0-9?=_&%-]+/i);
  if (zoomMatch) {
    const url = zoomMatch[0].startsWith('http') ? zoomMatch[0] : `https://${zoomMatch[0]}`;
    return { platform: 'zoom', url: url.trim() };
  }

  // Teams Regex (Matches teams.microsoft.com/meet/..., teams.microsoft.com/l/meetup-join/..., teams.live.com/meet/...)
  const teamsMatch = textToScan.match(/(?:https?:\/\/)?(?:[a-z0-9\-]+\.)?teams\.(?:microsoft|live)\.com\/(?:l\/meetup-join|meet)\/[^\s"<>]+/i);
  if (teamsMatch) {
    const url = teamsMatch[0].startsWith('http') ? teamsMatch[0] : `https://${teamsMatch[0]}`;
    return { platform: 'teams', url: url.trim() };
  }

  return null;
}

/**
 * Backward-compatible helper for Google Meet extraction.
 */
export function extractGoogleMeetUrl(event) {
  const result = extractMeetingLink(event);
  return result?.platform === 'google-meet' ? result.url : null;
}
