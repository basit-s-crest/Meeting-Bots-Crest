export const SELECTORS = {
  join: {
    // Landing page: bypass native client promo dialog
    joinOnWebBtn: 'button[data-tid="joinOnWeb"], button:has-text("Use Teams on the web"), button:has-text("Continue on this browser")',
    
    // Pre-join: cam and mic toggles
    camToggle: 'button[role="checkbox"][aria-label*="video" i], button[aria-label*="camera" i], button[data-tid="prejoin-play-video"]',
    micToggle: 'button[role="checkbox"][aria-label*="microphone" i], button[aria-label*="mic" i], button[data-tid="prejoin-mute-mic"]',
    
    // Pre-join: guest entry name input
    nameInput: 'input[data-tid="prejoin-display-name"], input[placeholder*="name" i], input#username, input[type="text"]',
    
    // Pre-join: join submission
    joinNowBtn: 'button[data-tid="prejoin-join-button"], button:has-text("Join now"), button[aria-label*="Join meeting" i]:not([data-tid="joinOnWeb"])',
  },
  inCall: {
    // Indicator that we've successfully joined the call
    callingScreen: 'div[data-tid="meeting-calling-screen"], div[data-testid="calling-screen"]',
    leaveBtn: 'button#hangup-button, button[data-tid="hangup-button"], button[aria-label*="Leave" i], button[aria-label*="Hang up" i]',
    
    // Action menu to turn on captions
    moreBtn: 'button#callingButtons-showMoreBtn, button[data-tid="more-actions-button"], button#callingButtons-more-button, button[aria-label*="More actions" i]',
    languageAndSpeechMenu: 'button:has-text("Language and speech"), button[aria-label*="Language and speech" i]',
    turnOnCaptionsBtn: 'button:has-text("Turn on live captions"), button[aria-label*="Turn on live captions" i]',
    
    // Captions elements
    captionsContainer: '[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-v2-window-wrapper"], div[data-tid="captions-container"], div.captions-render-area, div[class*="captions-container" i]',
    captionText: 'div[class*="caption-text" i], span[class*="caption-text" i], .caption-text',
    captionSpeaker: '.___1hdoxqz, div[class*="speaker" i], span[class*="speaker" i], .caption-speaker, strong',
  },
  lobby: {
    // Indicators that we are waiting for host approval
    waitingText: 'text=/waiting for the organizer|waiting for host|let you in|lobby/i',
    lobbyContainer: 'div[data-tid="lobby-screen"], div[class*="lobby" i]',
  }
};

export const TIMEOUTS = {
  navigation: 45000,
  join: 180000,     // 3 minutes for user/host to admit from lobby
  element: 15000,
  lobbyPoll: 5000,
};
