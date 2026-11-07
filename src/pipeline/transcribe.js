/**
 * Stage A3: Audio Transcription Wrapper
 * Invokes the local Python faster-whisper worker and extracts spoken clues.
 */
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const logger = require('../utils/logger');

const WORKER_SCRIPT = path.resolve(__dirname, '../../worker/transcribe.py');

/**
 * Transcribes an audio file using the local Python Whisper worker.
 * @param {string} audioPath
 * @param {Object} [options]
 * @returns {Promise<{ text: string, segments: Array, status: string, error?: string }>}
 */
async function transcribeAudio(audioPath, options = {}) {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  const pythonBin = config.pipeline.pythonPath || 'python';
  const model = options.model || config.pipeline.whisperModel || 'base';
  const device = options.device || config.pipeline.whisperDevice || 'auto';

  const args = [
    WORKER_SCRIPT,
    '--audio',
    audioPath,
    '--model',
    model,
    '--device',
    device,
  ];

  logger.info('Invoking Python transcription worker...', { audioPath, model, device });

  return new Promise((resolve, reject) => {
    execFile(pythonBin, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && !stdout) {
        logger.error('Transcription worker process error', { error: err.message, stderr });
        return reject(err);
      }

      try {
        const result = JSON.parse(stdout.trim());
        if (result.status === 'unavailable') {
          logger.warn('Whisper worker unavailable', { error: result.error });
        } else if (result.status === 'success') {
          logger.info('Whisper transcription completed', {
            textLength: result.text.length,
            durationSec: result.duration,
            device: result.device,
          });
        }
        resolve(result);
      } catch (parseErr) {
        logger.error('Failed to parse transcription worker JSON output', { stdout, stderr });
        reject(new Error(`Invalid worker response: ${parseErr.message}`));
      }
    });
  });
}

module.exports = {
  transcribeAudio,
};
