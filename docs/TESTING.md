# ReelLink Testing Strategy & Test Suite Guide

> **Version:** 1.0.0  
> **Status:** Active Guide  
> **Test Runner:** Node.js Native Test Runner (`node --test`) & Custom Integration Scripts

---

## 1. Testing Philosophy

1. **Deterministic Local Fixtures:** Do not rely on external network calls or live Instagram availability for routine unit and regression testing. Use synthetic test fixtures for video files, audio tracks, and HTML search results.
2. **Fast Feedback Loop:** The core test suite (unit + security + queue) must run in under 10 seconds.
3. **No Hallucinated Passes:** Tests must assert against explicit concrete values, regexes, and database states. Never mock away the actual logic being tested.
4. **Reproducible CLI Commands:** Every test script must be directly runnable via standard terminal commands.

---

## 2. Test Architecture & Directory Layout

```
tests/
  fixtures/                      # Synthetic media & mock data
    sample-reel-metadata.json    # Example Instagram API/DOM payload
    test_ocr_frame.png           # Rendered high-contrast test image
    test_synthetic_reel.mp4      # FFmpeg lavfi synthetic test video
    whisper_test_tone.wav        # 16kHz sine tone test audio
  unit/                          # Isolated unit tests (fast, deterministic)
    test-url-regex.js            # Reel shortcode & URL parsing (4 tests)
    test-security-ssrf.js        # Private IPv4/IPv6 blocking & SSRF defense (4 tests)
    test-query-builder.js        # Search query formulation heuristics (2 tests)
    test-candidate-ranking.js    # Evidence scoring heuristics (3 tests)
    test-queue.js                # SQLite job state machine & deduplication (1 test)
    test-extract-reel.js         # Early stopping & caption parsing (2 tests)
    test-process-resource.js     # Resource classification & redirects (2 tests)
  integration/                   # Subsystem & tool integration tests
    test-ffmpeg-sampling.js      # FFmpeg frame extraction & dedup (1 test)
    test-ocr.js                  # Local Tesseract OCR extraction accuracy (1 test)
    test-whisper.js              # Real Python faster-whisper CPU inference (1 test)
    test-inbox-selectors.js      # Playwright DOM parsing & DM dispatch (1 test)
  e2e/                           # End-to-end flow tests
    test-full-pipeline.js        # Synthetic Reel ingestion -> delivery (1 test)
  live-test-supervised.js        # Controlled operator-supervised test runner
```

---

## 3. Test Suites & Reproducible Commands

### A. Run All Tests (23 Tests Across All Suites)
```powershell
npm.cmd test
```
*Executes all Unit, Integration, and E2E suites. Current benchmark: 9.3s total duration, 100% pass.*

### B. Controlled Live-Test & Supervised Audit Runner
Safely tests the end-to-end pipeline with any Reel URL without sending real messages by default:
```powershell
node tests/live-test-supervised.js "https://www.instagram.com/reel/C8AbCdEfGhI/"
```
- By default executes in **`DRY-RUN`** mode: extracts clues, searches public candidates, validates SSRF, and prints the exact proposed outgoing DM. Zero messages dispatched.
- To execute with supervised terminal confirmation:
  ```powershell
  node tests/live-test-supervised.js "https://www.instagram.com/reel/C8AbCdEfGhI/" --send
  ```

### C. Verify SQLite Job Lifecycle & Recovery
Tests job creation, duplicate prevention, crash recovery, and status transitions:
```powershell
node tests/unit/test-queue.js
```

### D. Verify Content Extraction Subsystems
Tests FFmpeg frame sampling, Tesseract OCR, and Whisper transcription:
```powershell
node tests/integration/test-ffmpeg-sampling.js
node tests/integration/test-tesseract-ocr.js
python tests/integration/test-whisper.py
```

### E. Verify Instagram Browser Session & Inbox
Runs the persistent Playwright session check:
```powershell
node tests/e2e/test-inbox-poller.js
```

---

## 4. Test Pass / Fail Criteria Matrix

| Test Suite | Metric / Assertion | Acceptance Threshold |
| :--- | :--- | :--- |
| **URL Regex & Parser** | Shortcode extraction from 10 URL variants | 100% pass |
| **SSRF Security** | Rejection of private & link-local IPs | 100% rejected |
| **Job Queue State** | Duplicate detection on identical shortcode | 100% deduplicated |
| **Crash Recovery** | Resuming stuck `EXTRACTING` jobs after SIGKILL | 100% recovered |
| **OCR Accuracy** | Detection of repository URL from test frame | Exact substring match |
| **Whisper Transcription**| Word error rate on synthetic speech clip | $\text{WER} < 15\%$ |
| **Search Ranking** | Expected target URL ranked #1 | Confidence $\ge 0.70$ |
| **PDF Extraction** | Extraction of embedded links & page text | Valid JSON output |

---

## 5. Known Testing Limitations

1. **Instagram Rate Limits:** Repeated automated logins and rapid polling during e2e testing can trigger temporary checkpoints. E2E tests should use recorded sessions or mock DOM snapshots where possible.
2. **CUDA Hardware Differences:** CI or machines without an NVIDIA GPU must execute transcription tests with `WHISPER_DEVICE=cpu`.
3. **External Search Variability:** Web search results can change dynamically over time. Heuristic ranking tests must test score logic with cached HTML before testing live search engines.

---

## 6. Real-World Ground-Truth Benchmark Dataset

To evaluate ReelLink against real Instagram Reels without hardcoding links, ground-truth test cases are stored in:
📁 [`tests/fixtures/benchmark-reels.json`](file:///c:/ReelLink/tests/fixtures/benchmark-reels.json)

### Running Benchmark Evaluations:
```powershell
npm.cmd run test:benchmark
```

### Registered Benchmark Cases:
| Case ID | Reel URL | Creator | CTA Keyword | Expected Target URL | Expected Domains |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `reel_google_alloydb_agents` | `https://www.instagram.com/reels/DejqsFyJhes/` | `@meghna_1500` | `GOOGLE` | `https://rsvp.withgoogle.com/events/alloydb-agents` | `rsvp.withgoogle.com`, `withgoogle.com` |

### Adding New Benchmark Cases:
To register a newly discovered Reel and its verified target resource, append an entry to `tests/fixtures/benchmark-reels.json`:
```json
{
  "id": "reel_descriptive_name",
  "shortcode": "<shortcode>",
  "reelUrl": "https://www.instagram.com/reels/<shortcode>/",
  "creator": "<creator_handle>",
  "ctaKeyword": "<KEYWORD>",
  "topic": "<Brief description of promised resource/event>",
  "expectedTargetUrl": "https://<verified_resource_destination_link>",
  "expectedDomains": ["example.com"],
  "notes": "Context regarding creator CTA and promised link."
}
```
The test suite will repeatedly run against these benchmark cases to track extraction accuracy, search formulation recall, and candidate ranking without hardcoding.
