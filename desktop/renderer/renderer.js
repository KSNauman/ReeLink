/* ReelLink desktop window: talks to the main process through window.reellink (preload.js). */
/* global setLmSpeed */
let isBusy = false;
let refreshQueued = false;

const $ = (id) => document.getElementById(id);

// Captions, usernames and keywords come from Instagram: never inject them as HTML.
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

async function refresh() {
  try {
    const data = await window.reellink.getStatus();
    updateUI(data);
  } catch (err) {
    if ($('status-text')) $('status-text').innerText = 'ERROR';
    if ($('status-dot')) {
      $('status-dot').style.background = 'var(--danger)';
      $('status-dot').className = 'status-dot';
    }
  }
}

// Coalesce bursts of update events into one refresh per frame.
function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    refresh();
  });
}

function setStatus(text, color, pulse) {
  if ($('status-text')) $('status-text').innerText = text;
  if ($('status-dot')) {
    $('status-dot').style.background = color;
    $('status-dot').className = pulse ? 'status-dot pulse' : 'status-dot';
  }
}

function updateUI(data) {
  const btnStart = $('btn-start');
  const btnText = $('btn-text');
  const btnStop = $('btn-stop');
  const progressBox = $('progress-box');
  const progressFill = $('progress-fill');
  const progressText = $('progress-text');

  const status = data.status || 'IDLE';
  const task = data.activeTask;
  isBusy = Boolean(task);

  // Mode tag
  const modeTag = $('mode-tag');
  if (modeTag) {
    modeTag.innerText = data.isLiveMode ? 'LIVE' : 'SIMULATION';
    modeTag.classList.toggle('sim', !data.isLiveMode);
  }

  if (task === 'LOGIN') {
    setStatus('Waiting for login...', 'var(--warning)', true);
  } else if (task === 'UNFOLLOW') {
    setStatus('Unfollowing...', 'var(--warning)', true);
  } else if (status === 'SCANNING_INBOX') {
    setStatus('Scanning...', 'var(--warning)', true);
    if (progressBox) progressBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '20%';
    if (progressText) progressText.innerText = 'Scanning inbox...';
  } else if (status === 'PROCESSING') {
    const current = data.batchProgress?.current || 0;
    const total = data.batchProgress?.total || 1;
    const pct = Math.min(100, Math.round((current / total) * 100));
    setStatus(`Processing (${current}/${total})`, 'var(--accent)', true);
    if (btnText) btnText.innerText = `Processing (${current}/${total})`;
    if (progressBox) progressBox.style.display = 'block';
    if (progressFill) progressFill.style.width = `${pct}%`;
    if (progressText) progressText.innerText = data.batchProgress?.summary || 'Processing...';
  } else if (status === 'COLLECTING') {
    setStatus('Collecting links...', 'var(--accent)', true);
    if (progressBox) progressBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.innerText = data.batchProgress?.summary || 'Collecting links...';
  } else if (status === 'UNFOLLOWING') {
    setStatus('Unfollowing...', 'var(--warning)', true);
    if (progressBox) progressBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.innerText = data.batchProgress?.summary || 'Unfollowing...';
  } else if (status === 'COMPLETED') {
    setStatus('Completed', 'var(--success)', false);
    if (progressBox) progressBox.style.display = 'block';
    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.innerText = data.batchProgress?.summary || 'Batch completed';
  } else if (status === 'ERROR') {
    setStatus('Error', 'var(--danger)', false);
    if (progressBox) progressBox.style.display = 'block';
    if (progressText) progressText.innerText = data.batchProgress?.summary || 'Batch error';
  } else {
    setStatus('Ready', 'var(--success)', false);
    if (progressBox) progressBox.style.display = 'none';
  }

  // Buttons
  if (btnStart) btnStart.disabled = isBusy;
  if (btnText && status !== 'PROCESSING') {
    btnText.innerText = task === 'BATCH' ? (status === 'SCANNING_INBOX' ? 'Scanning...' : 'Working...') : 'START BATCH';
  }
  if (btnStop) btnStop.style.display = task === 'BATCH' ? 'inline-flex' : 'none';
  if ($('btn-login')) $('btn-login').disabled = isBusy;
  if ($('btn-unfollow-eligible')) {
    $('btn-unfollow-eligible').disabled = isBusy;
    $('btn-unfollow-eligible').innerText = task === 'UNFOLLOW' ? 'Unfollowing...' : 'Unfollow eligible (48h+)';
  }
  if ($('btn-unfollow-all')) $('btn-unfollow-all').disabled = isBusy;

  const lmRoot = $('liquid-metal-root');
  if (lmRoot) lmRoot.classList.toggle('is-disabled', isBusy);

  // Metrics
  if ($('metric-pending')) $('metric-pending').innerText = data.queue?.pending || 0;
  if ($('metric-completed')) $('metric-completed').innerText = data.queue?.completed || 0;

  // Unfollow overview
  const uo = data.unfollowOverview || { eligible: [], protected: [] };
  if ($('unfollow-summary')) {
    $('unfollow-summary').innerText =
      `${uo.eligible.length} eligible (followed 48h+ ago) · ${uo.protected.length} protected (followed in the last 48h)`;
  }

  // Recent Reels
  const tbody = $('reels-tbody');
  const recent = data.recentJobs || [];
  if (tbody) {
    if (recent.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 20px 14px;">No recent reels.</td></tr>';
    } else {
      tbody.innerHTML = recent.map((j) => {
        let statusTag = `<span class="tag tag-muted">${esc(j.status)}</span>`;
        if (j.status === 'COMPLETED') statusTag = '<span class="tag tag-success">COMPLETED</span>';
        else if (j.status === 'FAILED') statusTag = '<span class="tag tag-fail">FAILED</span>';
        else if (j.status === 'PENDING') statusTag = '<span class="tag tag-blue">PENDING</span>';
        return `
          <tr>
            <td><span style="font-weight: 600;">@${esc(j.creator_username || 'unknown')}</span></td>
            <td><strong style="color: var(--accent);">${esc(j.keyword || '🙌')}</strong></td>
            <td>${statusTag}</td>
          </tr>`;
      }).join('');
    }
  }

  // Activity log
  const consoleBox = $('console-box');
  const logs = data.recentLogs || [];
  if (consoleBox && logs.length > 0) {
    const atBottom = consoleBox.scrollHeight - consoleBox.scrollTop - consoleBox.clientHeight < 40;
    consoleBox.innerHTML = logs.map((l) => `
      <div class="log-entry">
        <span class="log-time">[${esc(l.time)}]</span>
        <span class="log-msg">${esc(l.message)}</span>
      </div>`).join('');
    if (atBottom) consoleBox.scrollTop = consoleBox.scrollHeight;
  }
}

