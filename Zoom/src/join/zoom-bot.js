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

    const meetingIdMatch = joinUrl.match(/\/j\/(\d+)/) || joinUrl.match(/\/s\/(\d+)/) || joinUrl.match(/\/wc\/join\/(\d+)/) || joinUrl.match(/\/wc\/(\d+)\/join/);
    if (meetingIdMatch) {
      const meetingId = meetingIdMatch[1];
      try {
        const urlObj = new URL(joinUrl);
        joinUrl = `${urlObj.origin}/wc/${meetingId}/join${urlObj.search}`;
      } catch {
        joinUrl = `https://zoom.us/wc/${meetingId}/join`;
      }
    }

    if (!joinUrl.includes('prefer=')) {
      joinUrl += (joinUrl.includes('?') ? '&' : '?') + 'prefer=1';
    }
    if (this.passcode && !joinUrl.includes('pwd=')) {
      joinUrl += `&pwd=${this.passcode}`;
    }

    console.log(`[Zoom Bot] Navigating to: ${joinUrl}`);
    await this.page.goto(joinUrl, { waitUntil: 'domcontentloaded' });

    console.log('[Zoom Bot] Waiting for join form to load...');
    try {
      await this.page.waitForSelector(`${SELECTORS.join.nameInput}, ${SELECTORS.preJoin.joinBrowserLink}`, { timeout: 15000 });
    } catch {
      console.log('[Zoom Bot] Timeout waiting for standard selectors, checking screen...');
    }

    const browserLink = await this.findLocator(SELECTORS.preJoin.joinBrowserLink);
    if (browserLink) {
      console.log('[Zoom Bot] Clicking "Join from your browser" link...');
      await browserLink.click();
      await this.page.waitForTimeout(5000);
    }

    await this.handleFormEntry();
  }

  async handleFormEntry() {
    const nameInput = await this.findLocator(SELECTORS.join.nameInput);
    if (nameInput) {
      console.log(`[Zoom Bot] Filling display name: ${this.botName}`);
      await nameInput.fill(this.botName);
      await this.page.waitForTimeout(1000);
    }

    const passcodeInput = await this.findLocator(SELECTORS.join.passcodeInput);
    if (passcodeInput) {
      if (this.passcode) {
        console.log('[Zoom Bot] Filling passcode...');
        await passcodeInput.fill(this.passcode);
        await this.page.waitForTimeout(1000);
      } else {
        console.warn('[Zoom Bot] Meeting asks for passcode, but none was provided!');
      }
    }

    const joinBtn = await this.findLocator(SELECTORS.join.joinBtn);
    if (joinBtn) {
      console.log('[Zoom Bot] Clicking "Join" button...');
      await joinBtn.click({ force: true }).catch(() => { });
    } else {
      console.log('[Zoom Bot] Join button not found, pressing Enter...');
      if (nameInput) {
        await nameInput.press('Enter').catch(() => { });
      } else {
        await this.page.keyboard.press('Enter').catch(() => { });
      }
    }

    await this.page.waitForTimeout(5000);
  }

  async showControls() {
    try {
      await this.page.mouse.move(640, 680).catch(() => { });
      await this.page.waitForTimeout(500);
    } catch (e) {
      console.log('[Zoom Bot] Failed to show controls:', e.message);
    }
  }

  async isAudioConnected() {
    await this.showControls();
    const muteBtn = await this.findLocator('button:not([id*="preview"]):not([class*="preview"]):has-text("Mute"), button:not([id*="preview"]):not([class*="preview"]):has-text("Unmute"), button:not([id*="preview"]):not([class*="preview"])[aria-label*="mute" i], button:not([id*="preview"]):not([class*="preview"])[aria-label*="unmute" i]');
    return muteBtn !== null;
  }

  async connectAudio() {
    console.log('[Zoom Bot] Connecting to call audio...');

    let connected = false;

    await this.page.waitForTimeout(3000);
    if (await this.isAudioConnected()) {
      connected = true;
    }

    if (!connected) {
      console.log('[Zoom Bot] Audio not auto-connected. Checking footer Join Audio button...');
      const footerJoinBtn = await this.findLocator('button:has-text("Join Audio"), button[aria-label*="join audio" i], .join-audio-container__btn');
      if (footerJoinBtn) {
        console.log('[Zoom Bot] Clicking footer "Join Audio" button...');
        await footerJoinBtn.click({ force: true }).catch(() => { });
        await this.page.waitForTimeout(2000);
        if (await this.isAudioConnected()) {
          connected = true;
        }
      }
    }

    if (!connected) {
      const maxAttempts = 10;
      for (let attempt = 1; attempt <= maxAttempts && !connected; attempt++) {
        if (await this.isAudioConnected()) {
          connected = true;
          break;
        }

        const audioBtn = await this.findLocator(SELECTORS.audioDialog.joinAudioBtn);
        if (audioBtn) {
          console.log('[Zoom Bot] Found "Join Audio by Computer" dialog button. Clicking...');
          await audioBtn.click({ force: true }).catch(() => { });
          await this.page.waitForTimeout(2000);

          if (await this.isAudioConnected()) {
            connected = true;
            break;
          }
        }

        console.log(`[Zoom Bot] Waiting for audio connection... (attempt ${attempt}/${maxAttempts})`);
        await this.page.waitForTimeout(2000);
      }
    }

    if (!connected && await this.isAudioConnected()) {
      connected = true;
    }

    if (connected) {
      console.log('[Zoom Bot] Audio connected.');
      await this.muteCamera();
      await this.muteMic();
      await this.openParticipantsPanel();

      // Give Zoom a few seconds for the gallery/dashboard frame to fully render
      await this.page.waitForTimeout(5000);

      // One-time diagnostic dump across all frames - tells us exactly what tile
      // markup exists right now (video-on vs audio-only avatar, current class names)
      await this.debugAllFrames();

      return true;
    }

    console.warn('[Zoom Bot] Failed to connect audio or locate "Join Audio by Computer" button. Taking debug logs...');

    const debugDir = path.resolve(__dirname, '../../debug');
    try {
      fs.mkdirSync(debugDir, { recursive: true });

      const screenshotPath = path.join(debugDir, 'audio-dialog-timeout.png');
      await this.page.screenshot({ path: screenshotPath }).catch((err) => console.error('[Zoom Bot] Screenshot capture failed:', err.message));
      console.log(`[Zoom Bot] Debug screenshot saved to: ${screenshotPath}`);

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
      for (let attempt = 1; attempt <= 3; attempt++) {
        await this.showControls();

        const listVisible = await this.page.locator(SELECTORS.inCall.participantList).first().isVisible().catch(() => false);
        if (listVisible) {
          console.log('[Zoom Bot] Participants list is open.');
          return;
        }

        console.log(`[Zoom Bot] Clicking participants panel button to open panel (attempt ${attempt}/3)...`);
        const toggleBtn = await this.findLocator(SELECTORS.inCall.participantsToggle);
        if (toggleBtn) {
          await toggleBtn.click({ force: true }).catch(() => { });
          await this.page.waitForTimeout(2000);
        } else {
          console.warn('[Zoom Bot] Warning: Participants list button not found in meeting footer');
          await this.page.waitForTimeout(1000);
        }
      }
    } catch (e) {
      console.error('[Zoom Bot] Failed to open participants panel:', e.message);
    }
  }

  /**
   * One-time diagnostic dump across ALL frames. Tells us, for THIS specific
   * session/participant state (camera on/off, gallery vs speaker view):
   *   - shadow DOM / canvas / nested iframe presence
   *   - every element whose class name looks gallery/tile/speaker-related,
   *     with a live HTML snippet, so we see the ACTUAL current markup
   *     instead of assuming last session's selector still applies.
   */
  async debugAllFrames() {
    console.log('\n========== ZOOM FRAME DEBUG (ALL FRAMES) ==========');

    const frames = this.page.frames();
    frames.forEach((frame, index) => {
      console.log(`Frame ${index}: ${frame.url()}`);
    });

    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      console.log(`\n----- Frame ${i}: ${frame.url()} -----`);

      try {
        const result = await frame.evaluate(() => {
          const KEYWORD_RE = /video-avatar|participant|gallery|speaker|talking|active-speaker|thumbnail|attendee|avatar/i;

          const matches = [...document.querySelectorAll('[class]')]
            .filter(el => KEYWORD_RE.test(el.className))
            .slice(0, 20)
            .map(el => ({
              tag: el.tagName,
              className: typeof el.className === 'string' ? el.className : String(el.className),
              outerHTMLSnippet: el.outerHTML.slice(0, 300),
            }));

          return {
            bodyOuterHTMLLength: document.body.outerHTML.length,
            shadowRoots: [...document.querySelectorAll('*')]
              .filter(el => el.shadowRoot)
              .map(el => el.tagName),
            canvasCount: document.querySelectorAll('canvas').length,
            videoElCount: document.querySelectorAll('video').length,
            iframeCount: document.querySelectorAll('iframe').length,
            iframeSources: [...document.querySelectorAll('iframe')].map(f => f.src),
            keywordMatchCount: matches.length,
            keywordMatches: matches,
          };
        });

        console.log(`bodyOuterHTMLLength: ${result.bodyOuterHTMLLength}`);
        console.log(`shadowRoots: ${JSON.stringify(result.shadowRoots)}`);
        console.log(`canvasCount: ${result.canvasCount}, videoElCount: ${result.videoElCount}`);
        console.log(`iframeCount: ${result.iframeCount}, iframeSources: ${JSON.stringify(result.iframeSources)}`);
        console.log(`keywordMatchCount: ${result.keywordMatchCount}`);
        if (result.keywordMatchCount > 0) {
          console.log('keywordMatches:');
          result.keywordMatches.forEach((m, idx) => {
            console.log(`  [${idx}] <${m.tag} class="${m.className}">`);
            console.log(`      ${m.outerHTMLSnippet}`);
          });
        }
      } catch (e) {
        console.log(`[Zoom Bot] debugAllFrames(): evaluate failed for frame ${i} - ${e.message}`);
      }
    }

    console.log('=====================================================\n');
  }

  async muteCamera() {
    try {
      await this.showControls();
      const camBtn = await this.findLocator('button[aria-label*="video" i], button[aria-label*="camera" i], .footer-button__video');
      if (camBtn) {
        const label = (await camBtn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('stop') || label.includes('mute') || label.includes('disable')) {
          console.log('[Zoom Bot] Toggling camera OFF...');
          await camBtn.click({ force: true }).catch(() => { });
        }
      }
    } catch (e) {
      console.log('[Zoom Bot] Camera mute check error:', e.message);
    }
  }

  async muteMic() {
    try {
      await this.showControls();
      const micBtn = await this.findLocator('button[aria-label*="mute" i], button[aria-label*="audio" i], .footer-button__audio');
      if (micBtn) {
        const label = (await micBtn.getAttribute('aria-label') || '').toLowerCase();
        if (label.includes('mute') && !label.includes('unmute')) {
          console.log('[Zoom Bot] Muting microphone in call UI...');
          await micBtn.click({ force: true }).catch(() => { });
        }
      }
    } catch (e) {
      console.log('[Zoom Bot] Microphone mute check error:', e.message);
    }
  }

  async leave() {
    try {
      await this.showControls();
      const leaveBtn = await this.findLocator(SELECTORS.inCall.leaveBtn);
      if (leaveBtn) {
        console.log('[Zoom Bot] Clicking "Leave" button...');
        await leaveBtn.scrollIntoViewIfNeeded().catch(() => { });
        await leaveBtn.click({ force: true }).catch(() => { });

        const confirmLeave = await this.findLocator('button:has-text("Leave Meeting")');
        if (confirmLeave) {
          await confirmLeave.click({ force: true }).catch(() => { });
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

  async findLocator(selector, timeout = 5000) {
    const loc = this.page.locator(selector).first();
    try {
      await loc.waitFor({ state: 'visible', timeout });
      return loc;
    } catch { }

    const frames = this.page.frames();
    for (const frame of frames) {
      const locFrame = frame.locator(selector).first();
      try {
        await locFrame.waitFor({ state: 'visible', timeout: 1000 });
        return locFrame;
      } catch { }
    }

    return null;
  }

  getPage() {
    return this.page;
  }
}