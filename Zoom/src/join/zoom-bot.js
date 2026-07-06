import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SELECTORS, TIMEOUTS } from '../config/selectors.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class ZoomBot {
  constructor(meetingUrl, botName = 'Meeting Bot', options = {}) {
    this.meetingUrl = meetingUrl;
    this.botName = botName;
    this.headless = options.headless !== false;
    this.channel = options.channel || null;
    this.userDataDir = options.userDataDir || null;
    this.passcode = options.passcode || null;
    this.browser = null;
    this.page = null;
    this.context = null;
  }

  async launch() {
    const launchOptions = {
      headless: this.headless,
      args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--disable-blink-features=AutomationControlled',
        '--autoplay-policy=no-user-gesture-required',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--window-size=1280,720',
      ],
    };
    if (this.channel) {
      launchOptions.channel = this.channel;
    }

    if (this.userDataDir) {
      console.log(`[Zoom Bot] Launching persistent context in: ${this.userDataDir}`);
      this.context = await chromium.launchPersistentContext(this.userDataDir, {
        ...launchOptions,
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        viewport: { width: 1280, height: 720 },
        permissions: ['microphone', 'camera'],
      });
      this.browser = null;
    } else {
      console.log(`[Zoom Bot] Launching clean browser session...`);
      this.browser = await chromium.launch(launchOptions);
      this.context = await this.browser.newContext({
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        permissions: ['microphone', 'camera'],
        viewport: { width: 1280, height: 720 },
      });
    }

    const pages = this.context.pages();
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.page.setDefaultTimeout(TIMEOUTS.navigation);

    this.page.on('console', msg => console.log(`[ZOOM PAGE] ${msg.text()}`));
    this.page.on('pageerror', err => console.error(`[ZOOM PAGE ERROR] ${err.message}`));
  }

  async join() {
    let joinUrl = this.meetingUrl;

    // If it's a standard join URL (e.g. zoom.us/j/12345), convert to web client join URL
    if (joinUrl.includes('/j/')) {
      joinUrl = joinUrl.replace('/j/', '/wc/join/');
    } else if (joinUrl.includes('/s/')) {
      joinUrl = joinUrl.replace('/s/', '/wc/join/');
    }

    // Append prefer=1 to force web client view, and passcode if supplied
    if (!joinUrl.includes('prefer=')) {
      joinUrl += (joinUrl.includes('?') ? '&' : '?') + 'prefer=1';
    }
    if (this.passcode && !joinUrl.includes('pwd=')) {
      joinUrl += `&pwd=${this.passcode}`;
    }

    console.log(`[Zoom Bot] Navigating to: ${joinUrl}`);
    await this.page.goto(joinUrl, { waitUntil: 'domcontentloaded' });

    // Wait for the join UI components
    console.log('[Zoom Bot] Waiting for join form to load...');
    try {
      await this.page.waitForSelector(`${SELECTORS.join.nameInput}, ${SELECTORS.preJoin.joinBrowserLink}`, { timeout: 15000 });
    } catch {
      console.log('[Zoom Bot] Timeout waiting for standard selectors, checking screen...');
    }

    // Handle "Join from your browser" link if it appears on standard launcher page
    const browserLink = await this.findLocator(SELECTORS.preJoin.joinBrowserLink);
    if (browserLink) {
      console.log('[Zoom Bot] Clicking "Join from your browser" link...');
      await browserLink.click();
      await this.page.waitForTimeout(5000);
    }

    // Handle the join inputs
    await this.handleFormEntry();
  }

  async handleFormEntry() {
    // 1. Fill Name
    const nameInput = await this.findLocator(SELECTORS.join.nameInput);
    if (nameInput) {
      console.log(`[Zoom Bot] Filling display name: ${this.botName}`);
      await nameInput.fill(this.botName);
    }

    // 2. Fill Passcode if needed
    const passcodeInput = await this.findLocator(SELECTORS.join.passcodeInput);
    if (passcodeInput) {
      if (this.passcode) {
        console.log('[Zoom Bot] Filling passcode...');
        await passcodeInput.fill(this.passcode);
      } else {
        console.warn('[Zoom Bot] Meeting asks for passcode, but none was provided!');
      }
    }

    // 3. Click Join button
    const joinBtn = await this.findLocator(SELECTORS.join.joinBtn);
    if (joinBtn) {
      console.log('[Zoom Bot] Clicking "Join" button...');
      await joinBtn.click();
    } else {
      // Fallback: press Enter
      console.log('[Zoom Bot] Join button not found, pressing Enter...');
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForTimeout(5000);
  }

  async isAudioConnected() {
    const muteBtn = await this.findLocator('button:has-text("Mute"), button:has-text("Unmute"), button[aria-label*="mute" i], button[aria-label*="unmute" i]');
    return muteBtn !== null;
  }

  async connectAudio() {
    console.log('[Zoom Bot] Connecting to call audio...');
    
    // 1. Wait a moment and check if audio auto-connected on join
    await this.page.waitForTimeout(3000);
    if (await this.isAudioConnected()) {
      console.log('[Zoom Bot] Audio auto-connected successfully.');
      await this.muteCamera();
      await this.openParticipantsPanel();
      return true;
    }

    // 2. If not auto-connected, click the "Join Audio" button in the footer to trigger the modal
    console.log('[Zoom Bot] Audio not auto-connected. Checking footer Join Audio button...');
    const footerJoinBtn = await this.findLocator('button:has-text("Join Audio"), button[aria-label*="join audio" i], .join-audio-container__btn');
    if (footerJoinBtn) {
      console.log('[Zoom Bot] Clicking footer "Join Audio" button...');
      await footerJoinBtn.click({ force: true }).catch(() => {});
      await this.page.waitForTimeout(2000);
    }

    // 3. Fallback: Wait up to 10 attempts (20 seconds) for the "Join Audio by Computer" dialog
    const maxAttempts = 10;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (await this.isAudioConnected()) {
        console.log('[Zoom Bot] Audio connected.');
        await this.muteCamera();
        await this.openParticipantsPanel();
        return true;
      }

      const audioBtn = await this.findLocator(SELECTORS.audioDialog.joinAudioBtn);
      if (audioBtn) {
        console.log('[Zoom Bot] Found "Join Audio by Computer" dialog button. Clicking...');
        await audioBtn.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(2000);
        
        if (await this.isAudioConnected()) {
          console.log('[Zoom Bot] Audio connected.');
          await this.muteCamera();
          await this.openParticipantsPanel();
          return true;
        }
      }
      
      console.log(`[Zoom Bot] Waiting for audio connection... (attempt ${attempt}/${maxAttempts})`);
      await this.page.waitForTimeout(2000);
    }

    // Double check one last time before declaring failure
    if (await this.isAudioConnected()) {
      console.log('[Zoom Bot] Audio connected (final check).');
      await this.muteCamera();
      await this.openParticipantsPanel();
      return true;
    }

    console.warn('[Zoom Bot] Failed to connect audio or locate "Join Audio by Computer" button. Taking debug logs...');

    // Create /Zoom/debug directory if it doesn't exist
    const debugDir = path.resolve(__dirname, '../../debug');
    try {
      fs.mkdirSync(debugDir, { recursive: true });
      
      // Save screenshot
      const screenshotPath = path.join(debugDir, 'audio-dialog-timeout.png');
      await this.page.screenshot({ path: screenshotPath }).catch((err) => console.error('[Zoom Bot] Screenshot capture failed:', err.message));
      console.log(`[Zoom Bot] Debug screenshot saved to: ${screenshotPath}`);
      
      // Save HTML from main page and all frames
      let fullHtml = '--- Main Page HTML ---\n';
      try {
        fullHtml += await this.page.content();
      } catch (err) {
        fullHtml += `Error reading main page content: ${err.message}`;
      }
      
      const frames = this.page.frames();
      for (let idx = 0; idx < frames.length; idx++) {
        const frame = frames[idx];
        try {
          const frameHtml = await frame.content();
          fullHtml += `\n\n--- Frame ${idx} (URL: ${frame.url()}) HTML ---\n` + frameHtml;
        } catch (e) {
          fullHtml += `\n\n--- Frame ${idx} Error: ${e.message} ---\n`;
        }
      }
      
      const htmlPath = path.join(debugDir, 'audio-dialog-timeout.html');
      fs.writeFileSync(htmlPath, fullHtml, 'utf8');
      console.log(`[Zoom Bot] Debug DOM HTML saved to: ${htmlPath}`);
    } catch (e) {
      console.error('[Zoom Bot] Failed to write debug files:', e.message);
    }

    return false;
  }

  async openParticipantsPanel() {
    try {
      const toggleBtn = await this.findLocator(SELECTORS.inCall.participantsToggle);
      if (toggleBtn) {
        console.log('[Zoom Bot] Clicking participants panel button to open panel...');
        await toggleBtn.click({ force: true }).catch(() => {});
        await this.page.waitForTimeout(1000);
      } else {
        console.warn('[Zoom Bot] Warning: Participants list button not found in meeting footer');
      }
    } catch (e) {
      console.error('[Zoom Bot] Failed to open participants panel:', e.message);
    }
  }

  async muteCamera() {
    try {
      // Look for the Video/Camera button in footer
      const camBtn = await this.findLocator('button[aria-label*="video" i], button[aria-label*="camera" i], .footer-button__video');
      if (camBtn) {
        const label = (await camBtn.getAttribute('aria-label') || '').toLowerCase();
        // If it does NOT contain 'start video' or 'unmute', it is ON, so click to mute
        if (label.includes('stop') || label.includes('mute') || label.includes('disable')) {
          console.log('[Zoom Bot] Toggling camera OFF...');
          await camBtn.click({ force: true }).catch(() => {});
        }
      }
    } catch (e) {
      console.log('[Zoom Bot] Camera mute check error:', e.message);
    }
  }

  async leave() {
    try {
      const leaveBtn = await this.findLocator(SELECTORS.inCall.leaveBtn);
      if (leaveBtn) {
        console.log('[Zoom Bot] Clicking "Leave" button...');
        await leaveBtn.scrollIntoViewIfNeeded().catch(() => {});
        await leaveBtn.click({ force: true }).catch(() => {});
        
        // Handle leave confirmation if any
        const confirmLeave = await this.findLocator('button:has-text("Leave Meeting")');
        if (confirmLeave) {
          await confirmLeave.click({ force: true }).catch(() => {});
        }
      }
    } catch (e) {
      console.log('[Zoom Bot] Leave error:', e.message);
    }
    await this.close();
  }

  async close() {
    if (this.page) await this.page.close();
    if (this.context) await this.context.close();
    if (this.browser) await this.browser.close();
  }

  async findLocator(selector) {
    // 1. Check main page
    const loc = this.page.locator(selector).first();
    if (await loc.isVisible().catch(() => false)) {
      return loc;
    }

    // 2. Check frames (Zoom web client mounts in iframes sometimes)
    const frames = this.page.frames();
    for (const frame of frames) {
      const locFrame = frame.locator(selector).first();
      if (await locFrame.isVisible().catch(() => false)) {
        return locFrame;
      }
    }

    return null;
  }

  getPage() {
    return this.page;
  }
}