function handleStartBatchClick(e) {
  if (isBusy) return;

  if (typeof setLmSpeed === 'function') {
    setLmSpeed(2.4);
    setTimeout(() => {
      if (!isBusy && typeof setLmSpeed === 'function') setLmSpeed(1.0);
    }, 380);
  }

  const btn = $('btn-start');
  if (btn && e && typeof e.clientX === 'number' && e.clientX > 0) {
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('div');
    ripple.className = 'lm-ripple';
    ripple.style.left = `${e.clientX - rect.left}px`;
    ripple.style.top = `${e.clientY - rect.top}px`;
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);
  }

  triggerBatch();
}

async function triggerBatch() {
  if (isBusy) return;
  isBusy = true;
  if ($('btn-start')) $('btn-start').disabled = true;
  if ($('btn-text')) $('btn-text').innerText = 'Starting...';
  // Resolves when the batch finishes; progress arrives through update events.
  const res = await window.reellink.startBatch();
  if (res && res.success === false && res.error) alert(res.error);
  refresh();
}

async function stopBatch() {
  if (!confirm('Stop after the Reel currently in progress?')) return;
  await window.reellink.stopBatch();
  refresh();
}

async function login() {
  if (isBusy) return;
  alert('A browser window will open. Sign in to the bot\'s Instagram account there; it closes by itself once you reach the home feed.');
  const res = await window.reellink.login();
  alert(res.authenticated ? 'Login saved. You can start a batch now.' : `Login not completed: ${res.reason}`);
  refresh();
}

async function unfollowEligible() {
  if (isBusy) return;
  if (!confirm('Unfollow creators you followed at least 2 days ago? Recently followed creators are kept.')) return;
  const res = await window.reellink.unfollow({ forceAll: false });
  alert(res.message || res.error || `Unfollowed ${res.count} creator(s)`);
  refresh();
}

async function unfollowAll() {
  if (isBusy) return;
  if (!confirm('⚠️ This unfollows ALL tracked creators, including ones followed in the last 2 days. Continue?')) return;
  const res = await window.reellink.unfollow({ forceAll: true });
  alert(res.message || res.error || `Unfollowed ${res.count} creator(s)`);
  refresh();
}

async function openCsv() {
  const res = await window.reellink.openCsv();
  if (!res.ok) alert(res.error);
}

// Wire buttons (no inline handlers: the page CSP forbids them)
$('btn-start')?.addEventListener('click', handleStartBatchClick);
$('btn-stop')?.addEventListener('click', stopBatch);
$('btn-login')?.addEventListener('click', login);
$('btn-open-csv')?.addEventListener('click', openCsv);
$('btn-unfollow-eligible')?.addEventListener('click', unfollowEligible);
$('btn-unfollow-all')?.addEventListener('click', unfollowAll);

// Liquid-metal hover/press effects on the Start button
(function setupLiquidMetalEvents() {
  const btn = $('btn-start');
  const lmRoot = $('liquid-metal-root');
  if (!btn || !lmRoot) return;
  btn.addEventListener('mouseenter', () => {
    if (!isBusy && typeof setLmSpeed === 'function') setLmSpeed(1.2);
  });
  btn.addEventListener('mouseleave', () => {
    lmRoot.classList.remove('is-pressed');
    if (!isBusy && typeof setLmSpeed === 'function') setLmSpeed(0.6);
  });
  btn.addEventListener('mousedown', () => {
    if (!isBusy) lmRoot.classList.add('is-pressed');
  });
  window.addEventListener('mouseup', () => lmRoot.classList.remove('is-pressed'));
})();

// Live updates pushed from the main process, plus a slow safety refresh.
window.reellink.onUpdate(scheduleRefresh);
refresh();
setInterval(refresh, 5000);
