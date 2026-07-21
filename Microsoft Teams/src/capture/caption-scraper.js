import { ICapture } from './capture-interface.js';
import { SELECTORS } from '../config/selectors.js';
import fs from 'fs';

function logDebug(message) {
  const logMsg = `[${new Date().toISOString()}] ${message}\n`;
  console.log(message);
  try {
    fs.appendFileSync('C:\\Users\\IshitaBhojani\\Meeting-Bots-Crest\\dashboard\\backend\\transcripts\\captions_debug.log', logMsg, 'utf8');
  } catch (e) {
    // Ignore
  }
}

const BROWSER_SCRAPER_SCRIPT = `
window.teamsCaptionScraper = {
  observer: null,
  activeBlocks: new Map(), // Map of virtual/real block -> { speaker, text, lastUpdated }
  onCaptionCallback: null,
  checkInterval: null,
  isRunning: false,
  hasDumpedOuterHTML: false,

  start(onCaptionCallback) {
    this.onCaptionCallback = onCaptionCallback;
    this.isRunning = true;
    this.hasDumpedOuterHTML = false;

    console.log('[BrowserScraper] Caption observer monitoring started.');

    // Run fallback check and sweep blocks periodically
    this.checkInterval = setInterval(() => {
      try {
        this.processBlocks();
      } catch (e) {
        console.error('[BrowserScraper] Error in periodic processBlocks:', e.message);
      }
      this.sweepBlocks(2500);
    }, 1000);

    this.setupObserver();
  },

  setupObserver() {
    console.log('[BrowserScraper] Setting up MutationObserver on document.body...');
    
    let pending = false;
    this.observer = new MutationObserver((mutations) => {
      console.log('[BrowserScraper] MutationObserver detected DOM change. mutationsCount=' + mutations.length);
      if (pending) return;
      pending = true;
      setTimeout(() => {
        pending = false;
        try {
          this.processBlocks();
        } catch (e) {
          console.error('[BrowserScraper] Error in processBlocks:', e.message);
        }
      }, 100);
    });

    this.observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
  },

  processBlocks() {
    if (!this.isRunning) return;

    // Find all compact chat messages/caption elements
    let blocks = Array.from(document.querySelectorAll('.fui-ChatMessageCompact, [data-tid="closed-caption-v2-message"], [class*="ChatMessageCompact" i]'));

    // Filter out nested blocks to prevent duplicate matching (e.g. fui-ChatMessageCompact__body matching wildcards)
    blocks = blocks.filter(block => {
      return !blocks.some(otherBlock => otherBlock !== block && otherBlock.contains(block));
    });

    if (blocks.length > 0 && !this.hasDumpedOuterHTML) {
      const container = document.querySelector('[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-v2-window-wrapper"], div.captions-render-area, div[class*="captions-container" i]');
      if (container) {
        console.log('[BrowserScraper] [DEBUG DUMP] Caption container outerHTML:', container.outerHTML);
        this.hasDumpedOuterHTML = true;
      }
    }

    const now = Date.now();

    for (const block of blocks) {
      // Find speaker element using distinct child selectors
      const speakerEl = block.querySelector('.fui-ChatMessageCompact__author, [data-tid="author"], [data-tid="closed-caption-v2-author"], .caption-speaker, .___1hdoxqz, span[class*="speaker" i], div[class*="speaker" i], span[class*="author" i], div[class*="author" i], strong');
      // Find text element using distinct child selectors
      const textEl = block.querySelector('[data-tid="closed-caption-text"], .fui-ChatMessageCompact__body, [data-tid="content"], [data-tid="closed-caption-v2-content"], .caption-text, div[class*="caption-text" i], span[class*="caption-text" i], span[class*="body" i], div[class*="body" i], span[class*="content" i], div[class*="content" i]');

      if (speakerEl && textEl) {
        const speaker = speakerEl.textContent.trim();
        
        // Extract text by excluding the speaker element if it is contained within the text element
        let textNode = textEl;
        if (speakerEl && textEl.contains(speakerEl)) {
          textNode = textEl.cloneNode(true);
          const clonedSpeaker = textNode.querySelector('.fui-ChatMessageCompact__author, [data-tid="author"], [data-tid="closed-caption-v2-author"], .caption-speaker, .___1hdoxqz, span[class*="speaker" i], div[class*="speaker" i], span[class*="author" i], div[class*="author" i], strong');
          if (clonedSpeaker) {
            clonedSpeaker.remove();
          }
        }
        
        let text = textNode.textContent.trim();

        // Defensive strip-fallback: if text starts with speaker's name, slice it off
        if (speaker && text.startsWith(speaker)) {
          text = text.slice(speaker.length).trim();
        }

        if (!text) continue;

        // Skip if this text matches what was already emitted for this block
        if (block._lastEmittedText && text === block._lastEmittedText) {
          continue;
        }

        if (!this.activeBlocks.has(block)) {
          // New block detected
          this.activeBlocks.set(block, {
            speaker,
            text,
            lastUpdated: now
          });
        } else {
          // Existing block updated
          const current = this.activeBlocks.get(block);
          if (current.text !== text || current.speaker !== speaker) {
            current.text = text;
            current.speaker = speaker;
            current.lastUpdated = now;
          }
        }
      }
    }

    // Sweep any blocks in activeBlocks that are no longer in the DOM (e.g. scrolled out)
    for (const [block, value] of this.activeBlocks.entries()) {
      if (!document.body.contains(block)) {
        this.finalizeBlock(block, value);
      }
    }
  },

  sweepBlocks(timeoutMs) {
    const now = Date.now();
    for (const [block, value] of this.activeBlocks.entries()) {
      if (now - value.lastUpdated > timeoutMs) {
        this.finalizeBlock(block, value);
      }
    }
  },

  finalizeBlock(block, value) {
    this.activeBlocks.delete(block);

    const fullText = (value.text || '').trim();
    if (!fullText) return;

    let textToEmit = fullText;
    if (block._lastEmittedText && fullText.startsWith(block._lastEmittedText)) {
      textToEmit = fullText.slice(block._lastEmittedText.length).trim();
    }

    block._lastEmittedText = fullText;

    if (textToEmit && textToEmit.length > 0) {
      this.onCaptionCallback?.({
        speaker: value.speaker,
        text: textToEmit,
        timestamp: new Date().toISOString()
      });
    }
  },

  stop() {
    this.isRunning = false;
    if (this.observer) {
      this.observer.disconnect();
      this.observer = null;
    }
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    
    // Finalize any remaining blocks before exiting
    for (const [block, value] of this.activeBlocks.entries()) {
      this.finalizeBlock(block, value);
    }
    this.activeBlocks.clear();
    console.log('[BrowserScraper] Caption observer monitoring stopped.');
  }
};
`;

