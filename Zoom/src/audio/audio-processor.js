/**
 * Advanced Audio Processing Module
 * Provides: VAD, Noise Reduction, Anti-aliasing Filter, Audio Normalization
 */

export class AudioProcessor {
  constructor(sampleRate = 16000) {
    this.sampleRate = sampleRate;
    
    // VAD (Voice Activity Detection) parameters
    this.vadThreshold = 300; // RMS threshold for voice detection
    this.vadMinSpeechFrames = 1; // Minimum consecutive frames to consider as speech
    this.vadSilenceFrames = 2; // Frames of silence before marking as non-speech
    this.vadFrameCount = 0;
    this.vadSilenceCount = 0;
    this.isVoiceActive = false;
    
    // Noise gate parameters
    this.noiseGateThreshold = 100; // Below this RMS, audio is attenuated
    this.noiseGateRatio = 0.1; // Attenuation factor for noise
    
    // Normalization parameters
    this.targetRMS = 2000; // Target RMS level for normalization
    this.maxGain = 4.0; // Maximum gain amplification
    this.minGain = 0.5; // Minimum gain (prevents over-attenuation)
    this.smoothingFactor = 0.95; // Smoothing for gain changes
    this.currentGain = 1.0;
    
    // Anti-aliasing filter coefficients (simple low-pass Butterworth)
    this.filterOrder = 4;
    this.cutoffFrequency = 7500; // Hz (just below Nyquist for 16kHz)
    this.initializeFilter();
    
    // Spectral noise reduction
    this.noiseProfile = null;
    this.noiseEstimationFrames = 0;
    this.noiseEstimationComplete = false;
  }

  /**
   * Initialize low-pass filter coefficients for anti-aliasing
   */
  initializeFilter() {
    // Simple IIR low-pass filter (Butterworth approximation)
    const fc = this.cutoffFrequency / this.sampleRate;
    const wc = Math.tan(Math.PI * fc);
    const k1 = Math.sqrt(2) * wc;
    const k2 = wc * wc;
    const a0 = k2 / (1 + k1 + k2);
    const a1 = 2 * a0;
    const a2 = a0;
    const b1 = 2 * a0 * (1 / k2 - 1);
    const b2 = 1 - (a0 + a1 + a2 + b1);
    
    this.filterCoeffs = { a0, a1, a2, b1, b2 };
    this.filterState = { x1: 0, x2: 0, y1: 0, y2: 0 };
  }

  /**
   * Apply low-pass anti-aliasing filter before downsampling
   */
  applyAntiAliasingFilter(samples) {
    const filtered = new Int16Array(samples.length);
    const { a0, a1, a2, b1, b2 } = this.filterCoeffs;
    let { x1, x2, y1, y2 } = this.filterState;

    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = a0 * x0 + a1 * x1 + a2 * x2 - b1 * y1 - b2 * y2;
      
      filtered[i] = Math.max(-32768, Math.min(32767, Math.round(y0)));
      
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }

