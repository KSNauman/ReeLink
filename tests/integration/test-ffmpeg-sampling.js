const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sampleFrames, getFFmpegPath } = require('../../src/pipeline/sample-frames');
const { extractAudio } = require('../../src/pipeline/extract-audio');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');
const TEST_VIDEO_PATH = path.join(FIXTURE_DIR, 'test_synthetic_reel.mp4');
const FRAMES_OUT_DIR = path.join(FIXTURE_DIR, 'test_frames');
const AUDIO_OUT_PATH = path.join(FIXTURE_DIR, 'test_audio.wav');

function cleanupFixtures() {
  if (fs.existsSync(TEST_VIDEO_PATH)) fs.unlinkSync(TEST_VIDEO_PATH);
  if (fs.existsSync(AUDIO_OUT_PATH)) fs.unlinkSync(AUDIO_OUT_PATH);
  if (fs.existsSync(FRAMES_OUT_DIR)) {
    fs.rmSync(FRAMES_OUT_DIR, { recursive: true, force: true });
  }
}

test('FFmpeg frame sampling & audio extraction: synthetic video pipeline', async () => {
  cleanupFixtures();
  if (!fs.existsSync(FIXTURE_DIR)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  const ffmpegBin = getFFmpegPath();

  // 1. Generate a 3-second synthetic test MP4 video with color bars and a test tone
  // -f lavfi -i testsrc=duration=3:size=640x360:rate=15
  // -f lavfi -i sine=frequency=440:duration=3
  execFileSync(ffmpegBin, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=3:size=640x360:rate=15',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=3',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    TEST_VIDEO_PATH,
  ]);

  assert.ok(fs.existsSync(TEST_VIDEO_PATH), 'Synthetic MP4 video should be generated');

  // 2. Test sampleFrames() with 1-second sampling interval
  const frames = await sampleFrames({
    videoPath: TEST_VIDEO_PATH,
    outputDir: FRAMES_OUT_DIR,
    intervalSec: 1,
    maxFrames: 5,
  });

  assert.ok(frames.length >= 1, 'Should extract at least 1 keyframe');
  assert.ok(fs.existsSync(frames[0].framePath), 'Extracted frame file should exist on disk');
  assert.strictEqual(typeof frames[0].timestampSec, 'number');

  // 3. Test extractAudio() generating 16kHz mono WAV
  const audioResult = await extractAudio(TEST_VIDEO_PATH, AUDIO_OUT_PATH);
  assert.ok(fs.existsSync(AUDIO_OUT_PATH), 'Extracted WAV file should exist on disk');
  assert.ok(audioResult.sizeBytes > 1000, 'Audio file should have valid non-empty size');

  cleanupFixtures();
});