export class CaptionScraper extends ICapture {
  constructor() {
    super();
    this.page = null;
  }

  async initialize(page) {
    this.page = page;
    console.log('[CaptionScraper] Initializing caption scraper hooks in browser page...');

    // Expose local callback function to Playwright page context
    await this.page.exposeFunction('onBrowserCaptionReceived', (event) => {
      // Emit via ICapture base class
      this.emit(event.speaker, event.text, event.timestamp);
    }).catch(err => {
      console.warn('[CaptionScraper] Warning exposing caption callback:', err.message);
    });

    // Evaluate immediately on the current active page context
    await this.page.evaluate(BROWSER_SCRAPER_SCRIPT).catch(err => {
      console.error('[CaptionScraper] Error evaluating scraper script on active page:', err.message);
    });
  }

  async start() {
    logDebug('[CaptionScraper] Waiting 5 seconds for call interface to settle...');
    await this.page.waitForTimeout(5000);

    console.log('[CaptionScraper] Enabling Microsoft Teams live captions...');
    await this.enableCaptions().catch(err => {
      console.warn('[CaptionScraper] enableCaptions error:', err.message);
    });
    
    console.log('[CaptionScraper] Injecting browser DOM scraper script execution...');
    await this.page.evaluate(() => {
      window.teamsCaptionScraper.start((event) => window.onBrowserCaptionReceived(event));
    });

    // Start background tracing to log DOM structure of captions
    this.runCaptionsDomTracer();
  }

  async runCaptionsDomTracer() {
    console.log('[CaptionScraper] [DEBUG] Starting background DOM tracer for captions...');
    // Poll 3 times, every 10 seconds
    for (let i = 0; i < 3; i++) {
      try {
        if (!this.page || this.page.isClosed()) {
          console.log('[CaptionScraper] [DEBUG] Tracer exiting: page is closed.');
          return;
        }
        await this.page.waitForTimeout(10000);
        
        if (this.page.isClosed()) {
          console.log('[CaptionScraper] [DEBUG] Tracer exiting: page closed during timeout.');
          return;
        }

        const paths = await this.page.evaluate(() => {
          const results = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          let node;
          while (node = walker.nextNode()) {
            const text = node.textContent.trim();
            // Search for text seen in user's captions container screenshots
            if (
              text.includes('Ishita') || 
              text.includes('Bhojani') || 
              text.includes('destination') || 
              text.includes('Who has?') ||
              text.includes('Hey')
            ) {
              const hierarchy = [];
              let parent = node.parentElement;
              while (parent && parent !== document.body) {
                hierarchy.push({
                  tagName: parent.tagName,
                  id: parent.id,
                  className: parent.className,
                  dataTid: parent.getAttribute('data-tid') || parent.getAttribute('data-testid')
                });
                parent = parent.parentElement;
              }
              results.push({ text, hierarchy });
            }
          }
          return results;
        });

        if (paths.length > 0) {
          console.log(`[CaptionScraper] [DEBUG] Trace #${i+1} found captions text hierarchy:`, JSON.stringify(paths, null, 2));
        } else {
          console.log(`[CaptionScraper] [DEBUG] Trace #${i+1}: No caption text found containing search keywords.`);
        }
      } catch (err) {
        console.log('[CaptionScraper] [DEBUG] Tracer stopped (page or browser likely closed).');
        return; // Exit loop on any error
      }
    }
  }


