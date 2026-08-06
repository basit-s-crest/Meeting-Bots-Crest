import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELECTORS, TIMEOUTS } from '../config/selectors.js';

export class TeamsBot {
  /**
   * @param {string} meetingUrl
   * @param {string} botName
   * @param {object} options
   */
  constructor(meetingUrl, botName = 'Teams Meeting Bot', options = {}) {
    this.meetingUrl = meetingUrl;
    this.botName = botName;
    this.headless = options.headless !== false;
    this.channel = options.channel || null;
    
    // Resolve auth.json path relative to this source file, which is inside Microsoft Teams/src/join
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const defaultAuthPath = path.resolve(__dirname, '../../auth.json');
    this.authPath = path.resolve(options.authPath || defaultAuthPath);
    
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isLoginMode = options.isLoginMode === true;
    this.isGuest = options.isGuest === true;
  }

  /**
   * Launch browser and configure session state
   */
  async launch() {
    const launchOptions = {
      headless: this.headless,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1920,1080',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-features=CalculateNativeWinOcclusion',
      ],
    };

    if (this.channel) {
      launchOptions.channel = this.channel;
    }

    console.log(`[TeamsBot] Launching browser (headless: ${this.headless}, channel: ${this.channel || 'default'}, guest: ${this.isGuest})`);

    const hasSavedSession = fs.existsSync(this.authPath);
    const loadSession = !this.isLoginMode && (hasSavedSession || !this.isGuest);

    // Strict startup verification: fail early if credentials/session file is missing in normal mode
    if (loadSession) {
      if (!fs.existsSync(this.authPath)) {
        console.error(`\n[TeamsBot] ERROR: Saved session file (auth.json) not found at expected path: ${this.authPath}`);
        console.error('[TeamsBot] To create this session, please run first:');
        console.error('    node src/index.js --login');
        console.error('[TeamsBot] Exiting process to avoid unauthenticated runtime failure.\n');
        throw new Error(`CRITICAL: Saved session state (auth.json) not found at: ${this.authPath}`);
      }
    }

