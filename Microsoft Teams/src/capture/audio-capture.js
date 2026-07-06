import { ICapture } from './capture-interface.js';

/**
 * Stub class for future raw WebRTC audio capture.
 * Non-functional for this phase.
 */
export class AudioCapture extends ICapture {
  constructor() {
    super();
    console.log('[AudioCapture] Initialized stub.');
  }

  async initialize(page) {
    this.page = page;
    console.log('[AudioCapture] Initialized with page.');
  }

  async start() {
    console.log('[AudioCapture] Start requested (stub — doing nothing).');
  }

  async stop() {
    console.log('[AudioCapture] Stop requested (stub — doing nothing).');
  }
}
