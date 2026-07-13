// Core dashboard state
let activeSessionId = null;
let activeBotType = null;
let socket = null;
let visualizerTimeout = null;

// UI elements
const launchForm = document.getElementById('launchForm');
const botTypeSelect = document.getElementById('botType');
const meetingUrlInput = document.getElementById('meetingUrl');
const botNameInput = document.getElementById('botName');
const headlessCheckbox = document.getElementById('headless');
const submitBtn = document.getElementById('submitBtn');

const globalStatusDot = document.getElementById('globalStatusDot');
const globalStatusText = document.getElementById('globalStatusText');
const speakerAvatar = document.getElementById('speakerAvatar');
const speakerName = document.getElementById('speakerName');
const speakerStatus = document.getElementById('speakerStatus');
const visBars = document.querySelectorAll('.vis-bar');
const sessionActions = document.getElementById('sessionActions');
const stopBtn = document.getElementById('stopBtn');

const activeBotTypeBadge = document.getElementById('activeBotType');
const activeSessionIdDisplay = document.getElementById('activeSessionId');
const emptyTranscript = document.getElementById('emptyTranscript');
const liveTranscript = document.getElementById('liveTranscript');
const transcriptScrollContainer = document.getElementById('transcriptScrollContainer');

const historyList = document.getElementById('historyList');
const emptyHistory = document.getElementById('emptyHistory');

// Modal elements
const historyModal = document.getElementById('historyModal');
const modalTitle = document.getElementById('modalTitle');
const modalBody = document.getElementById('modalBody');
const modalCloseBtn = document.getElementById('modalCloseBtn');
const modalDownloadBtn = document.getElementById('modalDownloadBtn');

// Report Modal elements
const reportModal = document.getElementById('reportModal');
const reportModalTitle = document.getElementById('reportModalTitle');
const reportSpeakerStats = document.getElementById('reportSpeakerStats');
const reportContent = document.getElementById('reportContent');
const reportModalCloseBtn = document.getElementById('reportModalCloseBtn');
const reportModalCloseBtn2 = document.getElementById('reportModalCloseBtn2');
const reportModalDownloadBtn = document.getElementById('reportModalDownloadBtn');

let currentViewedLines = [];

// Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
  loadActiveSessions();
  loadTranscriptsHistory();
  
  // Bind events
  launchForm.addEventListener('submit', handleLaunch);
  stopBtn.addEventListener('click', handleStop);
  modalCloseBtn.addEventListener('click', () => historyModal.classList.add('hidden'));
  modalDownloadBtn.addEventListener('click', downloadCurrentTranscript);
  
  // Bind report close events
  reportModalCloseBtn.addEventListener('click', () => reportModal.classList.add('hidden'));
  reportModalCloseBtn2.addEventListener('click', () => reportModal.classList.add('hidden'));
  
  // Close modal on background click
  window.addEventListener('click', (e) => {
    if (e.target === historyModal) {
      historyModal.classList.add('hidden');
    }
    if (e.target === reportModal) {
      reportModal.classList.add('hidden');
    }
  });
});

/**
 * Handle launching a bot process
 */
async function handleLaunch(e) {
  e.preventDefault();
  
  const payload = {
    botType: botTypeSelect.value,
    meetingUrl: meetingUrlInput.value.trim(),
    botName: botNameInput.value.trim(),
    isHeadless: headlessCheckbox.checked
  };

  setFormDisabled(true);
  updateStatus('starting', `Launching ${payload.botType} bot...`);
  
  try {
    const res = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to start bot');
    }

    activeSessionId = data.sessionId;
    activeBotType = data.botType;

    // Initialize state
    setupActiveSessionUI();
    connectWebSocket(activeSessionId);
    
  } catch (err) {
    updateStatus('error', err.message);
    alert(`Error: ${err.message}`);
    setFormDisabled(false);
  }
}

/**
 * Connect WebSocket to monitor live transcript updates
 */
