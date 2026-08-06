export function generateAnnouncementMessage(options = {}) {
  const inviterName = options.inviterName || process.env.INVITER_NAME || 'Ishita Bhojani';
  const botName = options.botName || process.env.BOT_NAME || 'Meeting Bot';
  const privacyUrl = options.privacyUrl || process.env.PRIVACY_URL || 'http://localhost:3000/privacy';
  const liveNotesUrl = options.liveNotesUrl || process.env.LIVE_NOTES_URL || 'http://localhost:3000/projects/meeting';
  const cmdPrefix = options.cmdPrefix || process.env.CMD_PREFIX || 'bot';

  return `${inviterName} invited ${botName} here to record & take notes. By continuing, you agree to ${privacyUrl}.

Type:
'/${cmdPrefix} pause' - pause recording
'/${cmdPrefix} resume' - resume recording
'/${cmdPrefix} leave' - stop recording & leave meeting

View Realtime notes here: ${liveNotesUrl}`;
}

export function parseChatCommand(text, options = {}) {
  if (!text || typeof text !== 'string') return null;
  // Ignore lines that are part of the announcement or system instructions
  if (
    text.includes('invited') || 
    text.includes('agree to') || 
    text.includes('stop recording & leave meeting') ||
    text.includes('Realtime notes') ||
    text.includes('Continuous chat')
  ) {
    return null;
  }

  const trimmed = text.trim();
  const cmdPrefix = (options.cmdPrefix || process.env.CMD_PREFIX || 'bot').toLowerCase();
  
  // Match /bot pause, /bot resume, /bot leave, /bot stop, bot leave, /leave, etc.
  const pattern = new RegExp(`(?:^|\\s)\\/?(${cmdPrefix}|ff|bot)?\\s*(pause|resume|leave|stop)\\b`, 'i');
  const match = trimmed.match(pattern);
  if (match) {
    const action = match[2].toLowerCase();
    return action === 'stop' ? 'leave' : action;
  }
  return null;
}