    this.filterState = { x1, x2, y1, y2 };
    return filtered;
  }

  /**
   * Enhanced resampling with anti-aliasing (polyphase filter approximation)
   */
  resample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;

    // Apply anti-aliasing filter if downsampling
    let filtered = samples;
    if (fromRate > toRate) {
      filtered = this.applyAntiAliasingFilter(samples);
    }

    const ratio = fromRate / toRate;
    const newLength = Math.round(filtered.length / ratio);
    const resampled = new Int16Array(newLength);

    // Polyphase interpolation (better than simple linear)
    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      
      // Cubic interpolation for smoother results
      const x0 = filtered[Math.max(0, idx - 1)] || 0;
      const x1 = filtered[idx] || 0;
      const x2 = filtered[Math.min(filtered.length - 1, idx + 1)] || 0;
      const x3 = filtered[Math.min(filtered.length - 1, idx + 2)] || 0;
      
      // Catmull-Rom spline
      const a = -0.5 * x0 + 1.5 * x1 - 1.5 * x2 + 0.5 * x3;
      const b = x0 - 2.5 * x1 + 2 * x2 - 0.5 * x3;
      const c = -0.5 * x0 + 0.5 * x2;
      const d = x1;
      
      const value = a * frac * frac * frac + b * frac * frac + c * frac + d;
      resampled[i] = Math.max(-32768, Math.min(32767, Math.round(value)));
    }

    return resampled;
  }

  /**
   * Calculate RMS (Root Mean Square) energy of audio samples
   */
  calculateRMS(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Voice Activity Detection (VAD)
   * Returns: { isVoice: boolean, confidence: number, rms: number }
   */
  detectVoice(samples) {
    const rms = this.calculateRMS(samples);
    const isAboveThreshold = rms > this.vadThreshold;

    if (isAboveThreshold) {
      this.vadFrameCount++;
      this.vadSilenceCount = 0;
      
      if (this.vadFrameCount >= this.vadMinSpeechFrames) {
        this.isVoiceActive = true;
      }
    } else {
      this.vadSilenceCount++;
      
      if (this.vadSilenceCount >= this.vadSilenceFrames) {
        this.isVoiceActive = false;
        this.vadFrameCount = 0;
      }
    }

    // Confidence score (0-1) based on RMS relative to threshold
    const confidence = Math.min(1.0, rms / (this.vadThreshold * 2));

    return {
      isVoice: this.isVoiceActive,
      confidence: confidence,
      rms: rms
    };
  }

  /**
   * Apply noise gate to reduce background noise
   */
  applyNoiseGate(samples, rms) {
    if (rms >= this.noiseGateThreshold) {
      return samples; // Pass through if above threshold
    }

    // Attenuate samples below threshold
    const attenuationFactor = this.noiseGateRatio;
    const gated = new Int16Array(samples.length);
    
    for (let i = 0; i < samples.length; i++) {
      gated[i] = Math.round(samples[i] * attenuationFactor);
    }

    return gated;
  }

  /**
   * Estimate noise profile from initial silent frames
   */
  estimateNoiseProfile(samples, rms) {
    // Collect first 30 frames (assuming initial silence) for noise estimation
    if (this.noiseEstimationFrames < 30 && rms < this.vadThreshold) {
      if (!this.noiseProfile) {
        this.noiseProfile = { sumRMS: 0, count: 0 };
      }
      this.noiseProfile.sumRMS += rms;
      this.noiseProfile.count++;
      this.noiseEstimationFrames++;
      
      if (this.noiseEstimationFrames === 30) {
        this.noiseProfile.avgRMS = this.noiseProfile.sumRMS / this.noiseProfile.count;
        this.noiseEstimationComplete = true;
        // Adjust noise gate threshold based on measured noise floor (capped at 300 to avoid muting speech)
        this.noiseGateThreshold = Math.min(300, Math.max(this.noiseGateThreshold, this.noiseProfile.avgRMS * 1.5));
        console.log(`[Audio Processor] Noise profile estimated: ${this.noiseProfile.avgRMS.toFixed(2)} RMS, threshold adjusted to ${this.noiseGateThreshold.toFixed(2)}`);
      }
    }
  }

  /**
   * Apply spectral subtraction for noise reduction (simplified)
   */
  applySpectralNoiseReduction(samples) {
    if (!this.noiseEstimationComplete || !this.noiseProfile) {
      return samples; // Can't reduce noise without profile
    }

    const currentRMS = this.calculateRMS(samples);
    const noiseFloor = this.noiseProfile.avgRMS;
    
    if (currentRMS <= noiseFloor * 1.2 && currentRMS < 300) {
      // Likely just noise, heavily attenuate
      const reduced = new Int16Array(samples.length);
      for (let i = 0; i < samples.length; i++) {
        reduced[i] = Math.round(samples[i] * 0.1);
      }
      return reduced;
    }

    // Signal present, apply gentle noise reduction
    const snr = currentRMS / noiseFloor;
    const reductionFactor = Math.min(1.0, Math.max(0.5, snr / 3));
    
    const reduced = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      reduced[i] = Math.round(samples[i] * reductionFactor);
    }

    return reduced;
  }

  /**
   * Normalize audio level with smooth gain adjustment
   */
  normalizeAudio(samples, rms) {
    if (rms < 10) {
      // Too quiet, likely silence
      return samples;
    }

    // Calculate desired gain
    const targetGain = this.targetRMS / rms;
    const clampedGain = Math.max(this.minGain, Math.min(this.maxGain, targetGain));
    
    // Smooth gain changes to avoid abrupt level shifts
    this.currentGain = this.smoothingFactor * this.currentGain + (1 - this.smoothingFactor) * clampedGain;

    // Apply gain
    const normalized = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const amplified = samples[i] * this.currentGain;
      normalized[i] = Math.max(-32768, Math.min(32767, Math.round(amplified)));
    }

    return normalized;
  }

  /**
   * Process audio frame with all enhancements
   */
  processFrame(samples, fromRate, toRate, options = {}) {
    const enableVAD = options.enableVAD !== false;
    const enableNoiseReduction = options.enableNoiseReduction !== false;
    const enableNormalization = options.enableNormalization !== false;
    const enableAntiAliasing = options.enableAntiAliasing !== false;

    // Step 1: Resample with anti-aliasing
    let processed = enableAntiAliasing ? 
      this.resample(samples, fromRate, toRate) : 
      this.simpleResample(samples, fromRate, toRate);

    // Step 2: Calculate RMS for analysis
    const rms = this.calculateRMS(processed);

    // Step 3: Estimate noise profile (if still collecting)
    if (enableNoiseReduction && !this.noiseEstimationComplete) {
      this.estimateNoiseProfile(processed, rms);
    }

    // Step 4: Voice Activity Detection
    let vadResult = null;
    if (enableVAD) {
      vadResult = this.detectVoice(processed);
    }

    // Step 5: Noise reduction
    if (enableNoiseReduction) {
      processed = this.applyNoiseGate(processed, rms);
      processed = this.applySpectralNoiseReduction(processed);
    }

    // Step 6: Normalize audio levels
    if (enableNormalization) {
      if (vadResult && vadResult.isVoice) {
        const normalizedRMS = this.calculateRMS(processed);
        processed = this.normalizeAudio(processed, normalizedRMS);
      } else {
        // Apply current gain without updating it (keeps volume stable during pauses/silence)
        const normalized = new Int16Array(processed.length);
        for (let i = 0; i < processed.length; i++) {
          const amplified = processed[i] * this.currentGain;
          normalized[i] = Math.max(-32768, Math.min(32767, Math.round(amplified)));
        }
        processed = normalized;
      }
    }

    return {
      samples: processed,
      vad: vadResult,
      rms: rms,
      gain: this.currentGain
    };
  }

  /**
   * Simple linear resampling (fallback)
   */
  simpleResample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;

    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const resampled = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const nextIdx = Math.min(samples.length - 1, idx + 1);
      const weight = pos - idx;
      resampled[i] = Math.round(samples[idx] * (1 - weight) + samples[nextIdx] * weight);
    }

    return resampled;
  }

  /**
   * Reset processor state
   */
  reset() {
    this.vadFrameCount = 0;
    this.vadSilenceCount = 0;
    this.isVoiceActive = false;
    this.currentGain = 1.0;
    this.filterState = { x1: 0, x2: 0, y1: 0, y2: 0 };
    this.noiseProfile = null;
    this.noiseEstimationFrames = 0;
    this.noiseEstimationComplete = false;
  }
}
