import { ICapture } from './capture-interface.js';
import { SELECTORS } from '../config/selectors.js';

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
    const blocks = Array.from(document.querySelectorAll('.fui-ChatMessageCompact, [data-tid="closed-caption-v2-message"], [class*="ChatMessageCompact" i]'));

    if (blocks.length > 0 && !this.hasDumpedOuterHTML) {
      const container = document.querySelector('[data-tid="closed-caption-renderer-wrapper"], [data-tid="closed-caption-v2-window-wrapper"], div.captions-render-area, div[class*="captions-container" i]');
      if (container) {
        console.log('[BrowserScraper] [DEBUG DUMP] Caption container outerHTML:', container.outerHTML);
        this.hasDumpedOuterHTML = true;
      }
    }

    const now = Date.now();

    for (const block of blocks) {
      // Skip already finalized blocks
      if (block._captionFinalized) {
        continue;
      }

      // Find speaker element
      const speakerEl = block.querySelector('.fui-ChatMessageCompact__author, [data-tid="author"], [data-tid="closed-caption-v2-author"], span[class*="author" i], div[class*="author" i]');
      // Find text element
      const textEl = block.querySelector('.fui-ChatMessageCompact__body, [data-tid="content"], [data-tid="closed-caption-v2-content"], span[class*="body" i], div[class*="body" i], span[class*="content" i], div[class*="content" i]');

      if (speakerEl && textEl) {
        const speaker = speakerEl.textContent.trim();
        const text = textEl.textContent.trim();

        if (!text) continue;

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
    block._captionFinalized = true;

    if (value.text && value.text.trim().length > 0) {
      this.onCaptionCallback?.({
        speaker: value.speaker,
        text: value.text.trim(),
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
    // Strategy 1: Keyboard shortcut fallback (Ctrl+Shift+C is standard Teams web caption toggle)
    console.log('[CaptionScraper] Triggering Ctrl+Shift+C live captions shortcut...');
    await this.page.keyboard.press('Control+Shift+c');
    await this.page.waitForTimeout(3000);

    // Verify if captions container appears
    let container = await this.page.$(SELECTORS.inCall.captionsContainer).catch(() => null);
    if (container && await container.isVisible()) {
      console.log('[CaptionScraper] Successfully enabled captions via keyboard shortcut!');
      return;
    }

    // Strategy 2: Click through call settings menu
    console.log('[CaptionScraper] Shortcut failed or container not visible. Attempting menu navigation...');
    try {
      // 1. Click "More" actions button
      const moreBtnSelector = 'button#callingButtons-showMoreBtn, button[data-tid="more-actions-button"], button[aria-label*="More" i]';
      const moreBtn = await this.page.waitForSelector(moreBtnSelector, { timeout: 8000 }).catch(() => null);
      if (!moreBtn) {
        throw new Error('More actions button not found');
      }
      
      console.log('[CaptionScraper] Clicking "More" button...');
      await moreBtn.click().catch(() => {});
      await this.page.waitForTimeout(1000);
      
      // Secondary click check: if menu didn't open, try force clicking or JS evaluation click
      await this.page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
      }, moreBtnSelector);
      
      await this.page.waitForTimeout(2000);

      // --- DUMP VISIBLE MENU ELEMENTS FOR DEBUGGING ---
      console.log('[CaptionScraper] [DEBUG] Scanning DOM for active menu/popover elements...');
      try {
        const menuDump = await this.page.evaluate(() => {
          // Query all potential interactive elements on the page
          const candidates = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], button, li, a, div[class*="menu" i] div, div[class*="popover" i] div, div[class*="flyout" i] div'));
          return candidates
            .filter(el => {
              // Only keep elements that are visible and contain non-empty text content
              const isVisible = el.offsetWidth > 0 || el.offsetHeight > 0;
              const hasText = el.textContent && el.textContent.trim().length > 0;
              return isVisible && hasText;
            })
            .map(el => ({
              tagName: el.tagName,
              text: el.textContent.trim().slice(0, 100),
              ariaLabel: el.getAttribute('aria-label'),
              role: el.getAttribute('role'),
              id: el.id,
              className: el.className,
              dataTid: el.getAttribute('data-tid') || el.getAttribute('data-testid')
            }))
            // Filter unique entries based on text and tag
            .filter((item, idx, arr) => arr.findIndex(t => t.text === item.text && t.tagName === item.tagName) === idx);
        });
        console.log('[CaptionScraper] [DEBUG] Clickable menu options discovered:', JSON.stringify(menuDump, null, 2));
      } catch (dumpErr) {
        console.error('[CaptionScraper] [DEBUG] Failed to dump menu items:', dumpErr.message);
      }

      // 2. Click the "Captions" menu item (#closed-captions-button)
      const clickedCaptionsMenu = await this.page.evaluate(() => {
        const btn = document.getElementById('closed-captions-button');
        if (btn) {
          btn.click();
          btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }
        return false;
      });

      if (clickedCaptionsMenu) {
        console.log('[CaptionScraper] Clicked "Captions" menu item (#closed-captions-button).');
        await this.page.waitForTimeout(2000);

        // Check if there is a language confirmation dialog / popover
        const clickedConfirm = await this.page.evaluate(() => {
          const els = Array.from(document.querySelectorAll('button, div, span, [role="button"]'));
          const confirmEl = els.find(el => /Confirm|OK|Turn on|Start/i.test(el.textContent || '') && (el.offsetWidth > 0 || el.offsetHeight > 0));
          if (confirmEl) {
            confirmEl.click();
            confirmEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return true;
          }
          return false;
        });

        if (clickedConfirm) {
          console.log('[CaptionScraper] Clicked language selection confirmation button.');
          await this.page.waitForTimeout(2000);
        } else {
          console.log('[CaptionScraper] No language confirmation button detected.');
        }

        console.log('[CaptionScraper] Captions option triggered successfully.');
        return;
      }

      throw new Error('Caption activation menu option not found or not clickable');
    } catch (err) {
      console.error('[CaptionScraper] Failed to enable live captions via menu navigation:', err.message);
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
