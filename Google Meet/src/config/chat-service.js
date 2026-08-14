export function generateAnnouncementMessage(options = {}) {
  const botName = options.botName || process.env.BOT_NAME || 'Meeting Bot';
  const privacyUrl = options.privacyUrl || process.env.PRIVACY_URL || 'http://localhost:3000/privacy';
  const liveNotesUrl = options.liveNotesUrl || process.env.LIVE_NOTES_URL || 'http://localhost:3000/projects/meeting';
  const cmdPrefix = options.cmdPrefix || process.env.CMD_PREFIX || 'bot';

  return `${botName} was invited here to record & take notes. By continuing, you agree to ${privacyUrl}.

Type:
'/${cmdPrefix} pause' - pause recording
'/${cmdPrefix} resume' - resume recording
'/${cmdPrefix} leave' - stop recording & leave meeting

View Realtime notes here: ${liveNotesUrl}`;
}

export function parseChatCommand(text, options = {}) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  const cmdPrefix = (options.cmdPrefix || process.env.CMD_PREFIX || 'bot').toLowerCase();
  
  // Match explicit slash commands only: /bot pause, /bot resume, /bot leave,
  // /bot stop, /ff resume, /leave, /pause, etc. Bare words in casual chat
  // (e.g. "we should pause") must NEVER trigger a command — that previously
  // stopped the live transcript when the scheduling proposal message was read.
  const pattern = new RegExp(`^\\/(?:(?:${cmdPrefix}|ff|bot)\\s+)?(pause|resume|leave|stop)\\b`, 'i');
  const match = trimmed.match(pattern);
  if (match) {
    const action = match[1].toLowerCase();
    return action === 'stop' ? 'leave' : action;
  }
  return null;
}