  /**
   * Orchestrates clicking the menu options or keyboard shortcuts to turn on captions in Teams
   */
  async enableCaptions() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      logDebug(`[CaptionScraper] Starting enableCaptions procedure (attempt ${attempt}/3)...`);
      
      // Strategy 1: Keyboard shortcut fallback (Ctrl+Shift+C is standard Teams web caption toggle)
      logDebug('[CaptionScraper] Triggering Ctrl+Shift+C live captions shortcut...');
      await this.page.bringToFront().catch(() => {});
      await this.page.focus('body').catch(() => {});
      await this.page.keyboard.press('Control+Shift+c');
      await this.page.waitForTimeout(3000);

      // Verify if captions container appears
      let container = await this.page.$(SELECTORS.inCall.captionsContainer).catch(() => null);
      if (container && await container.isVisible().catch(() => false)) {
        logDebug('[CaptionScraper] Successfully enabled captions via keyboard shortcut!');
        return;
      }

      // Strategy 2: Click through call settings menu
      logDebug('[CaptionScraper] Shortcut failed or container not visible. Attempting menu navigation...');
      try {
        // 1. Click "More" actions button
        const moreBtnSelector = 'button#callingButtons-showMoreBtn, button[data-tid="more-actions-button"], button[aria-label*="More" i]';
        const moreBtn = await this.page.waitForSelector(moreBtnSelector, { timeout: 8000 }).catch(() => null);
        if (!moreBtn) {
          throw new Error('More actions button not found');
        }
        
        logDebug('[CaptionScraper] Attempting to click "More" button via Playwright...');
        await moreBtn.click({ force: true, timeout: 2000 }).catch(err => {
          logDebug(`[CaptionScraper] Playwright click failed: ${err.message}`);
        });
        await this.page.waitForTimeout(500);

        // Check if menu is opened (any item like "Language and speech" or "Device settings" visible)
        let isMenuVisible = await this.page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button'));
          return els.some(el => /Language and speech|Captions|Device settings/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
        });

