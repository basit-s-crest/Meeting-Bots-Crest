import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELECTORS, TIMEOUTS } from '../config/selectors.js';

export class MeetBot {
  constructor(meetingUrl, botName = 'Meeting Bot', options = {}) {
    this.meetingUrl = meetingUrl;
    this.botName = botName;
    this.headless = options.headless !== false;
    this.channel = options.channel || null;
    
    // Resolve auth.json path
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const defaultAuthPath = path.resolve(__dirname, '../../auth.json');
    this.authPath = path.resolve(options.authPath || defaultAuthPath);

    this.browser = null;
    this.page = null;
    this.context = null;
    this.isLoginMode = options.isLoginMode === true;
  }

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

    const loadSession = !this.isLoginMode;

    if (loadSession) {
      if (!fs.existsSync(this.authPath)) {
        console.error(`\n[MeetBot] ERROR: Saved session file (auth.json) not found at expected path: ${this.authPath}`);
        console.error('[MeetBot] To create this session, please run first:');
        console.error('    node src/index.js --login');
        console.error('[MeetBot] Exiting process to avoid unauthenticated runtime failure.\n');
        throw new Error(`CRITICAL: Saved session state (auth.json) not found at: ${this.authPath}`);
      }
    }

    console.log(`[MeetBot] Launching browser (headless: ${this.headless}, channel: ${this.channel || 'default'})`);
    this.browser = await chromium.launch(launchOptions);

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      permissions: ['microphone', 'camera'],
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
    };

    if (loadSession) {
      console.log(`[MeetBot] Loading session state from ${this.authPath}`);
      contextOptions.storageState = this.authPath;
    }

    this.context = await this.browser.newContext(contextOptions);

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUTS.navigation);
    
    // Log console messages
    this.page.on('console', msg => console.log(`[PAGE] ${msg.text()}`));
    this.page.on('pageerror', err => console.error(`[PAGE ERROR] ${err.message}`));
  }

  async join() {
    console.log(`Navigating to ${this.meetingUrl}`);
    await this.page.goto(this.meetingUrl, { waitUntil: 'domcontentloaded' });
    
    // Wait for the page to load initial UI elements (mic/cam toggles, name input, or join button)
    console.log('Waiting for pre-join UI to load...');
    try {
      await this.page.waitForSelector([
        'button[aria-label*="camera" i]',
        'button[aria-label*="video" i]',
        'input[placeholder="Your name"]',
        'button:has-text("Ask to join")',
        'button:has-text("Join now")',
        'button:has-text("Return to home screen")'
      ].join(','), { timeout: 15000 });
    } catch (e) {
      console.log('Timeout waiting for pre-join elements, proceeding anyway...');
    }
    
    // Debug: check where we actually landed
    const url = this.page.url();
    const title = await this.page.title();
    console.log(`Actual URL: ${url}`);
    console.log(`Page title: ${title}`);
    
    console.log('Page loaded, handling pre-join...');

    // Debug: dump page content to see what's there
    await this.debugPage();

    await this.handlePreJoin();
    await this.waitForInCall();
  }

  async debugPage() {
    // Get all visible buttons and inputs
    const buttons = await this.page.$$eval('button:visible', els => els.map(el => ({
      text: el.textContent?.trim().slice(0, 50),
      ariaLabel: el.getAttribute('aria-label'),
      class: el.className
    })));
    console.log('Visible buttons:', JSON.stringify(buttons, null, 2));

    const inputs = await this.page.$$eval('input:visible', els => els.map(el => ({
      placeholder: el.placeholder,
      ariaLabel: el.getAttribute('aria-label'),
      type: el.type,
      class: el.className
    })));
    console.log('Visible inputs:', JSON.stringify(inputs, null, 2));
  }

  async handlePreJoin() {
    // Simple flow: turn off video, click "Ask to join"
    
    // Dismiss overlays early
    await this.dismissDialogs();
    
    // 1. Turn off camera (video)
    console.log('Turning off camera...');
    await this.turnOffCamera();
    
    // 2. Turn off mic
    console.log('Turning off mic...');
    await this.turnOffMic();

    // 3. Fill name if needed
    console.log('Checking for name input...');
    await this.fillNameIfNeeded();

    // 4. Click "Ask to join" button
    console.log('Clicking "Ask to join"...');
    await this.clickAskToJoin();

    // Debug: check page state after click
    await this.debugPage();

    // Dismiss any dialogs after join
    await this.dismissDialogs();

    // Wait for join to process
    console.log('Waiting for join to process...');
    await this.page.waitForTimeout(10000);
  }

  async turnOffCamera() {
    try {
      const selectors = [
        'button[aria-label*="camera" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'button[aria-label*="video" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'div[role="button"][aria-label*="camera" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'div[role="button"][aria-label*="video" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
      ];
      
      for (const sel of selectors) {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          const isMutedAttr = await btn.getAttribute('data-is-muted');
          if (isMutedAttr === 'true') {
            console.log('Camera is already muted (data-is-muted=true)');
            return;
          }
          if (isMutedAttr === 'false') {
            console.log(`Turning off camera via: ${sel} (data-is-muted=false)`);
            await btn.click();
            await this.page.waitForTimeout(500);
            return;
          }

          const ariaLabel = (await btn.getAttribute('aria-label') || '').toLowerCase();
          if (ariaLabel.includes('turn on camera') || ariaLabel.includes('turn on video')) {
            console.log('Camera is already muted (aria-label indicates Turn on)');
            return;
          }
          if (ariaLabel.includes('turn off camera') || ariaLabel.includes('turn off video')) {
            console.log(`Turning off camera via: ${sel}`);
            await btn.click();
            await this.page.waitForTimeout(500);
            return;
          }
        }
      }
      
      // Fallback: press keyboard shortcut Ctrl+E
      console.log('Camera toggle button not found, pressing Ctrl+E as fallback');
      await this.page.bringToFront().catch(() => {});
      await this.page.focus('body').catch(() => {});
      await this.page.keyboard.press('Control+e');
      await this.page.waitForTimeout(500);
    } catch (e) {
      console.log('Camera toggle error:', e.message);
    }
  }

  async turnOffMic() {
    try {
      const selectors = [
        'button[aria-label*="microphone" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'button[aria-label*="mic" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'div[role="button"][aria-label*="microphone" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
        'div[role="button"][aria-label*="mic" i]:not([aria-label*="device" i]):not([aria-label*="settings" i])',
      ];
      
      for (const sel of selectors) {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          const isMutedAttr = await btn.getAttribute('data-is-muted');
          if (isMutedAttr === 'true') {
            console.log('Mic is already muted (data-is-muted=true)');
            return;
          }
          if (isMutedAttr === 'false') {
            console.log(`Turning off mic via: ${sel} (data-is-muted=false)`);
            await btn.click();
            await this.page.waitForTimeout(500);
            return;
          }

          const ariaLabel = (await btn.getAttribute('aria-label') || '').toLowerCase();
          if (ariaLabel.includes('turn on microphone') || ariaLabel.includes('turn on mic') || ariaLabel.includes('unmute')) {
            console.log('Mic is already muted (aria-label indicates Turn on / Unmute)');
            return;
          }
          if (ariaLabel.includes('turn off microphone') || ariaLabel.includes('turn off mic')) {
            console.log(`Turning off mic via: ${sel}`);
            await btn.click();
            await this.page.waitForTimeout(500);
            return;
          }
        }
      }
      
      // Fallback: press keyboard shortcut Ctrl+D
      console.log('Microphone toggle button not found, pressing Ctrl+D as fallback');
      await this.page.bringToFront().catch(() => {});
      await this.page.focus('body').catch(() => {});
      await this.page.keyboard.press('Control+d');
      await this.page.waitForTimeout(500);
    } catch (e) {
      console.log('Mic toggle error:', e.message);
    }
  }

  async fillNameIfNeeded() {
    try {
      const selectors = [
        'input[placeholder="Your name"]',
        'input[aria-label="Your name"]',
        'input[name="name"]',
        'input[autocomplete="name"]',
      ];
      
      for (const sel of selectors) {
        const input = await this.page.$(sel);
        if (input && await input.isVisible()) {
          const value = await input.inputValue();
          if (!value) {
            console.log(`Filling name via: ${sel}`);
            await input.fill(this.botName);
            await this.page.waitForTimeout(500);
          }
          return;
        }
      }
      console.log('No name input found (may be pre-filled or not needed)');
    } catch (e) {
      console.log('Name fill error:', e.message);
    }
  }

  async clickAskToJoin() {
    try {
      // Check if we hit the Google Meet error/block page
      const returnBtn = await this.page.$('button:has-text("Return to home screen"), a:has-text("Return to home screen")');
      if (returnBtn && await returnBtn.isVisible()) {
        throw new Error(
          'Google Meet blocked the bot or guest access is disabled (found "Return to home screen" button). ' +
          'To bypass this block, try running in headful mode with --headful, or use a real Chrome channel with --channel chrome.'
        );
      }

      // Check for "Switch here" button (appears if the bot is already in the call in another context)
      const switchBtn = await this.page.$('button:has-text("Switch here"), div[role="button"]:has-text("Switch here")');
      if (switchBtn && await switchBtn.isVisible()) {
        console.log('[MeetBot] Detected "Switch here" button. Clicking to switch session...');
        await switchBtn.click();
        await this.page.waitForTimeout(3000);
      }

      const selectors = [
        'button:has-text("Ask to join")',
        'button:has-text("Join now")',
        'button[aria-label*="Ask to join" i]',
        'button[aria-label*="Join now" i]',
        'div[role="button"]:has-text("Ask to join")',
        'div[role="button"]:has-text("Join now")',
      ];
      
      for (const sel of selectors) {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          console.log(`Clicking join button via: ${sel}`);
          await btn.click();
          
          // Wait and check if we're still on pre-join
          await this.page.waitForTimeout(3000);
          
          // Check if button is still there (click failed)
          const stillThere = await this.page.$(`${sel}:visible`);
          if (stillThere) {
            console.log('Button still visible after click, trying Enter key...');
            await btn.press('Enter');
            await this.page.waitForTimeout(3000);
          }
          return;
        }
      }
      
      // Check again for error page after selectors check
      const returnBtn2 = await this.page.$('button:has-text("Return to home screen"), a:has-text("Return to home screen")');
      if (returnBtn2 && await returnBtn2.isVisible()) {
        throw new Error(
          'Google Meet blocked the bot or guest access is disabled (found "Return to home screen" button). ' +
          'To bypass this block, try running in headful mode with --headful, or use a real Chrome channel with --channel chrome.'
        );
      }

      // Debug: show all buttons if not found
      console.log('Join button not found with standard selectors');
      await this.debugPage();
      throw new Error('Could not find "Ask to join" button');
    } catch (e) {
      console.log('Join click error:', e.message);
      throw e;
    }
  }

  async dismissDialogs() {
    for (const sel of [SELECTORS.join.gotItBtn, SELECTORS.join.dismissBtn, SELECTORS.join.continueBtn]) {
      try {
        const btn = await this.page.$(sel);
        if (btn && await btn.isVisible()) {
          console.log(`Dismissing dialog via: ${sel}`);
          await btn.click();
          await this.page.waitForTimeout(500);
        }
      } catch { /* ignore */ }
    }
  }

  async waitForInCall() {
    console.log('Waiting for in-call indicator...');
    
    // Wait for participant grid OR video tiles OR call toolbar
    const inCallSelectors = [
      '[role="list"][aria-label*="participant" i]',
      '[data-participant-list]',
      '[aria-label*="People" i]',
      'video:not([muted])',
      '[data-call-toolbar]',
      'button[aria-label*="Leave" i]',
      'button:has-text("Leave call")',
    ];

    try {
      const combinedSelector = inCallSelectors.join(', ');
      await this.page.waitForSelector(combinedSelector, { state: 'visible', timeout: 30000 });
      console.log('Found in-call indicator');
      
      // Secondary in-call check: guarantee camera and microphone are turned off
      await this.turnOffCamera();
      await this.turnOffMic();

      // Hide Meet's native active-speaker "rotating green ring" indicator — it's
      // purely cosmetic and distracting when watching the bot's window. This only
      // removes the visual ring; KUNJSe-based speaker detection still works because
      // it reads the DOM class, not the rendered animation.
      await this.hideSpeakingIndicator();
      return;
    } catch (e) {
      console.log('Timeout waiting for in-call indicators');
    }

    // Check if still on pre-join screen
    const askBtn = await this.page.$('button:has-text("Ask to join"):visible, button:has-text("Join now"):visible');
    if (askBtn) {
      console.log('Still on pre-join screen - join may have failed');
      await this.debugPage();
    }

    // Check for waiting room
    const waitingText = await this.page.locator('text=/waiting for host|host will let you in|ask to join|lobby|waiting room/i').first();
    if (await waitingText.isVisible().catch(() => false)) {
      console.log('Detected waiting room text');
    }

    console.log('Could not confirm in-call state, proceeding anyway...');
    await this.page.waitForTimeout(3000);
  }

  /**
   * Inject CSS to hide Google Meet's native active-speaker indicator (the green
   * pulsing/rotating ring around the speaking participant's tile). Only removes
   * the visual ring — speaker detection via the KUNJSe DOM class is unaffected.
   */
  async hideSpeakingIndicator() {
    try {
      await this.page.addStyleTag({
        content: `
          /* Disable the rotating/pulsing green speaking ring animation */
          [data-speaking="true"],
          [data-is-speaking="true"],
          .a4cOSc,
          .KUNJSe {
            animation: none !important;
          }
          /* Hide the green ring element Meet draws around speaking tiles */
          div[role="listitem"] [data-speaking="true"]::after,
          [jsname="QgSmzd"].KUNJSe {
            animation: none !important;
            box-shadow: none !important;
            outline: none !important;
          }
          /* Broad fallback: kill any infinite animation inside the call surface */
          [data-participant-id] *,
          [role="listitem"] * {
            animation-iteration-count: 1 !important;
            animation-duration: 0.001s !important;
          }
        `
      });
      console.log('[MeetBot] Hid Meet active-speaker indicator ring');
    } catch (err) {
      console.warn('[MeetBot] Could not inject speaking-indicator CSS:', err.message);
    }
  }

  async saveSession() {
    if (!this.context) {
      throw new Error('No browser context active to save session.');
    }
    
    // Ensure parent directory exists
    const dir = path.dirname(this.authPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    console.log(`[MeetBot] Saving active session state to: ${this.authPath}`);
    await this.context.storageState({ path: this.authPath });
    console.log('[MeetBot] Session saved successfully.');
  }

  async leave() {
    try {
      const leaveBtn = await this.page.$('button[aria-label*="Leave" i], button:has-text("Leave call")');
      if (leaveBtn) await leaveBtn.click();
    } catch { /* ignore */ }
    await this.close();
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  getPage() {
    return this.page;
  }
}