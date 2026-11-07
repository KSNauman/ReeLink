/**
 * Stage A2: Video Frame Sampling
 * Samples video frames at configurable intervals using FFmpeg,
 * resizes frames, and performs perceptual deduplication to avoid redundant OCR.
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const ffmpegStatic = require('ffmpeg-static');
const config = require('../config');
const logger = require('../utils/logger');

/**
 * Resolves the path to the best available FFmpeg binary.
 */
function getFFmpegPath() {
  if (ffmpegStatic && fs.existsSync(ffmpegStatic)) {
    return ffmpegStatic;
  }
  return config.pipeline.ffmpegPath || 'ffmpeg';
}

/**
 * Samples frames from a local video file.
 * @param {Object} options
 * @param {string} options.videoPath - Path to input MP4 video
 * @param {string} options.outputDir - Directory to store sampled JPG frames
 * @param {number} [options.intervalSec=2] - Sample interval in seconds (default 2s)
 * @param {number} [options.maxFrames=30] - Maximum frames to extract
 * @returns {Promise<Array<{ framePath: string, frameNumber: number, timestampSec: number }>>}
 */
async function sampleFrames({
  videoPath,
  outputDir,
  intervalSec = config.pipeline.ocrSampleIntervalSec,
  maxFrames = config.pipeline.ocrMaxFrames,
}) {
  if (!fs.existsSync(videoPath)) {
    throw new Error(`Video file not found: ${videoPath}`);
  }

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  const ffmpegBin = getFFmpegPath();
  const outputPattern = path.join(outputDir, 'frame_%04d.jpg');
  const fpsFilter = `fps=1/${intervalSec},scale=1280:-1`;

  logger.info('Starting FFmpeg frame sampling', {
    videoPath,
    intervalSec,
    maxFrames,
    ffmpegBin,
  });

  const args = [
    '-y',
    '-i',
    videoPath,
    '-vf',
    fpsFilter,
    '-vframes',
    String(maxFrames),
    '-q:v',
    '3',
    outputPattern,
  ];

  await new Promise((resolve, reject) => {
    execFile(ffmpegBin, args, (err, stdout, stderr) => {
      if (err) {
        logger.error('FFmpeg frame sampling failed', { error: err.message, stderr });
        return reject(err);
      }
      resolve();
    });
  });

  // Collect generated frames
  const files = fs
    .readdirSync(outputDir)
    .filter(f => /^frame_\d+\.jpg$/.test(f))
    .sort();

  logger.info(`FFmpeg extracted ${files.length} raw frames`);

  // Deduplicate near-identical consecutive frames
  const deduplicatedFrames = [];
  let previousFileSize = 0;

  for (let i = 0; i < files.length; i++) {
    const filename = files[i];
    const framePath = path.join(outputDir, filename);
    const stats = fs.statSync(framePath);
    const frameNumber = i + 1;
    const timestampSec = (frameNumber - 1) * intervalSec;

    // If consecutive frames have nearly identical file size (< 3% difference),
    // they represent a static video frame / talking head, skip redundant OCR
    const sizeDiff = Math.abs(stats.size - previousFileSize) / (previousFileSize || 1);
    if (i > 0 && sizeDiff < 0.03) {
      logger.debug(`Skipping redundant frame ${filename} (size diff: ${(sizeDiff * 100).toFixed(1)}%)`);
      continue;
    }

    previousFileSize = stats.size;
    deduplicatedFrames.push({
      framePath,
      frameNumber,
      timestampSec,
      fileSize: stats.size,
    });
  }

  logger.info(`Retained ${deduplicatedFrames.length} keyframes after deduplication`);
  return deduplicatedFrames;
}

module.exports = {
  sampleFrames,
  getFFmpegPath,
};
