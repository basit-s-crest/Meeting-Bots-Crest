/**
 * Audio-based Speaker Diarization Module
 * Provides fallback speaker identification when DOM detection fails
 */

export class AudioDiarization {
  constructor() {
    // Speaker tracking
    this.speakers = new Map(); // speakerId -> { features, lastSeen, name }
    this.currentSpeakerId = null;
    this.nextSpeakerId = 1;
    
    // Audio feature extraction parameters
    this.featureWindowSize = 20; // Number of frames for feature averaging
    this.featureHistory = [];
    
    // Speaker similarity thresholds
    this.similarityThreshold = 0.75; // Threshold for speaker matching
    this.minFramesForNewSpeaker = 5; // Minimum frames before creating new speaker
    this.speakerTimeoutMs = 10000; // Remove inactive speakers after 10 seconds
    
    // Confidence scoring
    this.consecutiveFrames = 0;
    this.minConfidenceFrames = 3;
  }

  /**
   * Extract audio features from PCM samples
   * Features: spectral centroid, zero-crossing rate, energy distribution
   */
  extractFeatures(samples) {
    if (!samples || samples.length === 0) {
      return null;
    }

    const features = {
      energy: this.calculateEnergy(samples),
      zeroCrossingRate: this.calculateZeroCrossingRate(samples),
      spectralCentroid: this.calculateSpectralCentroid(samples),
      energyDistribution: this.calculateEnergyDistribution(samples),
      pitch: this.estimatePitch(samples)
    };

    return features;
  }