    this.browser = await chromium.launch(launchOptions);

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      permissions: ['microphone', 'camera'],
      viewport: { width: 1920, height: 1080 },
    };

    if (loadSession) {
      console.log(`[TeamsBot] Loading session state from ${this.authPath}`);
      contextOptions.storageState = this.authPath;
    }

    this.context = await this.browser.newContext(contextOptions);

    // Override page visibility and focus state to prevent Teams background throttling
    await this.context.addInitScript(() => {
      Object.defineProperty(document, 'visibilityState', {
        get: () => 'visible',
        configurable: true
      });
      Object.defineProperty(document, 'hidden', {
        get: () => false,
        configurable: true
      });
      document.hasFocus = () => true;

      // Stop visibility change events from bubbling/propagating to Teams scripts
      window.addEventListener('visibilitychange', (e) => {
        e.stopImmediatePropagation();
      }, true);
    });

    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUTS.navigation);

    // Propagate page console logs and errors for easier debugging
    this.page.on('console', msg => console.log(`[BROWSER CONSOLE] ${msg.text()}`));
    this.page.on('pageerror', err => console.error(`[BROWSER EXCEPTION] ${err.message}`));
  }

  /**
   * Navigate to Teams meeting URL and execute the join flow
   */
  async join() {
    if (!this.meetingUrl) {
      throw new Error('No meeting URL specified.');
    }

    console.log(`[TeamsBot] Navigating to meeting URL: ${this.meetingUrl}`);
    await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded' });

    // Log visibilityState inside the page context right after navigation
    const visibilityState = await this.page.evaluate(() => document.visibilityState).catch(() => 'unknown');
    console.log(`[TeamsBot] [DEBUG] Current document.visibilityState: ${visibilityState}`);

    // 1. Bypass "Open Microsoft Teams" landing page to use the web client
    await this.bypassAppLandingPage();

    // Wait for the pre-join screen to be fully loaded and visible
    await this.waitForPreJoinPageToLoad();

    // 2. Handle guest entry name input if in guest mode
    await this.handleNameInput();

    // 3. Disable camera and microphone in the pre-join lobby
    await this.handleMediaToggles();

    // 4. Click "Join now"
    await this.clickJoinNow();

    // 5. Handle lobby wait / admission
    await this.handleLobbyAdmission();
  }

  /**
   * Network monitoring setup to capture failed/slow CDN requests
   */
  setupNetworkMonitoring() {
    if (this._networkMonitoringSetup) return;
    this._networkMonitoringSetup = true;

    this.failedCdnRequests = [];

    this.page.on('requestfailed', req => {
      const url = req.url();
      const failure = req.failure();
      if (url.includes('cdn') || url.includes('static') || url.includes('teams') || url.includes('office')) {
        const errorText = failure ? failure.errorText : 'failed';
        console.warn(`[TeamsBot] [CDN FAILURE] Request failed: ${url} (Error: ${errorText})`);
        this.failedCdnRequests.push({ url, error: errorText, timestamp: Date.now() });
      }
    });

    this.page.on('response', resp => {
      const url = resp.url();
      const status = resp.status();
      if (status >= 400 && (url.includes('cdn') || url.includes('static') || url.includes('teams') || url.includes('office'))) {
        console.warn(`[TeamsBot] [CDN HTTP ERROR] Request returned status ${status}: ${url}`);
        this.failedCdnRequests.push({ url, status, timestamp: Date.now() });
      }
    });
  }

  /**
   * Helper to inspect and log slow CDN assets and DOM elements loading status
   */
  async logSlowAssetsAndDomState() {
    try {
      const pageInfo = await this.page.evaluate(() => {
        const resources = performance.getEntriesByType('resource') || [];
        const slowResources = resources
          .filter(r => r.duration > 1500 || r.name.includes('cdn') || r.name.includes('static') || r.name.includes('teams'))
          .map(r => ({
            url: r.name,
            durationMs: Math.round(r.duration),
            initiatorType: r.initiatorType
          }))
          .sort((a, b) => b.durationMs - a.durationMs)
          .slice(0, 10);

        const readyState = document.readyState;
        const title = document.title;
        const joinBtn = document.querySelector('button[data-tid="prejoin-join-button"]');
        const nameInput = document.querySelector('input[data-tid="name-input"]');
        const joinWebBtn = document.querySelector('button[data-tid="joinOnWeb"]');
        const loadingSpinners = Array.from(document.querySelectorAll('[class*="spinner"], [class*="loader"], [data-testid*="loader"]'))
          .map(el => el.outerHTML.slice(0, 100));

        return {
          readyState,
          title,
          joinBtnPresent: !!joinBtn,
          joinBtnVisible: !!(joinBtn && (joinBtn.offsetWidth > 0 || joinBtn.offsetHeight > 0)),
          nameInputPresent: !!nameInput,
          nameInputVisible: !!(nameInput && (nameInput.offsetWidth > 0 || nameInput.offsetHeight > 0)),
          joinWebBtnPresent: !!joinWebBtn,
          slowResources,
          activeSpinnersCount: loadingSpinners.length
        };
      }).catch(() => null);

      if (pageInfo) {
        console.log(`[TeamsBot] [DOM DIAGNOSTICS] document.readyState: "${pageInfo.readyState}" | Title: "${pageInfo.title}" | JoinBtn Visible: ${pageInfo.joinBtnVisible} | NameInput Visible: ${pageInfo.nameInputVisible} | Active Spinners: ${pageInfo.activeSpinnersCount}`);
        
        if (pageInfo.slowResources && pageInfo.slowResources.length > 0) {
          console.log('[TeamsBot] [CDN DIAGNOSTICS] Slow CDN assets captured during pre-join:');
          for (const res of pageInfo.slowResources) {
            console.log(`  - ${res.url} (${res.durationMs}ms, type: ${res.initiatorType})`);
          }
        }
      }

      if (this.failedCdnRequests && this.failedCdnRequests.length > 0) {
        console.log('[TeamsBot] [CDN DIAGNOSTICS] Failed CDN request log:');
        for (const req of this.failedCdnRequests) {
          console.log(`  - ${req.url} (${req.error || 'Status ' + req.status})`);
        }
      }
    } catch (err) {
      console.warn('[TeamsBot] Failed to collect asset/DOM diagnostics:', err.message);
    }
  }

  /**
   * Generously waits for the pre-join screen to finish loading with retries and backoff.
   * Max 2 retries (3 total attempts) capped by a 90s final fallback ceiling.
   */
  async waitForPreJoinPageToLoad() {
    console.log('[TeamsBot] Waiting for pre-join lobby page elements to load...');
    this.setupNetworkMonitoring();

    // Log resolved URL and page title
    const resolvedUrl = this.page.url();
    const pageTitle = await this.page.title().catch(() => 'unknown');
    console.log(`[TeamsBot] [DEBUG] Pre-join load check - Resolved URL: "${resolvedUrl}" | Page Title: "${pageTitle}"`);

    // Wait for either guest name input or join now button to load
    const selector = `${SELECTORS.join.nameInput}, ${SELECTORS.join.joinNowBtn}`;

    const TOTAL_TIMEOUT_CEILING = 90000; // 90s final fallback ceiling
    const MAX_RETRIES = 2; // max 2 retries (3 total attempts)
    const startTime = Date.now();

    // Per-attempt timeout strategy (attempt 1: 25s, attempt 2: 30s, attempt 3: remaining up to ceiling)
    const attemptTimeouts = [25000, 30000];

    for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
      const elapsed = Date.now() - startTime;
      const remainingTotal = TOTAL_TIMEOUT_CEILING - elapsed;

      if (remainingTotal <= 0) {
        break;
      }

      const defaultAttemptTimeout = attemptTimeouts[attempt - 1] || 30000;
      const currentTimeout = Math.min(defaultAttemptTimeout, remainingTotal);

      console.log(`[TeamsBot] Pre-join load check (Attempt ${attempt}/${MAX_RETRIES + 1}, timeout: ${currentTimeout}ms, remaining ceiling: ${remainingTotal}ms)...`);

      try {
        await this.page.waitForSelector(selector, { state: 'visible', timeout: currentTimeout });
        console.log(`[TeamsBot] Pre-join lobby page loaded successfully on attempt ${attempt}.`);
        await this.logSlowAssetsAndDomState();
        return;
      } catch (err) {
        console.warn(`[TeamsBot] Pre-join load attempt ${attempt}/${MAX_RETRIES + 1} timed out or failed:`, err.message);
        await this.logSlowAssetsAndDomState();

        const timeSpent = Date.now() - startTime;
        if (attempt <= MAX_RETRIES && timeSpent < TOTAL_TIMEOUT_CEILING) {
          const backoffMs = attempt * 2000; // Exponential/linear backoff: 2s for retry 1, 4s for retry 2
          console.log(`[TeamsBot] Retrying pre-join load in ${backoffMs}ms (Retry ${attempt}/${MAX_RETRIES})...`);
          await this.page.waitForTimeout(backoffMs);
        }
      }
    }

    // If all attempts failed or 90s ceiling reached
    const totalElapsed = Date.now() - startTime;
    console.error(`[TeamsBot] Fatal: pre-join page failed to load after ${MAX_RETRIES} retries (${Math.round(totalElapsed / 1000)}s elapsed, 90s ceiling reached).`);

    try {
      const screenshotPath = path.resolve(path.dirname(this.authPath), 'error_screenshot.png');
      await this.page.screenshot({ path: screenshotPath });
      console.log(`[TeamsBot] Saved loading failure screenshot to: ${screenshotPath}`);
      
      // Dump HTML page content on failure
      const htmlPath = path.resolve(path.dirname(this.authPath), 'error_dom_dump.html');
      const content = await this.page.content().catch(() => '');
      fs.writeFileSync(htmlPath, content, 'utf8');
      console.log(`[TeamsBot] Saved failure DOM HTML dump to: ${htmlPath}`);
    } catch (sErr) {
      console.error('[TeamsBot] Failed to save diagnostics:', sErr.message);
    }

    throw new Error(`Teams pre-join page failed to load within ${Math.round(totalElapsed / 1000)}s (${MAX_RETRIES} retries attempted).`);
  }

  /**
   * Bypasses the Microsoft Teams native app download / opening prompt.
   * Forces the browser to select the web client.
   */
  async bypassAppLandingPage() {
    console.log('[TeamsBot] Checking for "Open in app" landing page...');
    try {
      // Teams landing page requires a moment to load and present button options
      await this.page.waitForSelector(SELECTORS.join.joinOnWebBtn, { timeout: 15000 });
      console.log('[TeamsBot] Landing page button found. Attempting click...');
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        // Try Playwright click (which understands Playwright-style selectors)
        await this.page.click(SELECTORS.join.joinOnWebBtn, { force: true, timeout: 2000 }).catch(() => {});
        
        // Try JS-level click using standard browser-native element matching
        await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const target = btns.find(btn => {
            const text = btn.textContent || '';
            const dataTid = btn.getAttribute('data-tid') || '';
            return dataTid === 'joinOnWeb' || 
                   text.includes('Use Teams on the web') || 
                   text.includes('Continue on this browser');
          });
          if (target) {
            target.click();
            target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }).catch(() => {});
        
        // Wait and check if the button is gone or if name input is visible
        await this.page.waitForTimeout(2000);
        
        const isStillVisible = await this.page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          const target = btns.find(btn => {
            const text = btn.textContent || '';
            const dataTid = btn.getAttribute('data-tid') || '';
            return dataTid === 'joinOnWeb' || 
                   text.includes('Use Teams on the web') || 
                   text.includes('Continue on this browser');
          });
          return !!(target && (target.offsetWidth > 0 || target.offsetHeight > 0));
        });
        
        if (!isStillVisible) {
          console.log('[TeamsBot] Successfully bypassed landing page (button is gone).');
          break;
        }
        console.log(`[TeamsBot] Landing page button still visible (attempt ${attempt}/3). Retrying click...`);
      }
      
      // Extra buffer wait for loading pre-join page
      await this.page.waitForTimeout(3000);
    } catch (e) {
      console.log('[TeamsBot] App landing bypass check completed or error encountered:', e.message);
      console.error('[TeamsBot] App landing error details:', e);
    }
  }

  /**
   * Enters the guest display name if the name input field is visible.
   */
  async handleNameInput() {
    if (!this.isGuest) return;

    console.log('[TeamsBot] Checking for guest display name input field...');
    try {
      const selector = SELECTORS.join.nameInput;
      await this.page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
      console.log(`[TeamsBot] Guest name input found. Typing bot name: ${this.botName}`);
      
      await this.page.focus(selector);
      await this.page.fill(selector, this.botName);
      await this.page.waitForTimeout(1000);
    } catch (err) {
      console.warn('[TeamsBot] Guest name input field not found or not interactable:', err.message);
      try {
        const screenshotPath = path.resolve(path.dirname(this.authPath), 'error_screenshot.png');
        await this.page.screenshot({ path: screenshotPath });
        console.log(`[TeamsBot] Saved debug screenshot of the page to: ${screenshotPath}`);
      } catch (screenshotErr) {
        console.error('[TeamsBot] Failed to take debug screenshot:', screenshotErr.message);
      }
    }
  }

  /**
   * Helper debug function to dump all buttons and inputs on the pre-join screen
   */
  async dumpPreJoinElements() {
    console.log('[TeamsBot] [DEBUG] Dumping pre-join page elements...');
    try {
      const elements = await this.page.$$eval('button, div[role="button"], input', els => els.map(el => ({
        tagName: el.tagName,
        text: el.textContent?.trim().slice(0, 80),
        ariaLabel: el.getAttribute('aria-label'),
        id: el.id,
        class: el.className,
        role: el.getAttribute('role'),
        ariaChecked: el.getAttribute('aria-checked') || el.getAttribute('aria-pressed'),
        dataTid: el.getAttribute('data-tid') || el.getAttribute('data-testid')
      })));
      console.log('[TeamsBot] [DEBUG] Clickable elements dump:', JSON.stringify(elements, null, 2));
    } catch (e) {
      console.error('[TeamsBot] [DEBUG] Failed to dump pre-join elements:', e.message);
    }
  }

  /**
   * Disables camera and microphone settings in the pre-join dashboard
   */
  async handleMediaToggles() {
    console.log('[TeamsBot] Configuring media device toggles...');
    
    // Dump page elements to discover latest Teams selectors
    await this.dumpPreJoinElements();

    // Toggle video off
    try {
      const videoSwitch = await this.page.$('input[data-tid="toggle-video"], button[data-tid="prejoin-play-video"]');
      if (videoSwitch) {
        const isChecked = await videoSwitch.evaluate(el => el.checked || el.getAttribute('aria-checked') === 'true');
        if (isChecked) {
          console.log('[TeamsBot] Video is enabled. Clicking to toggle OFF...');
          await videoSwitch.click({ force: true }).catch(() => {});
          await videoSwitch.evaluate(el => { if (el.checked || el.getAttribute('aria-checked') === 'true') el.click(); });
        } else {
          console.log('[TeamsBot] Video is already disabled.');
        }
      } else {
        console.log('[TeamsBot] Video toggle switch not found. Pressing Ctrl+Shift+O fallback...');
        await this.page.bringToFront().catch(() => {});
        await this.page.focus('body').catch(() => {});
        await this.page.keyboard.press('Control+Shift+o');
      }
    } catch (err) {
      console.error('[TeamsBot] Error disabling video:', err.message);
    }

    // Toggle mic off
    try {
      const micSwitch = await this.page.$('input[data-tid="toggle-mute"], button[data-tid="prejoin-mute-mic"]');
      if (micSwitch) {
        const isChecked = await micSwitch.evaluate(el => el.checked || el.getAttribute('aria-checked') === 'true');
        if (isChecked) {
          console.log('[TeamsBot] Microphone is enabled. Clicking to toggle OFF...');
          await micSwitch.click({ force: true }).catch(() => {});
          await micSwitch.evaluate(el => { if (el.checked || el.getAttribute('aria-checked') === 'true') el.click(); });
        } else {
          console.log('[TeamsBot] Microphone is already disabled.');
        }
      } else {
        console.log('[TeamsBot] Mic toggle switch not found. Pressing Ctrl+Shift+M fallback...');
        await this.page.bringToFront().catch(() => {});
        await this.page.focus('body').catch(() => {});
        await this.page.keyboard.press('Control+Shift+m');
      }
    } catch (err) {
      console.error('[TeamsBot] Error disabling microphone:', err.message);
    }
    
    await this.page.waitForTimeout(1000);
  }

  async clickJoinNow() {
    console.log('[TeamsBot] Attempting to click "Join now"...');
    try {
      const selector = SELECTORS.join.joinNowBtn;
      await this.page.waitForSelector(selector, { state: 'visible', timeout: 10000 });
      
      for (let attempt = 1; attempt <= 3; attempt++) {
        // Try Playwright click
        await this.page.click(selector, { force: true, timeout: 2000 }).catch(() => {});
        
        // Try JS-level click with full mouse event dispatch sequence (mousedown -> mouseup -> click)
        await this.page.evaluate(() => {
          const btn = document.querySelector('button[data-tid="prejoin-join-button"]');
          if (btn) {
            btn.click();
            btn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
            btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
        }).catch(() => {});
        
        // Wait to see if we transitioned
        await this.page.waitForTimeout(3000);
        
        // Check if button is still visible/present
        const isStillVisible = await this.page.evaluate(() => {
          const btn = document.querySelector('button[data-tid="prejoin-join-button"]');
          return !!(btn && (btn.offsetWidth > 0 || btn.offsetHeight > 0));
        });
        
        if (!isStillVisible) {
          console.log('[TeamsBot] Successfully clicked "Join now" (button is gone).');
          return;
        }
        
        console.log(`[TeamsBot] "Join now" button still visible (attempt ${attempt}/3). Retrying click...`);
      }
      
      // Fallback: press Enter on the page
      console.log('[TeamsBot] Pressing Enter key as final fallback...');
      await this.page.keyboard.press('Enter');
    } catch (err) {
      console.error('[TeamsBot] Fatal error clicking "Join now":', err.message);
    }
  }

  /**
   * Monitored polling to check if we are in the lobby and wait for approval.
   * Throws an error if denied or if lobby timeout is reached.
   */
  async handleLobbyAdmission() {
    console.log('[TeamsBot] Verifying connection/lobby state...');
    const startTime = Date.now();
    let checks = 0;
    
    while (Date.now() - startTime < TIMEOUTS.join) {
      checks++;
      
      // Check multiple indicators for inside-the-call state
      const hangupBtn = await this.page.$(SELECTORS.inCall.leaveBtn).catch(() => null);
      const hangupVisible = hangupBtn ? await hangupBtn.isVisible().catch(() => false) : false;

      const callingScreen = await this.page.$(SELECTORS.inCall.callingScreen).catch(() => null);
      const callingScreenVisible = callingScreen ? await callingScreen.isVisible().catch(() => false) : false;

      // Microphone button is another extremely robust call indicator
      const micBtn = await this.page.$('button#microphone-button').catch(() => null);
      const micBtnVisible = micBtn ? await micBtn.isVisible().catch(() => false) : false;

      console.log(`[TeamsBot] [Status Check] In-Call Elements: hangupVisible=${hangupVisible}, callingScreenVisible=${callingScreenVisible}, micBtnVisible=${micBtnVisible}`);

      if (hangupVisible || callingScreenVisible || micBtnVisible) {
        console.log('[TeamsBot] Successfully entered the meeting call (detected in-call indicators)!');
        return;
      }

      // Check lobby state elements
      const lobbyText = await this.page.$(SELECTORS.lobby.waitingText).catch(() => null);
      const lobbyTextVisible = lobbyText ? await lobbyText.isVisible().catch(() => false) : false;

      const lobbyContainer = await this.page.$(SELECTORS.lobby.lobbyContainer).catch(() => null);
      const lobbyContainerVisible = lobbyContainer ? await lobbyContainer.isVisible().catch(() => false) : false;

      console.log(`[TeamsBot] [Status Check] Lobby Elements: lobbyTextVisible=${lobbyTextVisible}, lobbyContainerVisible=${lobbyContainerVisible}`);

      if (lobbyTextVisible || lobbyContainerVisible) {
        console.log('[TeamsBot] Currently in the lobby. Waiting for admission...');
      } else {
        console.log('[TeamsBot] Transitioning states or on pre-join screen. Checking status...');
        if (checks === 4) {
          try {
            const screenshotPath = path.resolve(path.dirname(this.authPath), 'lobby_transition_screenshot.png');
            await this.page.screenshot({ path: screenshotPath });
            console.log(`[TeamsBot] Saved lobby transition screenshot to: ${screenshotPath}`);
          } catch (sErr) {}
        }
      }

      await this.page.waitForTimeout(TIMEOUTS.lobbyPoll);
    }

    throw new Error(`[TeamsBot] Failed to join call: Lobby admission timeout of ${TIMEOUTS.join}ms reached.`);
  }

  /**
   * Save the current browser context credentials and session state to auth.json
   */
  async saveSession() {
    if (!this.context) {
      throw new Error('No browser context active to save session.');
    }
    
    // Ensure parent directory exists
    const dir = path.dirname(this.authPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`[TeamsBot] Saving active session state to: ${this.authPath}`);
    await this.context.storageState({ path: this.authPath });
    console.log('[TeamsBot] Session saved successfully.');
  }

  async openChat() {
    try {
      // Check if chat panel input or chat pane is ALREADY open and visible
      const existingInput = await this.page.$('div[role="textbox"], [data-tid="chat-pane-list"], .fui-ChatMessageList, [data-tid="chat-input-textbox"]');
      if (existingInput && await existingInput.isVisible()) {
        console.log('[TeamsBot] [CHAT LOG] Chat panel is ALREADY open.');
        return true;
      }

      console.log('[TeamsBot] [CHAT LOG] Chat panel is closed. Searching for Chat toggle button via accessibility...');

      // One-time diagnostic: log first 40 buttons/menuitems on page and frames
      try {
        let loggedCount = 0;
        const diagFrames = [this.page, ...this.page.frames()];
        for (const frame of diagFrames) {
          if (loggedCount >= 40) break;
          const roles = ['button', 'menuitem'];
          for (const r of roles) {
            if (loggedCount >= 40) break;
            const elements = await frame.getByRole(r).all().catch(() => []);
            for (const el of elements) {
              if (loggedCount >= 40) break;
              if (await el.isVisible().catch(() => false)) {
                const name = (await el.textContent().catch(() => '')) || '';
                const ariaLabel = (await el.getAttribute('aria-label').catch(() => '')) || '';
                const cleanName = name.trim().replace(/\s+/g, ' ');
                console.log(`[TeamsBot] [CHAT LOG][DIAGNOSTIC] role=${r} name="${cleanName}" aria-label="${ariaLabel}"`);
                loggedCount++;
              }
            }
          }
        }
      } catch (diagErr) {
        console.warn('[TeamsBot] [CHAT LOG][DIAGNOSTIC] Error running diagnostic:', diagErr.message);
      }
      
      // Zoom out viewport slightly so top controls fit without overflow truncation
      await this.page.evaluate(() => {
        document.body.style.zoom = '0.85';
      }).catch(() => {});

      // Fallback 1: Try Teams Chat keyboard shortcuts (Ctrl+Shift+C / Alt+Shift+C)
      console.log('[TeamsBot] [CHAT LOG] openChat: trying Teams keyboard shortcuts (Ctrl+Shift+C)...');
      await this.page.keyboard.press('Control+Shift+C').catch(() => {});
      await this.page.waitForTimeout(800);
      let checkInput = await this.page.$('div[role="textbox"], [data-tid="chat-pane-list"], .fui-ChatMessageList');
      if (checkInput && await checkInput.isVisible().catch(() => false)) {
        console.log('[TeamsBot] [CHAT LOG] openChat: Chat opened via Ctrl+Shift+C shortcut!');
        return true;
      }

      const frames = [this.page, ...this.page.frames()];

      // Step 1: Direct CSS selector match for Teams Chat button (#chat-button, button:has-text("Chat"), aria-label="*conversation*")
      const directSelectors = [
        '#chat-button',
        '[data-tid="chat-button"]',
        'button#chat-button',
        'button:has-text("Chat")',
        'button[aria-label*="conversation" i]',
        'button[aria-label*="chat" i]'
      ];

      for (const frame of frames) {
        for (const sel of directSelectors) {
          try {
            const btn = await frame.$(sel);
            if (btn && await btn.isVisible().catch(() => false)) {
              const textContent = (await btn.textContent().catch(() => '')) || '';
              const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
              const nameText = (ariaLabel || textContent).trim();

              if (/chat bubble/i.test(nameText) || /chat bubbles/i.test(nameText)) {
                continue;
              }

              console.log(`[TeamsBot] [CHAT LOG] openChat: clicked Chat button via direct selector "${sel}" ("${nameText}")`);
              await btn.click({ force: true }).catch(() => {});
              await this.page.waitForTimeout(1500);
              return true;
            }
          } catch {}
        }
      }
      
      // Step 2: Role locator match for /chat|conversation/i
      for (const frame of frames) {
        try {
          const locators = frame.getByRole('button', { name: /chat|conversation/i });
          const count = await locators.count().catch(() => 0);
          
          for (let i = 0; i < count; i++) {
            const btn = locators.nth(i);
            if (await btn.isVisible().catch(() => false)) {
              const ariaLabel = (await btn.getAttribute('aria-label').catch(() => '')) || '';
              const textContent = (await btn.textContent().catch(() => '')) || '';
              const nameText = (ariaLabel || textContent).trim();

              if (/chat bubble/i.test(nameText) || /chat bubbles/i.test(nameText)) {
                continue;
              }

              console.log(`[TeamsBot] [CHAT LOG] openChat: matched button via role: "${nameText || 'Chat'}"`);
              await btn.click({ force: true }).catch(() => {});
              await this.page.waitForTimeout(1500);
              return true;
            }
          }
        } catch {}
      }

      console.warn('[TeamsBot] [CHAT LOG] openChat: no chat button found in any frame. Searching under More menu...');

      // Fallback: Click "More" button and check menuitems for Chat
      for (const frame of frames) {
        try {
          const moreLocators = frame.getByRole('button', { name: /^more$/i });
          const moreCount = await moreLocators.count().catch(() => 0);

          for (let i = 0; i < moreCount; i++) {
            const moreBtn = moreLocators.nth(i);
            if (await moreBtn.isVisible().catch(() => false)) {
              console.log('[TeamsBot] [CHAT LOG] openChat: clicking More button...');
              await moreBtn.click({ force: true }).catch(() => {});
              await this.page.waitForTimeout(1000);

              // Search for menuitem matching /chat/i excluding /chat bubble/i
              for (const searchFrame of frames) {
                try {
                  const itemLocators = searchFrame.getByRole('menuitem', { name: /chat/i });
                  const itemMatches = await itemLocators.count().catch(() => 0);

                  for (let j = 0; j < itemMatches; j++) {
                    const item = itemLocators.nth(j);
                    if (await item.isVisible().catch(() => false)) {
                      const ariaLabel = (await item.getAttribute('aria-label').catch(() => '')) || '';
                      const textContent = (await item.textContent().catch(() => '')) || '';
                      const nameText = (ariaLabel || textContent).trim();

                      if (/chat bubble/i.test(nameText) || /chat bubbles/i.test(nameText)) {
                        continue;
                      }

                      console.log('[TeamsBot] [CHAT LOG] openChat: found Chat under More menu');
                      await item.click({ force: true }).catch(() => {});
                      await this.page.waitForTimeout(1500);
                      return true;
                    }
                  }
                } catch {}
              }
              break;
            }
          }
        } catch {}
      }

      console.warn('[TeamsBot] [CHAT LOG] openChat: no Chat option found in More menu either');
    } catch (err) {
      console.warn('[TeamsBot] [CHAT LOG] Failed to open chat panel:', err.message);
    }
    return false;
  }

  async findChatInput() {
    const inputSelectors = [
      '[data-tid="ck-editor-reply-input"]',
      '[data-tid="chat-input-textbox"]',
      '[data-tid="message-input"]',
      'div[role="textbox"][aria-label*="Type a message" i]',
      'div[role="textbox"][aria-label*="message" i]',
      'div[role="textbox"]',
      'div[contenteditable="true"][aria-label*="Type a message" i]',
      'div[contenteditable="true"][aria-label*="message" i]',
      'div[contenteditable="true"]',
      'div.ck-content',
      'div.ck-editor__editable',
      '[data-tid="new-message-textarea"]',
      'div[data-tid*="chat-input"]',
      'div[data-tid*="message-input"]',
      'p.ck-placeholder',
      'textarea',
      '.fui-ChatMessageInput'
    ];

    console.log('[TeamsBot] [CHAT LOG] Searching for chat input element across selectors (retrying up to 5s)...');
    const frames = [this.page, ...this.page.frames()];

    for (let attempt = 1; attempt <= 6; attempt++) {
      // Step 1: Check CSS selectors across page & frames
      for (const frame of frames) {
        for (const sel of inputSelectors) {
          try {
            const input = await frame.$(sel);
            if (input && await input.isVisible().catch(() => false)) {
              console.log(`[TeamsBot] [CHAT LOG] Found visible chat input via selector: "${sel}" (attempt ${attempt})`);
              return { input, sel, frame: frame === this.page ? null : frame };
            }
          } catch {}
        }
      }

      // Step 2: In-browser DOM evaluator to find ANY editable text input or chat textarea
      for (const frame of frames) {
        try {
          const matchHandle = await frame.evaluateHandle(() => {
            const all = Array.from(document.querySelectorAll('*'));
            // Find visible editable or textbox element
            const found = all.find(el => {
              const isVis = el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
              if (!isVis) return false;

              const isEditable = el.isContentEditable || el.tagName === 'TEXTAREA';
              const role = (el.getAttribute('role') || '').toLowerCase();
              const aria = (el.getAttribute('aria-label') || '').toLowerCase();
              const tid = (el.getAttribute('data-tid') || '').toLowerCase();

              return isEditable || role === 'textbox' || aria.includes('type a message') || tid.includes('reply-input') || tid.includes('chat-input');
            });
            return found || null;
          }).catch(() => null);

          if (matchHandle && matchHandle.asElement()) {
            const el = matchHandle.asElement();
            const tag = await el.evaluate(e => e.tagName).catch(() => '');
            const aria = await el.getAttribute('aria-label').catch(() => '');
            const tid = await el.getAttribute('data-tid').catch(() => '');
            console.log(`[TeamsBot] [CHAT LOG] Found visible chat input via in-browser DOM evaluator: tag=${tag} data-tid="${tid}" aria-label="${aria}" (attempt ${attempt})`);
            return { input: el, sel: `evaluator(tag=${tag},tid=${tid})`, frame: frame === this.page ? null : frame };
          }
        } catch {}
      }

      // Diagnostic dump on attempt 2 if input not yet matched
      if (attempt === 2) {
        try {
          console.log('[TeamsBot] [CHAT LOG][DIAGNOSTIC] Scanning DOM for candidate input elements...');
          for (const frame of frames) {
            const report = await frame.evaluate(() => {
              return Array.from(document.querySelectorAll('*'))
                .filter(el => (el.offsetWidth > 0 || el.offsetHeight > 0) && (
                  el.isContentEditable || el.tagName === 'TEXTAREA' || (el.getAttribute('role') || '') === 'textbox' ||
                  (el.getAttribute('data-tid') || '').includes('chat') || (el.getAttribute('data-tid') || '').includes('message')
                ))
                .map(el => ({
                  tag: el.tagName,
                  dataTid: el.getAttribute('data-tid'),
                  aria: el.getAttribute('aria-label'),
                  cls: (el.className || '').toString().slice(0, 30),
                  isEditable: el.isContentEditable
                }));
            }).catch(() => []);

            for (const r of report) {
              console.log(`[TeamsBot] [CHAT LOG][DIAGNOSTIC] candidate tag=${r.tag} aria="${r.aria}" tid="${r.dataTid}" editable=${r.isEditable} cls="${r.cls}"`);
            }
          }
        } catch (dErr) {
          console.warn('[TeamsBot] [CHAT LOG][DIAGNOSTIC] Error scanning input candidates:', dErr.message);
        }
      }

      await this.page.waitForTimeout(800);
    }
    return null;
  }

  async findSendButton() {
    const sendBtnSelectors = [
      'button[data-tid="send-message-button"]',
      'button[aria-label*="Send" i]',
      'button[aria-label*="send message" i]',
      'button[title*="Send" i]',
      'button[aria-label*="submit" i]',
      'button.fui-Button[aria-label*="Send" i]',
      'button:has(svg[data-icon-name*="Send" i])',
      'button[id*="send" i]',
      '[data-tid="chat-input-send-button"]'
    ];
    for (const sel of sendBtnSelectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          return { btn, sel, frame: null };
        }
      } catch {}
      for (const frame of this.page.frames()) {
        try {
          const btn = await frame.$(sel);
          if (btn && await btn.isVisible()) {
            return { btn, sel, frame };
          }
        } catch {}
      }
    }
    return null;
  }

  async sendChatMessage(text) {
    try {
      console.log('[TeamsBot] [CHAT LOG] Preparing to send chat message...');
      await this.openChat();

      const found = await this.findChatInput();
      if (found) {
        const { input, sel, frame } = found;
        const pageOrFrame = frame || this.page;
        console.log(`[TeamsBot] [CHAT LOG] Typing message text: "${text.slice(0, 60).replace(/\n/g, ' ')}..."`);

        await input.scrollIntoViewIfNeeded().catch(() => {});
        await input.click({ force: true }).catch(() => {});
        await input.focus().catch(() => {});

        // Clear any draft text
        await input.evaluate(el => { el.textContent = ''; }).catch(() => {});

        // Use insertText so multiline text pastes correctly without premature Enter submit
        await pageOrFrame.keyboard.insertText(text);
        await this.page.waitForTimeout(500);

        // Find send button or press Control+Enter / Enter
        const sendBtnFound = await this.findSendButton();
        if (sendBtnFound) {
          console.log(`[TeamsBot] [CHAT LOG] Clicking Send button via: "${sendBtnFound.sel}"`);
          await sendBtnFound.btn.click({ force: true }).catch(() => {});
          await this.page.waitForTimeout(300);
        }
        
        console.log('[TeamsBot] [CHAT LOG] Dispatching Control+Enter and Enter submission keys...');
        await pageOrFrame.keyboard.press('Control+Enter').catch(() => {});
        await pageOrFrame.keyboard.press('Enter').catch(() => {});

        await this.page.waitForTimeout(1000);
        console.log('[TeamsBot] [CHAT LOG] Chat message dispatch sequence completed successfully.');
        return true;
      }

      console.warn('[TeamsBot] [CHAT LOG] ERROR: Teams chat input field not found or not visible after 5s retry.');
    } catch (err) {
      console.warn('[TeamsBot] [CHAT LOG] Error sending chat message:', err.message);
    }
    return false;
  }

  async readLatestChatMessages() {
    try {
      if (!this.page) return [];
      const selectors = '[data-tid="chat-pane-message"], .fui-ChatMessage, [data-tid="message-body"], div[role="listitem"] [data-tid="message-text"]';
      const messages = await this.page.$$eval(selectors, els => {
        return els.map(el => el.textContent?.trim()).filter(Boolean);
      });
      return messages;
    } catch {
      return [];
    }
  }

  /**
   * Leave the call and clean up browser instances
   */
  async leave() {
    try {
      console.log('[TeamsBot] [LEAVE] Initiating leave sequence.');
      
      // Take pre-leave screenshot if page is available
      if (this.page && !this.page.isClosed()) {
        const beforePicPath = 'C:\\Users\\IshitaBhojani\\.gemini\\antigravity-ide\\brain\\b3046ec9-e9ff-476f-8255-4ba860bd50de\\leave_before.png';
        console.log(`[TeamsBot] [LEAVE] Saving pre-leave screenshot to: ${beforePicPath}`);
        await this.page.screenshot({ path: beforePicPath }).catch(err => {
          console.warn('[TeamsBot] [LEAVE] Failed to take pre-leave screenshot:', err.message);
        });
      }

      const selectors = [
        'button#hangup-button',
        'button[data-tid="hangup-button"]',
        'button[aria-label*="Leave" i]',
        'button[aria-label*="Hang up" i]',
        'button:has-text("Leave")',
        'button:has-text("Hang up")',
        'button[data-tid="prejoin-cancel-button"]',
        'button:has-text("Cancel")'
      ];

      let clicked = false;
      for (const sel of selectors) {
        try {
          const btn = this.page.locator(sel).first();
          if (btn && await btn.isVisible()) {
            console.log(`[TeamsBot] [LEAVE] Found button with selector: ${sel}`);
            
            try {
              console.log(`[TeamsBot] [LEAVE] Attempting standard Playwright click on: ${sel}`);
              await btn.click({ force: true, timeout: 2000 });
              console.log(`[TeamsBot] [LEAVE] Standard click on ${sel} completed.`);
              clicked = true;
            } catch (clickErr) {
              console.log(`[TeamsBot] [LEAVE] Playwright click failed: ${clickErr.message}. Attempting JS mouse event sequence...`);
              await this.page.evaluate((s) => {
                let el;
                if (s.includes(':has-text')) {
                  const match = s.match(/:has-text\("([^"]+)"\)/);
                  const text = match ? match[1] : '';
                  const btns = Array.from(document.querySelectorAll('button, div[role="button"]'));
                  el = btns.find(b => (b.textContent || '').includes(text));
                } else {
                  el = document.querySelector(s);
                }
                if (el) {
                  el.focus();
                  el.click();
                  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
                  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
              }, sel);
              console.log(`[TeamsBot] [LEAVE] JS mouse event click sequence executed.`);
              clicked = true;
            }

            if (clicked) {
              await this.page.waitForTimeout(2000);
              break;
            }
          }
        } catch (selErr) {
          console.warn(`[TeamsBot] [LEAVE] Error evaluating selector ${sel}:`, selErr.message);
        }
      }

      if (!clicked) {
        console.warn('[TeamsBot] [LEAVE] No visible leave button found in the page context.');
      } else {
        // Take post-leave screenshot if page is still open
        if (this.page && !this.page.isClosed()) {
          const afterPicPath = 'C:\\Users\\IshitaBhojani\\.gemini\\antigravity-ide\\brain\\b3046ec9-e9ff-476f-8255-4ba860bd50de\\leave_after.png';
          console.log(`[TeamsBot] [LEAVE] Saving post-leave screenshot to: ${afterPicPath}`);
          await this.page.screenshot({ path: afterPicPath }).catch(err => {
            console.warn('[TeamsBot] [LEAVE] Failed to take post-leave screenshot (page may have already closed):', err.message);
          });
        }
      }
    } catch (err) {
      console.warn('[TeamsBot] [LEAVE] Exception in leave sequence:', err.message);
    }
    
    await this.close();
  }

  /**
   * Close page, context, and browser instance
   */
  async close() {
    try {
      if (this.page) await this.page.close().catch(() => {});
      if (this.context) await this.context.close().catch(() => {});
      if (this.browser) await this.browser.close().catch(() => {});
    } catch (err) {
      console.error('[TeamsBot] Error during close cleanup:', err.message);
    }
  }

  getPage() {
    return this.page;
  }
}
