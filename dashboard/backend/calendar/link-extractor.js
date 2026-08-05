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
  const textToScan = `${event.location || ''} ${event.description || ''}`;

  // Google Meet Regex
  const meetMatch = textToScan.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
  if (meetMatch) {
    return { platform: 'google-meet', url: meetMatch[0].trim() };
  }

  // Zoom Regex (Matches zoom.us/j/123456789 or zoom.us/my/room)
  const zoomMatch = textToScan.match(/https:\/\/[a-z0-9\-]+\.zoom\.us\/(j|my)\/[0-9\?=\-_A-Za-z]+/i);
  if (zoomMatch) {
    return { platform: 'zoom', url: zoomMatch[0].trim() };
  }

  // Teams Regex (Matches teams.microsoft.com/l/meetup-join/...)
  const teamsMatch = textToScan.match(/https:\/\/teams\.microsoft\.com\/l\/meetup-join\/[^\s"<>]+/i);
  if (teamsMatch) {
    return { platform: 'teams', url: teamsMatch[0].trim() };
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