  /**
   * Calculate total energy
   */
  calculateEnergy(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Calculate zero-crossing rate (voice characteristic)
   */
  calculateZeroCrossingRate(samples) {
    let crossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0 && samples[i - 1] < 0) || (samples[i] < 0 && samples[i - 1] >= 0)) {
        crossings++;
      }
    }
    return crossings / samples.length;
  }

  /**
   * Calculate spectral centroid (brightness of sound)
   */
  calculateSpectralCentroid(samples) {
    // Simplified spectral analysis using magnitude
    const fft = this.simpleFFT(samples);
    let numerator = 0;
    let denominator = 0;
    
    for (let i = 0; i < fft.length; i++) {
      numerator += i * fft[i];
      denominator += fft[i];
    }
    
    return denominator > 0 ? numerator / denominator : 0;
  }

  /**
   * Simple magnitude spectrum (pseudo-FFT for feature extraction)
   */
  simpleFFT(samples) {
    const bins = 64;
    const magnitude = new Array(bins).fill(0);
    const samplesPerBin = Math.floor(samples.length / bins);
    
    for (let i = 0; i < bins; i++) {
      let sum = 0;
      const start = i * samplesPerBin;
      const end = Math.min(start + samplesPerBin, samples.length);
      
      for (let j = start; j < end; j++) {
        sum += Math.abs(samples[j]);
      }
      
      magnitude[i] = sum / samplesPerBin;
    }
    
    return magnitude;
  }

  /**
   * Calculate energy distribution across frequency bands
   */
  calculateEnergyDistribution(samples) {
    const fft = this.simpleFFT(samples);
    const lowBand = fft.slice(0, 16).reduce((a, b) => a + b, 0);
    const midBand = fft.slice(16, 40).reduce((a, b) => a + b, 0);
    const highBand = fft.slice(40, 64).reduce((a, b) => a + b, 0);
    const total = lowBand + midBand + highBand;
    
    return {
      low: total > 0 ? lowBand / total : 0,
      mid: total > 0 ? midBand / total : 0,
      high: total > 0 ? highBand / total : 0
    };
  }

  /**
   * Estimate fundamental frequency (pitch) using autocorrelation
   */
  estimatePitch(samples, sampleRate = 16000) {
    const minPeriod = Math.floor(sampleRate / 500); // Max 500 Hz
    const maxPeriod = Math.floor(sampleRate / 80);  // Min 80 Hz
    
    let maxCorr = 0;
    let bestPeriod = 0;
    
    for (let period = minPeriod; period < maxPeriod && period < samples.length / 2; period++) {
      let corr = 0;
      for (let i = 0; i < samples.length - period; i++) {
        corr += samples[i] * samples[i + period];
      }
      
      if (corr > maxCorr) {
        maxCorr = corr;
        bestPeriod = period;
      }
    }
    
    return bestPeriod > 0 ? sampleRate / bestPeriod : 0;
  }

  /**
   * Calculate similarity between two feature vectors
   */
  calculateSimilarity(features1, features2) {
    if (!features1 || !features2) return 0;

    // Weighted similarity based on different features
    const energyDiff = Math.abs(features1.energy - features2.energy) / Math.max(features1.energy, features2.energy, 1);
    const zcrDiff = Math.abs(features1.zeroCrossingRate - features2.zeroCrossingRate);
    const spectralDiff = Math.abs(features1.spectralCentroid - features2.spectralCentroid) / 64;
    const pitchDiff = Math.abs(features1.pitch - features2.pitch) / Math.max(features1.pitch, features2.pitch, 1);
    
    const energyDistDiff = Math.abs(features1.energyDistribution.low - features2.energyDistribution.low) +
                           Math.abs(features1.energyDistribution.mid - features2.energyDistribution.mid) +
                           Math.abs(features1.energyDistribution.high - features2.energyDistribution.high);

    // Combine with weights
    const similarity = 1.0 - (
      0.25 * energyDiff +
      0.15 * zcrDiff +
      0.20 * spectralDiff +
      0.25 * pitchDiff +
      0.15 * energyDistDiff
    );

    return Math.max(0, Math.min(1, similarity));
  }

  /**
   * Process audio frame and identify speaker
   * @param {Int16Array} samples - Audio samples
   * @param {number} timestamp - Current timestamp
   * @param {string|null} knownSpeaker - Known speaker name from DOM (if available)
   */
  processFrame(samples, timestamp, knownSpeaker = null) {
    // Extract features from current frame
    const features = this.extractFeatures(samples);
    
    if (!features || features.energy < 100) {
      // Silence or very low energy
      return {
        speakerId: null,
        confidence: 0,
        isNewSpeaker: false,
        features: features
      };
    }

    // Add to feature history
    this.featureHistory.push(features);
    if (this.featureHistory.length > this.featureWindowSize) {
      this.featureHistory.shift();
    }

    // Average features over window for stability
    const avgFeatures = this.averageFeatures(this.featureHistory);

    // If we have a known speaker from DOM, associate features with that speaker
    // This helps the system learn speaker characteristics for future fallback scenarios
    if (knownSpeaker) {
      return this.associateKnownSpeaker(knownSpeaker, avgFeatures, timestamp);
    }

    // No known speaker from DOM - try to match with existing speakers or create new one
    // (This is the fallback scenario when DOM detection fails)
    const match = this.findMatchingSpeaker(avgFeatures);

    if (match.speakerId) {
      // Matched existing speaker
      this.consecutiveFrames++;
      const confidence = Math.min(1.0, this.consecutiveFrames / this.minConfidenceFrames);
      
      this.updateSpeaker(match.speakerId, avgFeatures, timestamp);
      this.currentSpeakerId = match.speakerId;
      
      return {
        speakerId: match.speakerId,
        speakerName: this.speakers.get(match.speakerId).name,
        confidence: confidence * match.similarity,
        isNewSpeaker: false,
        features: avgFeatures
      };
    }

    // No match, potentially new speaker
    this.consecutiveFrames++;
    
    if (this.consecutiveFrames >= this.minFramesForNewSpeaker) {
      // Create new speaker
      const speakerId = this.createNewSpeaker(avgFeatures, timestamp);
      this.currentSpeakerId = speakerId;
      this.consecutiveFrames = 0;
      
      return {
        speakerId: speakerId,
        speakerName: `Speaker ${speakerId}`,
        confidence: 0.5, // Medium confidence for new speaker
        isNewSpeaker: true,
        features: avgFeatures
      };
    }

    // Not enough frames yet
    return {
      speakerId: this.currentSpeakerId,
      speakerName: this.currentSpeakerId ? `Speaker ${this.currentSpeakerId}` : null,
      confidence: 0.3,
      isNewSpeaker: false,
      features: avgFeatures
    };
  }

  /**
   * Associate audio features with a known speaker name from DOM
   * This helps the system learn speaker characteristics for future fallback
   * Returns high confidence since DOM provided the name
   */
  associateKnownSpeaker(speakerName, features, timestamp) {
    // Check if we have this named speaker already
    let speakerId = null;
    for (const [id, speaker] of this.speakers.entries()) {
      if (speaker.name === speakerName) {
        speakerId = id;
        break;
      }
    }

    if (speakerId) {
      // Update existing speaker with new features
      this.updateSpeaker(speakerId, features, timestamp);
    } else {
      // Check if current speaker is a generic "Speaker N" that should be renamed
      if (this.currentSpeakerId && this.speakers.has(this.currentSpeakerId)) {
        const currentSpeaker = this.speakers.get(this.currentSpeakerId);
        // If current speaker has a generic name like "Speaker 1", rename it
        if (currentSpeaker.name.startsWith('Speaker ')) {
          console.log(`[Audio Diarization] Renaming ${currentSpeaker.name} to ${speakerName}`);
          currentSpeaker.name = speakerName;
          this.updateSpeaker(this.currentSpeakerId, features, timestamp);
          speakerId = this.currentSpeakerId;
        } else {
          // Different speaker, create new one
          speakerId = this.createNewSpeaker(features, timestamp, speakerName);
        }
      } else {
        // No current speaker, create new one
        speakerId = this.createNewSpeaker(features, timestamp, speakerName);
      }
    }

    this.currentSpeakerId = speakerId;
    this.consecutiveFrames++;

    // Return high confidence and indicate this is NOT from pure audio diarization
    return {
      speakerId: speakerId,
      speakerName: speakerName, // Always return the real name, not generic
      confidence: 1.0, // High confidence when DOM provides name
      isNewSpeaker: false, // Not a new speaker detection, just feature learning
      features: features,
      isDomProvided: true // Flag to indicate DOM provided this name
    };
  }

  /**
   * Find matching speaker based on audio features
   */
  findMatchingSpeaker(features) {
    let bestMatch = null;
    let bestSimilarity = 0;

    for (const [id, speaker] of this.speakers.entries()) {
      const similarity = this.calculateSimilarity(features, speaker.features);
      
      if (similarity > bestSimilarity && similarity >= this.similarityThreshold) {
        bestSimilarity = similarity;
        bestMatch = id;
      }
    }

    return {
      speakerId: bestMatch,
      similarity: bestSimilarity
    };
  }

  /**
   * Create new speaker entry
   */
  createNewSpeaker(features, timestamp, name = null) {
    const speakerId = this.nextSpeakerId++;
    const speakerName = name || `Speaker ${speakerId}`;
    
    this.speakers.set(speakerId, {
      features: features,
      lastSeen: timestamp,
      name: speakerName,
      frameCount: 1
    });

    console.log(`[Audio Diarization] Created new speaker: ${speakerName} (ID: ${speakerId})`);
    return speakerId;
  }

  /**
   * Update speaker features (moving average)
   */
  updateSpeaker(speakerId, features, timestamp) {
    const speaker = this.speakers.get(speakerId);
    if (!speaker) return;

    // Moving average of features
    const alpha = 0.7; // Weight for new features
    speaker.features = {
      energy: alpha * features.energy + (1 - alpha) * speaker.features.energy,
      zeroCrossingRate: alpha * features.zeroCrossingRate + (1 - alpha) * speaker.features.zeroCrossingRate,
      spectralCentroid: alpha * features.spectralCentroid + (1 - alpha) * speaker.features.spectralCentroid,
      pitch: alpha * features.pitch + (1 - alpha) * speaker.features.pitch,
      energyDistribution: {
        low: alpha * features.energyDistribution.low + (1 - alpha) * speaker.features.energyDistribution.low,
        mid: alpha * features.energyDistribution.mid + (1 - alpha) * speaker.features.energyDistribution.mid,
        high: alpha * features.energyDistribution.high + (1 - alpha) * speaker.features.energyDistribution.high
      }
    };
    
    speaker.lastSeen = timestamp;
    speaker.frameCount++;
  }

  /**
   * Average features across multiple frames
   */
  averageFeatures(featureArray) {
    if (featureArray.length === 0) return null;

    const avg = {
      energy: 0,
      zeroCrossingRate: 0,
      spectralCentroid: 0,
      pitch: 0,
      energyDistribution: { low: 0, mid: 0, high: 0 }
    };

    for (const features of featureArray) {
      avg.energy += features.energy;
      avg.zeroCrossingRate += features.zeroCrossingRate;
      avg.spectralCentroid += features.spectralCentroid;
      avg.pitch += features.pitch;
      avg.energyDistribution.low += features.energyDistribution.low;
      avg.energyDistribution.mid += features.energyDistribution.mid;
      avg.energyDistribution.high += features.energyDistribution.high;
    }

    const count = featureArray.length;
    avg.energy /= count;
    avg.zeroCrossingRate /= count;
    avg.spectralCentroid /= count;
    avg.pitch /= count;
    avg.energyDistribution.low /= count;
    avg.energyDistribution.mid /= count;
    avg.energyDistribution.high /= count;

    return avg;
  }

  /**
   * Clean up inactive speakers
   */
  cleanupInactiveSpeakers(currentTimestamp) {
    for (const [id, speaker] of this.speakers.entries()) {
      if (currentTimestamp - speaker.lastSeen > this.speakerTimeoutMs) {
        console.log(`[Audio Diarization] Removing inactive speaker: ${speaker.name} (ID: ${id})`);
        this.speakers.delete(id);
      }
    }
  }

  /**
   * Get speaker statistics
   */
  getSpeakerStats() {
    const stats = [];
    for (const [id, speaker] of this.speakers.entries()) {
      stats.push({
        id: id,
        name: speaker.name,
        frameCount: speaker.frameCount,
        lastSeen: speaker.lastSeen,
        pitch: speaker.features.pitch.toFixed(1),
        energy: speaker.features.energy.toFixed(2)
      });
    }
    return stats;
  }

  /**
   * Reset diarization state
   */
  reset() {
    this.speakers.clear();
    this.currentSpeakerId = null;
    this.nextSpeakerId = 1;
    this.featureHistory = [];
    this.consecutiveFrames = 0;
  }
}