        if (!isMenuVisible) {
          logDebug('[CaptionScraper] Menu not visible after Playwright click. Trying Mouse Event sequence...');
          await this.page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            if (btn) {
              btn.focus();
              const rect = btn.getBoundingClientRect();
              const opts = { bubbles: true, cancelable: true, view: window, screenX: rect.left, screenY: rect.top, clientX: rect.left, clientY: rect.top };
              btn.dispatchEvent(new MouseEvent('mousedown', opts));
              btn.dispatchEvent(new MouseEvent('mouseup', opts));
              btn.dispatchEvent(new MouseEvent('click', opts));
            }
          }, moreBtnSelector);
          await this.page.waitForTimeout(1000);
          
          isMenuVisible = await this.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button'));
            return els.some(el => /Language and speech|Captions|Device settings/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
          });
        }

        if (!isMenuVisible) {
          logDebug('[CaptionScraper] Menu still not visible. Trying keyboard Enter click...');
          await moreBtn.focus().catch(() => {});
          await this.page.keyboard.press('Enter').catch(() => {});
          await this.page.waitForTimeout(1000);
        }
        logDebug('[CaptionScraper] Step 1: Scanning DOM for menu options...');
        const menuItems = await this.page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, div[class*="menu" i] div, div[class*="popover" i] div'));
          return els
            .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0)
            .map(el => ({
              text: (el.textContent || '').trim().slice(0, 100),
              id: el.id,
              role: el.getAttribute('role'),
              className: el.className
            }));
        }).catch(() => []);
        
        logDebug(`[CaptionScraper] Found visible menu items: ${JSON.stringify(menuItems, null, 2)}`);

        // Check which path we should take (direct Captions vs Language and Speech submenu)
        const hasDirectCaptions = menuItems.some(item => /Captions/i.test(item.text) || item.id === 'closed-captions-button');
        const hasLanguageSubmenu = menuItems.some(item => /Language and speech/i.test(item.text));

        logDebug(`[CaptionScraper] Menu Analysis - hasDirectCaptions: ${hasDirectCaptions} | hasLanguageSubmenu: ${hasLanguageSubmenu}`);

        let clickedCaptionsMenu = false;

        if (hasLanguageSubmenu) {
          // --- PATH A: Submenu flow ---
          logDebug('[CaptionScraper] Step 2A: Clicking "Language and speech" submenu item...');
          const langSubmenuSelector = 'div[role="menuitem"]:has-text("Language and speech"), [id*="speech" i], [aria-label*="Language and speech" i]';
          await this.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('[role="menuitem"], button, div'));
            const target = els.find(el => /Language and speech/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
            if (target) {
              target.click();
              target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
          });
          await this.page.waitForTimeout(2000);

          // Verify "Turn on live captions" submenu item becomes visible
          const subMenuItems = await this.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button'));
            return els
              .filter(el => el.offsetWidth > 0 || el.offsetHeight > 0)
              .map(el => (el.textContent || '').trim());
          }).catch(() => []);
          logDebug(`[CaptionScraper] Submenu items visible: ${JSON.stringify(subMenuItems)}`);

          const hasTurnOnCaptions = subMenuItems.some(text => /Turn on live captions/i.test(text));
          logDebug(`[CaptionScraper] Step 3A: "Turn on live captions" visible: ${hasTurnOnCaptions}`);

          if (hasTurnOnCaptions) {
            logDebug('[CaptionScraper] Step 4A: Clicking "Turn on live captions"...');
            await this.page.evaluate(() => {
              const els = Array.from(document.querySelectorAll('[role="menuitem"], button'));
              const target = els.find(el => /Turn on live captions/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
              if (target) {
                target.click();
                target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
            });
            clickedCaptionsMenu = true;
          }
        } else {
          // --- PATH B: Direct button flow ---
          logDebug('[CaptionScraper] Step 2B: Clicking direct "Captions" button...');
          clickedCaptionsMenu = await this.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('[role="menuitem"], button'));
            const target = els.find(el => (el.textContent || '').trim() === 'Captions' && (el.offsetWidth > 0 || el.offsetHeight > 0));
            if (target) {
              target.click();
              target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }
            return false;
          });
        }

        if (clickedCaptionsMenu) {
          logDebug('[CaptionScraper] Triggered captions option. Checking for language selection dialog...');
          await this.page.waitForTimeout(2000);
          
          // Check for Confirm spoken language dialog
          const clickedConfirm = await this.page.evaluate(() => {
            const els = Array.from(document.querySelectorAll('button, [role="button"]'));
            const target = els.find(el => /Confirm|OK|Turn on|Start/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
            if (target) {
              target.click();
              target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }
            return false;
          });
          
          logDebug(`[CaptionScraper] Language confirmation dialog confirm button clicked: ${clickedConfirm}`);
          await this.page.waitForTimeout(3000);

          // Save a screenshot immediately after sequence finishes
          const screenshotPath = 'C:\\Users\\IshitaBhojani\\Meeting-Bots-Crest\\dashboard\\backend\\transcripts\\captions_activation_result.png';
          await this.page.screenshot({ path: screenshotPath }).catch(() => {});
          logDebug(`[CaptionScraper] Saved activation sequence screenshot to: ${screenshotPath}`);

          // Verify if captions container appears after trigger
          const activeContainer = await this.page.$(SELECTORS.inCall.captionsContainer).catch(() => null);
          if (activeContainer && await activeContainer.isVisible().catch(() => false)) {
            logDebug('[CaptionScraper] Captions option triggered successfully and verified active!');
            return;
          }
        }
      } catch (err) {
        logDebug(`[CaptionScraper] Error during menu navigation on attempt ${attempt}: ${err.message}`);
      }

      // If we got here, this attempt failed. Wait 3 seconds before retrying.
      logDebug(`[CaptionScraper] Attempt ${attempt} failed. Waiting 3 seconds before next retry...`);
      await this.page.waitForTimeout(3000);
    }

    // If all attempts failed, throw final error and take screenshot
    logDebug('[CaptionScraper] All caption activation attempts failed.');
    try {
      await this.page.screenshot({ path: 'C:\\Users\\IshitaBhojani\\Meeting-Bots-Crest\\dashboard\\backend\\transcripts\\headless_fail_screenshot.png' });
      logDebug('[CaptionScraper] Saved headless failure screenshot to: C:\\Users\\IshitaBhojani\\Meeting-Bots-Crest\\dashboard\\backend\\transcripts\\headless_fail_screenshot.png');
    } catch (screenshotErr) {
      logDebug(`[CaptionScraper] Failed to save failure screenshot: ${screenshotErr.message}`);
    }
  }

  async stop() {
    console.log('[CaptionScraper] Stop requested. Disconnecting observer...');
    try {
      await this.page.evaluate(() => {
        window.teamsCaptionScraper.stop();
      });
    } catch (err) {
      console.warn('[CaptionScraper] Could not stop browser script execution (page may be closed):', err.message);
    }
  }
}