function connectWebSocket(sessionId) {
  if (socket) {
    socket.close();
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/ws/transcripts?sessionId=${sessionId}`;
  
  socket = new WebSocket(wsUrl);

  socket.onopen = () => {
    console.log('[WebSocket] Connection established to backend server.');
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'status') {
        handleStatusUpdate(msg.data.status);
      } else if (msg.type === 'transcript') {
        handleIncomingTranscript(msg.data);
      } else if (msg.type === 'visualizer') {
        handleVisualizerPulse(msg.data);
      }
    } catch (e) {
      console.error('[WebSocket] Parsing error:', e);
    }
  };

  socket.onclose = () => {
    console.log('[WebSocket] Connection closed.');
    if (activeSessionId === sessionId) {
      // Unexpected disconnect from backend
      handleStatusUpdate('stopped');
    }
  };

  socket.onerror = (err) => {
    console.error('[WebSocket] Error:', err);
  };
}

/**
 * Handle stop action
 */
async function handleStop() {
  if (!activeSessionId) return;

  stopBtn.disabled = true;
  updateStatus('stopping', 'Stopping bot session...');

  try {
    const res = await fetch('/api/sessions/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: activeSessionId })
    });

    if (!res.ok) {
      throw new Error('Failed to terminate process');
    }

    // Clean up
    if (socket) {
      socket.close();
      socket = null;
    }
    
    handleStatusUpdate('stopped');
  } catch (err) {
    alert(`Error stopping bot: ${err.message}`);
    stopBtn.disabled = false;
  }
}

/**
 * Update UI for status changes
 */
function handleStatusUpdate(status) {
  console.log(`[Status] ${status}`);
  updateStatus(status);

  if (status === 'stopped') {
    activeSessionId = null;
    activeBotType = null;
    setFormDisabled(false);
    sessionActions.classList.add('hidden');
    activeBotTypeBadge.classList.add('hidden');
    activeSessionIdDisplay.classList.add('hidden');
    resetSpeakerDisplay();
    loadTranscriptsHistory(); // Refresh history log list
  } else {
    sessionActions.classList.remove('hidden');
    stopBtn.disabled = false;
  }
}

/**
 * Handle incoming transcript message and draw/render interim vs final text
 */
let lastSpeaker = null;
let currentInterimElement = null;

function handleIncomingTranscript({ speaker, text, timestamp, isFinal }) {
  if (emptyTranscript) {
    emptyTranscript.style.display = 'none';
  }

  // Remove old interim texts if this is a final chunk
  if (isFinal) {
    if (currentInterimElement) {
      currentInterimElement.remove();
      currentInterimElement = null;
    }

    // Clean up same speaker grouping or create a fresh row
    const row = document.createElement('div');
    row.className = 'transcript-row';

    const meta = document.createElement('div');
    meta.className = 'transcript-meta';

    const badge = document.createElement('span');
    badge.className = 'speaker-badge';
    badge.textContent = speaker;
    badge.style.backgroundColor = getSpeakerColor(speaker);
    badge.style.borderColor = getSpeakerBorderColor(speaker);

    const time = document.createElement('span');
    time.className = 'timestamp';
    time.textContent = new Date(timestamp).toLocaleTimeString();

    meta.appendChild(badge);
    meta.appendChild(time);

    const textEl = document.createElement('div');
    textEl.className = 'transcript-text';
    textEl.textContent = text;

    row.appendChild(meta);
    row.appendChild(textEl);
    liveTranscript.appendChild(row);
    
    // Auto scroll to bottom
    transcriptScrollContainer.scrollTop = transcriptScrollContainer.scrollHeight;
    
    // Pulse speaker card
    triggerSpeakerSpeech(speaker, true);
    lastSpeaker = speaker;
  } else {
    // Interim transcript update
    if (!currentInterimElement) {
      currentInterimElement = document.createElement('div');
      currentInterimElement.className = 'transcript-row interim-row';
      
      const meta = document.createElement('div');
      meta.className = 'transcript-meta';
      
      const badge = document.createElement('span');
      badge.className = 'speaker-badge';
      badge.textContent = speaker;
      badge.style.backgroundColor = getSpeakerColor(speaker);
      badge.style.borderColor = getSpeakerBorderColor(speaker);
      
      meta.appendChild(badge);
      currentInterimElement.appendChild(meta);
      
      const textEl = document.createElement('div');
      textEl.className = 'transcript-text interim';
      currentInterimElement.appendChild(textEl);
      
      liveTranscript.appendChild(currentInterimElement);
    }
    
    // Update the interim text content
    const textEl = currentInterimElement.querySelector('.transcript-text.interim');
    if (textEl) {
      textEl.textContent = text + '...';
    }
    
    // Auto scroll to bottom
    transcriptScrollContainer.scrollTop = transcriptScrollContainer.scrollHeight;
    triggerSpeakerSpeech(speaker, false);
  }
}

/**
 * Handle audio visualizer update from backend
 */
function handleVisualizerPulse({ rms, speaker }) {
  if (rms > 50) { // Speech detected threshold
    triggerSpeakerSpeech(speaker, true);
    
    // Scale visualizer bar heights dynamically
    const maxRms = 1000;
    const ratio = Math.min(rms / maxRms, 1);
    
    visBars.forEach((bar, idx) => {
      // Add slight variety to visualizer bars
      const variance = 0.5 + Math.sin(idx + Date.now() / 100) * 0.5;
      const height = Math.max(4, Math.round(ratio * 35 * variance));
      bar.style.height = `${height}px`;
      bar.style.backgroundColor = 'var(--accent-success)';
    });

    if (visualizerTimeout) {
      clearTimeout(visualizerTimeout);
    }
    visualizerTimeout = setTimeout(resetVisualizerBars, 300);
  }
}

function resetVisualizerBars() {
  visBars.forEach(bar => {
    bar.style.height = '4px';
    bar.style.backgroundColor = 'rgba(255, 255, 255, 0.08)';
  });
}

function triggerSpeakerSpeech(speaker, isSpeaking) {
  if (speaker && speaker !== 'Silence/Noise') {
    speakerAvatar.textContent = speaker[0].toUpperCase();
    speakerAvatar.className = 'speaker-avatar speaking';
    speakerAvatar.style.boxShadow = `0 0 25px ${getSpeakerBorderColor(speaker)}`;
    speakerAvatar.style.background = `linear-gradient(135deg, ${getSpeakerBorderColor(speaker)}, rgba(0,0,0,0.6))`;
    speakerName.textContent = speaker;
    speakerStatus.textContent = 'Speaking...';
  } else {
    resetSpeakerDisplay();
  }
}

function resetSpeakerDisplay() {
  speakerAvatar.textContent = '?';
  speakerAvatar.className = 'speaker-avatar';
  speakerAvatar.style.boxShadow = '';
  speakerAvatar.style.background = '';
  speakerName.textContent = 'No Active Speaker';
  speakerStatus.textContent = 'Idle';
}

/**
 * Hash speaker name to color palettes
 */
function getSpeakerColor(speaker) {
  if (!speaker || speaker === 'Silence/Noise') return 'rgba(156, 163, 175, 0.1)';
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsla(${hue}, 65%, 45%, 0.2)`;
}

function getSpeakerBorderColor(speaker) {
  if (!speaker || speaker === 'Silence/Noise') return 'rgba(156, 163, 175, 0.2)';
  let hash = 0;
  for (let i = 0; i < speaker.length; i++) {
    hash = speaker.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsla(${hue}, 70%, 60%, 0.5)`;
}

/**
 * Fetch and load active running sessions on page load
 */
async function loadActiveSessions() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    if (data.sessions && data.sessions.length > 0) {
      // Hook up to first active session
      const active = data.sessions[0];
      activeSessionId = active.sessionId;
      activeBotType = active.type;
      
      setupActiveSessionUI();
      handleStatusUpdate(active.status);
      connectWebSocket(activeSessionId);
    }
  } catch (err) {
    console.error('Failed to load active sessions:', err);
  }
}

/**
 * Populate list of past saved transcripts
 */
async function loadTranscriptsHistory() {
  try {
    const res = await fetch('/api/transcripts');
    const data = await res.json();
    
    if (data.transcripts && data.transcripts.length > 0) {
      emptyHistory.style.display = 'none';
      historyList.innerHTML = '';
      
      data.transcripts.forEach(item => {
        const fileRow = document.createElement('div');
        fileRow.className = 'history-item';
        
        const details = document.createElement('div');
        details.className = 'history-details';
        
        const title = document.createElement('span');
        title.className = 'history-title';
        title.textContent = item.fileName;
        
        const date = document.createElement('span');
        date.className = 'history-date';
        
        let metaInfo = '';
        if (item.isDbBacked) {
          metaInfo = `Cloud DB | ${item.status}`;
        } else {
          metaInfo = `${(item.size / 1024).toFixed(1)} KB`;
        }
        date.textContent = `${new Date(item.created).toLocaleString()} | ${metaInfo}`;
        
        details.appendChild(title);
        details.appendChild(date);
        
        const actions = document.createElement('div');
        actions.className = 'history-actions';
        
        const viewBtn = document.createElement('button');
        viewBtn.className = 'btn btn-secondary btn-sm';
        viewBtn.textContent = 'View';
        viewBtn.onclick = () => viewTranscriptFile(item.fileName);
        actions.appendChild(viewBtn);

        const reportBtn = document.createElement('button');
        reportBtn.className = 'btn btn-secondary btn-sm';
        reportBtn.style.marginLeft = '0.5rem';
        reportBtn.textContent = 'Report';
        reportBtn.onclick = () => openReportFlow(item.fileName, reportBtn);
        actions.appendChild(reportBtn);
        fileRow.appendChild(details);
        fileRow.appendChild(actions);
        historyList.appendChild(fileRow);
      });
    } else {
      emptyHistory.style.display = 'flex';
      historyList.innerHTML = '';
    }
  } catch (err) {
    console.error('Failed to load transcripts history:', err);
  }
}

/**
 * Modal viewer for historical log files
 */
async function viewTranscriptFile(fileName) {
  try {
    const res = await fetch(`/api/transcripts/${fileName}`);
    const data = await res.json();
    
    if (!res.ok || data.error) {
      throw new Error(data.error || 'Failed to read file');
    }
    
    currentViewedLines = data.lines;
    modalTitle.textContent = fileName;
    modalBody.innerHTML = '';
    
    if (data.lines.length === 0) {
      modalBody.innerHTML = '<div class="empty-state"><p>Empty log file.</p></div>';
    } else {
      const list = document.createElement('div');
      list.className = 'transcript-log';
      
      data.lines.forEach(line => {
        const row = document.createElement('div');
        row.className = 'transcript-row';
        
        const meta = document.createElement('div');
        meta.className = 'transcript-meta';
        
        const badge = document.createElement('span');
        badge.className = 'speaker-badge';
        badge.textContent = line.speaker;
        badge.style.backgroundColor = getSpeakerColor(line.speaker);
        badge.style.borderColor = getSpeakerBorderColor(line.speaker);
        
        const time = document.createElement('span');
        time.className = 'timestamp';
        time.textContent = new Date(line.timestamp).toLocaleTimeString();
        
        meta.appendChild(badge);
        meta.appendChild(time);
        
        const text = document.createElement('div');
        text.className = 'transcript-text';
        text.textContent = line.text;
        
        row.appendChild(meta);
        row.appendChild(text);
        list.appendChild(row);
      });
      
      modalBody.appendChild(list);
    }
    
    historyModal.classList.remove('hidden');
  } catch (err) {
    alert(`Failed to load log file: ${err.message}`);
  }
}

/**
 * Trigger text file download for modal transcripts
 */
function downloadCurrentTranscript() {
  if (currentViewedLines.length === 0) return;
  
  const textContent = currentViewedLines
    .map(line => `[${new Date(line.timestamp).toLocaleTimeString()}] [${line.speaker}]: ${line.text}`)
    .join('\n');
    
  const blob = new Blob([textContent], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = modalTitle.textContent.replace('.jsonl', '.txt');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Helpers
function setFormDisabled(disabled) {
  botTypeSelect.disabled = disabled;
  meetingUrlInput.disabled = disabled;
  botNameInput.disabled = disabled;
  headlessCheckbox.disabled = disabled;
  submitBtn.disabled = disabled;
}

function updateStatus(status, customText = '') {
  globalStatusDot.className = 'status-dot';
  
  if (status === 'idle' || status === 'stopped') {
    globalStatusDot.classList.add('idle');
    globalStatusText.textContent = 'Dashboard Ready';
  } else if (status === 'starting' || status === 'joining' || status === 'in_lobby') {
    globalStatusDot.classList.add('connecting');
    globalStatusDot.style.backgroundColor = '#f59e0b';
    globalStatusDot.style.boxShadow = '0 0 10px #f59e0b';
    globalStatusText.textContent = customText || 'Connecting...';
  } else if (status === 'in_call' || status === 'capturing') {
    globalStatusDot.classList.add('active');
    globalStatusText.textContent = customText || 'Capturing Call Live';
  } else if (status === 'error') {
    globalStatusDot.classList.add('error');
    globalStatusText.textContent = customText || 'Error';
  }
}

function setupActiveSessionUI() {
  activeBotTypeBadge.textContent = activeBotType.replace('-', ' ');
  activeBotTypeBadge.classList.remove('hidden');
  
  activeSessionIdDisplay.textContent = `Session ID: ${activeSessionId}`;
  activeSessionIdDisplay.classList.remove('hidden');
  
  emptyTranscript.style.display = 'none';
  liveTranscript.innerHTML = '';
}

/**
 * Handle checking, generating, and viewing reports for completed sessions
 */
async function openReportFlow(fileName, button) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = 'Loading...';

  try {
    const res = await fetch(`/api/transcripts/${fileName}/report`);
    
    if (res.status === 200) {
      const data = await res.json();
      showReport(fileName, data);
    } else if (res.status === 404) {
      const confirmGen = confirm('No report exists for this session. Would you like to generate one using Groq AI? This may take several seconds.');
      if (confirmGen) {
        button.textContent = 'Generating...';
        
        const genRes = await fetch(`/api/transcripts/${fileName}/generate-report`, {
          method: 'POST'
        });

        const genData = await genRes.json();
        
        if (genRes.ok && genData.success) {
          alert('Report generated successfully!');
          const fetchRes = await fetch(`/api/transcripts/${fileName}/report`);
          const reportData = await fetchRes.json();
          showReport(fileName, reportData);
        } else {
          throw new Error(genData.error || 'Failed to generate report');
        }
      }
    } else {
      const errorData = await res.json();
      throw new Error(errorData.error || 'Failed to retrieve report status');
    }
  } catch (err) {
    alert(`Error: ${err.message}`);
    console.error('[Report] Error:', err);
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

/**
 * Displays the report markdown and speaker talk-time progress bars inside the reportModal
 */
function showReport(fileName, { report, analytics }) {
  reportModalTitle.textContent = `Report: ${fileName}`;
  reportSpeakerStats.innerHTML = '';

  if (analytics && analytics.length > 0) {
    analytics.forEach(speaker => {
      const row = document.createElement('div');
      row.className = 'speaker-stats-row';

      const nameSpan = document.createElement('span');
      nameSpan.className = 'speaker-stats-name';
      nameSpan.textContent = speaker.name;

      const outerBar = document.createElement('div');
      outerBar.className = 'speaker-stats-bar-outer';

      const innerBar = document.createElement('div');
      innerBar.className = 'speaker-stats-bar-inner';
      innerBar.style.width = `${speaker.percentage}%`;
      innerBar.style.backgroundColor = getSpeakerBorderColor(speaker.name);

      outerBar.appendChild(innerBar);

      const valSpan = document.createElement('span');
      valSpan.className = 'speaker-stats-val';
      valSpan.textContent = `${speaker.percentage}%`;

      row.appendChild(nameSpan);
      row.appendChild(outerBar);
      row.appendChild(valSpan);
      reportSpeakerStats.appendChild(row);
    });
  } else {
    reportSpeakerStats.innerHTML = '<p style="font-size: 0.8125rem; color: var(--text-light); text-align: center;">No speaker metrics found.</p>';
  }

  // Render markdown text to HTML (XSS escaped first)
  reportContent.innerHTML = renderMarkdownToHtml(report);

  reportModalDownloadBtn.onclick = () => downloadReportFile(fileName, report);
  reportModal.classList.remove('hidden');
}

/**
 * Triggers file download of the raw report markdown
 */
function downloadReportFile(fileName, content) {
  const blob = new Blob([content], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName.replace('.jsonl', '_report.md');
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Safe, lightweight markdown-to-HTML parser that escapes XSS payloads first
 */
function renderMarkdownToHtml(md) {
  if (!md) return '';
  
  // 1. Escape HTML entities to secure against XSS
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Process markdown syntax line-by-line
  const lines = html.split('\n');
  let inTable = false;
  let inList = false;
  let tableHtml = '';
  
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();
    
    // Lists (* item)
    if (line.startsWith('* ')) {
      if (inTable) {
        tableHtml += '</tbody></table>';
        inTable = false;
        lines[i - 1] += '\n' + tableHtml;
        tableHtml = '';
      }
      const content = line.substring(2).trim();
      line = `<li>${content}</li>`;
      if (!inList) {
        inList = true;
        line = `<ul>${line}`;
      }
    } else {
      if (inList) {
        line = `</ul>${line}`;
        inList = false;
      }
    }

    // Tables (| cell | cell |)
    if (line.startsWith('|') && line.endsWith('|')) {
      if (line.includes('---')) {
        lines[i] = '';
        continue;
      }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      const tag = inTable ? 'td' : 'th';
      const rowContent = cells.map(c => `<${tag}>${c}</${tag}>`).join('');
      
      if (!inTable) {
        inTable = true;
        tableHtml = `<table><thead><tr>${rowContent}</tr></thead><tbody>`;
      } else {
        tableHtml += `<tr>${rowContent}</tr>`;
      }
      lines[i] = '';
      continue;
    } else {
      if (inTable) {
        tableHtml += '</tbody></table>';
        inTable = false;
        lines[i] = tableHtml + '\n' + line;
        tableHtml = '';
        continue;
      }
    }

    // Bold text (**text**)
    line = line.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');

    // Headings (###, ##, #)
    if (line.startsWith('### ')) {
      line = `<h3>${line.substring(4)}</h3>`;
    } else if (line.startsWith('## ')) {
      line = `<h2>${line.substring(3)}</h2>`;
    } else if (line.startsWith('# ')) {
      line = `<h1>${line.substring(2)}</h1>`;
    } 
    // Blockquote (> text)
    else if (line.startsWith('&gt; ')) {
      line = `<blockquote>${line.substring(5)}</blockquote>`;
    }
    // Standard Paragraph text
    else if (line.length > 0 && !line.startsWith('<')) {
      line = `<p>${line}</p>`;
    }

    lines[i] = line;
  }

  // Close open lists and tables
  if (inList) {
    lines[lines.length - 1] += '</ul>';
  }
  if (inTable) {
    tableHtml += '</tbody></table>';
    lines[lines.length - 1] += '\n' + tableHtml;
  }

  return lines.join('\n');
}
