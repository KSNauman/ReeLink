const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { getFFmpegPath } = require('../../src/pipeline/sample-frames');
const { transcribeAudio } = require('../../src/pipeline/transcribe');

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures');
const TEST_WAV_PATH = path.join(FIXTURE_DIR, 'whisper_test_tone.wav');

test('Python Whisper worker: IPC communication and status reporting', async () => {
  if (!fs.existsSync(FIXTURE_DIR)) {
    fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  }

  const ffmpegBin = getFFmpegPath();

  // Generate a short 1-second 16kHz test WAV
  execFileSync(ffmpegBin, [
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-ar',
    '16000',
    '-ac',
    '1',
    TEST_WAV_PATH,
  ]);

  assert.ok(fs.existsSync(TEST_WAV_PATH), 'Test WAV file should exist');

  // Invoke Python worker via transcribeAudio
  const result = await transcribeAudio(TEST_WAV_PATH, { model: 'tiny', device: 'cpu' });

  // Verify real Whisper transcription executed successfully
  assert.strictEqual(result.status, 'success', 'Whisper worker should successfully execute transcription');
  assert.strictEqual(result.device, 'cpu', 'Should use CPU device fallback');
  assert.strictEqual(typeof result.duration, 'number', 'Should report audio duration');

  if (fs.existsSync(TEST_WAV_PATH)) {
    fs.unlinkSync(TEST_WAV_PATH);
  }
});
