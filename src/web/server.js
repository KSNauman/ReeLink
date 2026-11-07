/**
 * ReelLink Web Server
 * Provides a lightweight local HTTP dashboard and control API for on-demand batch execution.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');

class ReelLinkWebServer {
  constructor(options = {}) {
    this.app = options.app || null;
    this.queue = options.queue || (this.app ? this.app.queue : null);
    this.port = parseInt(options.port || process.env.PORT || process.env.WEB_PORT || '3000', 10);
    this.server = null;
    this.htmlPath = path.join(__dirname, 'dashboard.html');
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        const parsedUrl = new URL(req.url, `http://localhost:${this.port}`);
        const pathname = parsedUrl.pathname;

        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        try {
          // 1. Dashboard UI HTML
          if (pathname === '/' && req.method === 'GET') {
            fs.readFile(this.htmlPath, 'utf8', (err, html) => {
              if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Error loading dashboard: ' + err.message);
                return;
              }
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(html);
            });
            return;
          }

          // 2. Status API
          if (pathname === '/api/status' && req.method === 'GET') {
            const data = this.getStatusData();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(data));
            return;
          }

          // 3. Trigger Batch Execution API
          if (pathname === '/api/start' && req.method === 'POST') {
            if (!this.app) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'App orchestrator not attached to web server' }));
              return;
            }

            if (this.app.isBatchRunning) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'A batch run is already in progress' }));
              return;
            }

            // Trigger batch execution in background
            this.app.startBatch({ triggeredBy: 'WEB_DASHBOARD' }).catch(err => {
              logger.error('Error executing batch triggered via Web Dashboard', { error: err.message });
            });

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Batch run initiated successfully' }));
            return;
          }

          // 4. Stop Batch API
          if (pathname === '/api/stop' && req.method === 'POST') {
            if (this.app && typeof this.app.stopBatch === 'function') {
              this.app.stopBatch();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Batch run stopped' }));
              return;
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, message: 'Stop not supported or not running' }));
            return;
          }

          // 5. Unfollow Creators API (Smart 2-Day Retention)
          if (pathname === '/api/unfollow' && req.method === 'POST') {
            if (!this.app) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'App orchestrator not attached' }));
              return;
            }
            if (this.app.isBatchRunning) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: false, error: 'Cannot unfollow while a batch job is actively running' }));
              return;
            }

            let bodyStr = '';
            req.on('data', chunk => bodyStr += chunk);
            req.on('end', async () => {
              try {
                const body = bodyStr ? JSON.parse(bodyStr) : {};
                const forceAll = body.forceAll === true;
                const minAgeHours = body.minAgeHours !== undefined ? parseInt(body.minAgeHours, 10) : 48;

                const queue = this.queue || this.app.queue;
                const data = queue.getFollowedCreatorsForUnfollow({ minAgeHours });
                const targets = (forceAll || data.eligible.length === 0) ? data.all : data.eligible;

                if (targets.length === 0) {
                  res.writeHead(200, { 'Content-Type': 'application/json' });
                  res.end(JSON.stringify({ success: true, count: 0, unfollowed: [], message: 'No creators to unfollow' }));
                  return;
                }

                this.app._addLog(`Starting unfollow for ${targets.length} creator(s) (2-day retention mode)...`);
                const unfollowed = [];
                const failed = [];

                for (const t of targets) {
                  const creatorName = t.creator;
                  try {
                    const resDirect = await this.app.inbox.unfollowCreatorDirect(creatorName, { isSimulation: !this.app.isLiveMode });
                    if (resDirect && resDirect.success) {
                      unfollowed.push(creatorName);
                      queue.markCreatorUnfollowed(creatorName);
                    } else {
                      failed.push(creatorName);
                    }
                  } catch (err) {
                    failed.push(creatorName);
                  }
                  await new Promise(r => setTimeout(r, 1200));
                }

                this.app._addLog(`Unfollow complete: ${unfollowed.length} unfollowed, ${data.protected.length} protected.`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                  success: true,
                  count: unfollowed.length,
                  unfollowed,
                  failed,
                  protectedCount: data.protected.length,
                  message: `Successfully unfollowed ${unfollowed.length} creator(s)`,
                }));
              } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
              }
            });
            return;
          }

          // 404 Fallback
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } catch (err) {
          logger.error('Web server request error', { error: err.message });
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });

      this.server.listen(this.port, () => {
        logger.info(`🌐 ReelLink Web Dashboard listening at http://localhost:${this.port}`);
        resolve(this.server);
      });

      this.server.on('error', (err) => {
        logger.error('Web server failed to start', { port: this.port, error: err.message });
        reject(err);
      });
    });
  }

  getStatusData() {
    const queue = this.queue || (this.app ? this.app.queue : null);
    const stats = queue ? queue.getSystemStats() : {};
    const recentJobs = queue ? queue.getRecentJobs(8) : [];
    const followedToday = queue ? queue.getFollowedCreatorsToday() : [];
    const unfollowOverview = queue && typeof queue.getFollowedCreatorsForUnfollow === 'function'
      ? queue.getFollowedCreatorsForUnfollow({ minAgeHours: 48 })
      : { eligible: [], protected: [], all: [] };

    return {
      status: this.app ? (this.app.batchStatus || 'IDLE') : 'IDLE',
      isBatchRunning: Boolean(this.app && this.app.isBatchRunning),
      isLiveMode: Boolean(this.app && this.app.isLiveMode),
      autoApprove: Boolean(this.app && this.app.autoApprove),
      batchProgress: (this.app && this.app.batchProgress) || { current: 0, total: 0, summary: 'Idle' },
      queue: {
        pending: stats.pending || 0,
        awaiting_approval: stats.awaiting_approval || 0,
        processing: stats.processing || 0,
        completed: stats.completed || 0,
        failed: stats.failed || 0,
        total: stats.total || 0,
      },
      recentJobs,
      followedToday,
      unfollowOverview,
      recentLogs: (this.app && this.app.recentLogs) || [],
      uptime: this.app ? Math.floor((Date.now() - this.app.startTime) / 1000) : 0,
    };
  }

  close() {
    if (this.server) {
      return new Promise((resolve) => {
        this.server.close(() => {
          logger.info('Web server closed');
          resolve();
        });
      });
    }
    return Promise.resolve();
  }
}

module.exports = { ReelLinkWebServer };

