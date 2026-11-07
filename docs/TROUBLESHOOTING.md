# ReelLink Troubleshooting & Operator Runbook

> **Target Audience:** Developers, system operators, and test runners on Windows 10/11.

---

## 1. Quick Diagnostic Checklist

Run these commands in PowerShell from the project root (`c:\ReelLink`) to verify dependencies:

```powershell
node -v                   # Must be >= v18.0.0
npm.cmd -v               # Must be >= 9.0.0
python --version         # Must be >= 3.9.0
npm.cmd test             # Runs all 23 Unit, Integration, and E2E tests
node tests/live-test-supervised.js # Safe controlled dry-run test
```

---

## 2. Dry-Run & Safe Diagnostic Mode
To verify that the complete pipeline (metadata, search, ranking, validation) executes properly without sending any direct messages or touching Instagram Web:
1. Ensure `.env` contains:
   ```ini
   DRY_RUN=true
   ```
2. Run the supervised runner:
   ```powershell
   node tests/live-test-supervised.js
   ```
   *Logs the exact extracted clues, candidate search results, confidence score, and proposed reply without sending any message.*

---

## 2. Windows Environment Issues

### Problem: `npm.ps1 cannot be loaded because running scripts is disabled`
- **Symptom:** Running `npm install` or `npm run dev` in PowerShell yields `PSSecurityException: UnauthorizedAccess`.
- **Root Cause:** Windows PowerShell default execution policy prohibits execution of unsigned `.ps1` script wrappers.
- **Solution:**
  - Option A (Recommended): Invoke `npm.cmd` instead of `npm` (e.g., `npm.cmd install`, `npm.cmd start`).
  - Option B: Adjust current process execution policy in PowerShell:
    ```powershell
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
    ```

---

## 3. Instagram Session & Playwright Issues

### Problem: Instagram prompts for 2FA, SMS code, or "Suspicious Login Attempt"
- **Symptom:** Headless browser fails to reach the inbox or gets redirected to `https://www.instagram.com/challenge/...`.
- **Root Cause:** New device signature or IP address detected by Meta's security system.
- **Solution:**
  1. Set `IG_HEADLESS=false` in `.env`.
  2. Launch the interactive session setup script:
     ```powershell
     npm.cmd run setup:session
     ```
  3. A visible Chromium browser window will open. Complete the login, solve any CAPTCHA or 2FA challenge manually.
  4. Once your inbox (`https://www.instagram.com/direct/inbox/`) is visible, close the browser or press Enter in the terminal.
  5. The session state is stored in `data/browser_profile/`. You can now switch back to `IG_HEADLESS=true`.

### Problem: Browser process lock or `browser_profile` in use error
- **Symptom:** `Error: Browser has been closed or userDataDir is locked by another process.`
- **Root Cause:** A previous Playwright or Chromium instance was terminated abnormally and left a lockfile (`Lock` / `SingletonLock`).
- **Solution:**
  Run the cleanup command in PowerShell:
  ```powershell
  Stop-Process -Name chrome, chromium, msedge -Force -ErrorAction SilentlyContinue
  Remove-Item -Path "data/browser_profile/SingletonLock" -Force -ErrorAction SilentlyContinue
  ```

---

## 4. Video & Content Extraction Issues

### Problem: `ffmpeg: The term 'ffmpeg' is not recognized`
- **Symptom:** Frame sampling or audio extraction throws an error: `spawn ffmpeg ENOENT`.
- **Root Cause:** FFmpeg is not installed or not added to the system `PATH`.
- **Solution:**
  Install FFmpeg via winget:
  ```powershell
  winget install Gyan.FFmpeg
  ```
  Or specify the full path in `.env`:
  ```ini
  FFMPEG_PATH=C:\ProgramData\chocolatey\bin\ffmpeg.exe
  ```

### Problem: `tesseract: The term 'tesseract' is not recognized`
- **Symptom:** Optical Character Recognition stage fails with `spawn tesseract ENOENT`.
- **Root Cause:** Tesseract OCR engine is not installed on the Windows PC.
- **Solution:**
  Install Tesseract via winget:
  ```powershell
  winget install UB-Mannheim.TesseractOCR
  ```
  The default installation path is `C:\Program Files\Tesseract-OCR\tesseract.exe`. Set in `.env`:
  ```ini
  TESSERACT_PATH=C:\Program Files\Tesseract-OCR\tesseract.exe
  ```

---

## 5. Audio Transcription (faster-whisper) Issues

### Problem: Python worker crashes with CUDA or cuDNN missing
- **Symptom:** `RuntimeError: Library cublas64_12.dll is not found` or crash on model initialization.
- **Root Cause:** `WHISPER_DEVICE=cuda` was selected, but the local CUDA toolkit or cuDNN is mismatched.
- **Solution:**
  Change Whisper device to CPU mode in `.env`:
  ```ini
  WHISPER_DEVICE=cpu
  WHISPER_MODEL=base
  ```
  `faster-whisper` on CPU uses optimized INT8 quantization and runs reliably without GPU requirements.

---

## 6. Public Search & Candidate Ranking Issues

### Problem: DuckDuckGo HTML scraping returns 202 or rate-limit challenge
- **Symptom:** `search-web.js` returns zero candidates or an HTML block page.
- **Root Cause:** Excessive consecutive search queries from the same IP triggered anti-bot rate limits.
- **Solution:**
  1. Increase delay between search attempts in `config/search.js`.
  2. Switch to an alternative API adapter in `.env`:
     ```ini
     SEARCH_PROVIDER=serpapi
     SERPAPI_API_KEY=your_key_here
     ```
     Or configure Google Programmable Search Engine (`google_pse`).

---

## 7. Database & SQLite Issues

### Problem: `SqliteError: database is locked`
- **Symptom:** `better-sqlite3` throws locking errors during high concurrent operations.
- **Root Cause:** Journal mode is set to standard DELETE instead of Write-Ahead Logging (WAL).
- **Solution:**
  ReelLink automatically enables WAL mode on startup (`PRAGMA journal_mode = WAL;` and `PRAGMA busy_timeout = 5000;`). Ensure no external SQLite viewers (like DB Browser for SQLite) hold an exclusive write lock on `data/reellink.db`.
