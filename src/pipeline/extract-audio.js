/**
 * Stage A3: Audio Track Extraction
 * Extracts 16kHz mono WAV audio from video files using FFmpeg.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { getFFmpegPath } = require('./sample-frames');
const logger = require('../utils/logger');

/**
 * Extracts 16kHz mono WAV from an MP4 video file for speech transcription.
 * @param {string} videoPath
 * @param {string} outputWavPath
 * @returns {Promise<{ wavPath: string, sizeBytes: number }>}
 */
async function extractAudio(videoPath, outputWavPath) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  const outputDir = path.dirname(outputWavPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ffmpegBin = getFFmpegPath();
  const args = [
    '-y',
    '-i',
    videoPath,
    '-vn',
    '-acodec',
    'pcm_s16le',
    '-ar',
    '16000',
    '-ac',
    '1',
    outputWavPath,
  ];

  logger.info('Extracting audio track via FFmpeg...', { videoPath, outputWavPath });

  await new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, (err, stdout, stderr) => {
      if (err) {
        logger.error('Audio extraction failed', { error: err.message, stderr });
        return reject(err);
      }
      resolve();
    });
  });

  const stats = fs.statSync(outputWavPath);
  logger.info('Audio extracted successfully', { sizeBytes: stats.size });

  return {
    wavPath: outputWavPath,
    sizeBytes: stats.size,
  };
}

module.exports = {
  extractAudio,
};
