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
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1280,720',
      ],
    };

    if (this.channel) {
      launchOptions.channel = this.channel;
    }

    console.log(`[TeamsBot] Launching browser (headless: ${this.headless}, channel: ${this.channel || 'default'})`);

    // Strict startup verification: fail early if credentials/session file is missing in normal mode
    if (!this.isLoginMode) {
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
      viewport: { width: 1280, height: 720 },
    };

    if (!this.isLoginMode) {
      console.log(`[TeamsBot] Loading session state from ${this.authPath}`);
      contextOptions.storageState = this.authPath;
    }

    this.context = await this.browser.newContext(contextOptions);
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

    // 1. Bypass "Open Microsoft Teams" landing page to use the web client
    await this.bypassAppLandingPage();

    // 2. Disable camera and microphone in the pre-join lobby
    await this.handleMediaToggles();

    // 3. Click "Join now"
    await this.clickJoinNow();

    // 4. Handle lobby wait / admission
    await this.handleLobbyAdmission();
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
      console.log('[TeamsBot] Landing page button found. Clicking web client join button...');
      await this.page.click(SELECTORS.join.joinOnWebBtn);
      
      // Wait for navigation / rendering of pre-join screen
      await this.page.waitForTimeout(5000);
    } catch (e) {
      console.log('[TeamsBot] No web client join button visible or already bypassed.');
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

    // We try to turn off camera first
    try {
      const camBtn = await this.page.waitForSelector(SELECTORS.join.camToggle, { timeout: 8000 }).catch(() => null);
      if (camBtn && await camBtn.isVisible()) {
        const ariaChecked = await camBtn.getAttribute('aria-checked');
        const ariaPressed = await camBtn.getAttribute('aria-pressed');
        if (ariaChecked === 'true' || ariaPressed === 'true') {
          console.log('[TeamsBot] Camera is enabled. Clicking to toggle OFF...');
          await camBtn.click();
          await this.page.waitForTimeout(1000);
        } else {
          console.log('[TeamsBot] Camera appears to be already disabled.');
        }
      } else {
        // Fallback to keyboard shortcut if buttons aren't visible
        console.log('[TeamsBot] Cam toggle button not found. Using Ctrl+Shift+O fallback...');
        await this.page.keyboard.press('Control+Shift+o');
        await this.page.waitForTimeout(1000);
      }
    } catch (err) {
      console.error('[TeamsBot] Error disabling camera:', err.message);
    }

    // Turn off mic
    try {
      const micBtn = await this.page.waitForSelector(SELECTORS.join.micToggle, { timeout: 5000 }).catch(() => null);
      if (micBtn && await micBtn.isVisible()) {
        const ariaChecked = await micBtn.getAttribute('aria-checked');
        const ariaPressed = await micBtn.getAttribute('aria-pressed');
        if (ariaChecked === 'true' || ariaPressed === 'true') {
          console.log('[TeamsBot] Microphone is enabled. Clicking to toggle OFF...');
          await micBtn.click();
          await this.page.waitForTimeout(1000);
        } else {
          console.log('[TeamsBot] Microphone appears to be already disabled.');
        }
      } else {
        // Fallback to keyboard shortcut
        console.log('[TeamsBot] Mic toggle button not found. Using Ctrl+Shift+M fallback...');
        await this.page.keyboard.press('Control+Shift+m');
        await this.page.waitForTimeout(1000);
      }
    } catch (err) {
      console.error('[TeamsBot] Error disabling microphone:', err.message);
    }
  }

  async clickJoinNow() {
    console.log('[TeamsBot] Attempting to click "Join now"...');
    try {
      await this.page.waitForSelector(SELECTORS.join.joinNowBtn, { state: 'visible', timeout: 10000 });
      await this.page.click(SELECTORS.join.joinNowBtn);
      console.log('[TeamsBot] Success: Clicked "Join now" button.');
    } catch (err) {
      console.log('[TeamsBot] "Join now" button not found or not clickable via selectors:', err.message);
      console.log('[TeamsBot] Triggering fallback: Pressing [Enter] key to submit pre-join form...');
      await this.page.keyboard.press('Enter');
      console.log('[TeamsBot] Fallback [Enter] key pressed.');
    }
  }

  /**
   * Monitored polling to check if we are in the lobby and wait for approval.
   * Throws an error if denied or if lobby timeout is reached.
   */
  async handleLobbyAdmission() {
    console.log('[TeamsBot] Verifying connection/lobby state...');
    const startTime = Date.now();
    
    while (Date.now() - startTime < TIMEOUTS.join) {
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

  /**
   * Leave the call and clean up browser instances
   */
  async leave() {
    try {
      console.log('[TeamsBot] Leaving meeting...');
      const leaveBtn = await this.page.$(SELECTORS.inCall.leaveBtn);
      if (leaveBtn) {
        await leaveBtn.click();
        await this.page.waitForTimeout(1000);
      }
    } catch (err) {
      console.warn('[TeamsBot] Error clicking leave button:', err.message);
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
