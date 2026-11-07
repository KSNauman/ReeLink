/**
 * Stage A2: Local Optical Character Recognition (OCR) Engine
 * Runs Tesseract OCR on sampled video frames to extract on-screen URLs,
 * repository names (github.com/owner/repo), and key technical entities.
 */
const { createWorker } = require('tesseract.js');
const { extractExternalUrls } = require('../utils/url-helper');
const logger = require('../utils/logger');

// Regex patterns for technical entities commonly displayed in Reel overlays
const GITHUB_REPO_REGEX = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi;
const CLI_PACKAGE_REGEX = /(?:pip\s+install|npm\s+i(?:nstall)?|cargo\s+add|docker\s+pull)\s+([A-Za-z0-9_.-]+)/gi;

class OCREngine {
  constructor() {
    this.worker = null;
    this._isReady = false;
  }

  async _initWorker() {
    if (this._isReady && this.worker) return this.worker;

    logger.info('Initializing local Tesseract OCR worker...');
    this.worker = await createWorker('eng');
    this._isReady = true;
    return this.worker;
  }

  /**
   * Runs OCR on a single image frame.
   * @param {string} imagePath
   * @returns {Promise<{ text: string, confidence: number }>}
   */
  async recognizeFrame(imagePath) {
    const worker = await this._initWorker();
    const ret = await worker.recognize(imagePath);
    return {
      text: ret.data.text || '',
      confidence: ret.data.confidence || 0,
    };
  }

  /**
   * Processes a sequence of sampled video frames and extracts structured clues.
   * @param {Array<{ framePath: string, timestampSec: number }>} frames
   * @returns {Promise<Object>}
   */
  async processFrames(frames = []) {
    if (!frames || frames.length === 0) {
      return {
        extractedText: '',
        detectedUrls: [],
        detectedRepos: [],
        detectedPackages: [],
        frameResults: [],
      };
    }

    logger.info(`Starting OCR on ${frames.length} sampled frames...`);
    const frameResults = [];
    const allText = [];
    const detectedUrls = new Set();
    const detectedRepos = new Set();
    const detectedPackages = new Set();

    for (const frame of frames) {
      try {
        const { text, confidence } = await this.recognizeFrame(frame.framePath);
        const cleanText = text.trim();
        logger.debug('OCR recognized text from frame', { cleanText, confidence });

        if (cleanText.length > 0) {
          allText.push(cleanText);

          // Extract URLs
          const urls = extractExternalUrls(cleanText);
          urls.forEach(u => detectedUrls.add(u));

          // Extract GitHub repo patterns (resilient to OCR spaces around dots and slashes)
          const repoRegex = /github\s*\.\s*com\s*\/\s*([A-Za-z0-9_.-]+)\s*\/\s*([A-Za-z0-9_.-]+)/gi;
          let repoMatch;
          while ((repoMatch = repoRegex.exec(cleanText)) !== null) {
            const owner = repoMatch[1].trim();
            const repo = repoMatch[2].trim().replace(/[.,;:)]+$/, '');
            const repoSlug = `${owner}/${repo}`;
            detectedRepos.add(repoSlug);
            detectedUrls.add(`https://github.com/${repoSlug}`);
          }

          // Extract CLI packages
          const pkgRegex = /(?:pip\s+install|npm\s+i(?:nstall)?|cargo\s+add|docker\s+pull)\s+([A-Za-z0-9_.-]+)/gi;
          let pkgMatch;
          while ((pkgMatch = pkgRegex.exec(cleanText)) !== null) {
            detectedPackages.add(pkgMatch[1]);
          }

          frameResults.push({
            framePath: frame.framePath,
            timestampSec: frame.timestampSec,
            confidence,
            textSnippet: cleanText.substring(0, 100),
          });
        }
      } catch (err) {
        logger.warn(`OCR failed for frame ${frame.framePath}`, { error: err.message });
      }
    }

    const summary = {
      extractedText: allText.join('\n'),
      detectedUrls: [...detectedUrls],
      detectedRepos: [...detectedRepos],
      detectedPackages: [...detectedPackages],
      frameCount: frames.length,
      framesWithText: frameResults.length,
      frameResults,
    };

    logger.info('OCR frame processing completed', {
      framesProcessed: frames.length,
      urlsFound: summary.detectedUrls.length,
      reposFound: summary.detectedRepos.length,
      packagesFound: summary.detectedPackages.length,
    });

    return summary;
  }

  async terminate() {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
      this._isReady = false;
    }
  }
}

module.exports = OCREngine;
