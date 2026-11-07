const dns = require('dns').promises;
const http = require('http');
const http2 = require('http2');
const https = require('https');
const logger = require('../utils/logger');

/**
 * Checks if an IPv4 address belongs to a private, loopback, or link-local subnet.
 * @param {string} ip
 * @returns {boolean} true if private/unsafe
 */
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return true;

  // 127.0.0.0/8 (Loopback)
  if (parts[0] === 127) return true;
  // 10.0.0.0/8 (Private Class A)
  if (parts[0] === 10) return true;
  // 172.16.0.0/12 (Private Class B)
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  // 192.168.0.0/16 (Private Class C)
  if (parts[0] === 192 && parts[1] === 168) return true;
  // 169.254.0.0/16 (Link-local & Cloud Metadata 169.254.169.254)
  if (parts[0] === 169 && parts[1] === 254) return true;
  // 0.0.0.0/8 (Current network)
  if (parts[0] === 0) return true;

  return false;
}

/**
 * Checks if an IPv6 address belongs to a loopback, unique local, link-local,
 * documentation, or mapped subnet.
 * @param {string} ip
 * @returns {boolean} true if private/unsafe
 */
function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();

  // Loopback and unspecified
  if (lower === '::1' || lower === '::' || lower === '0:0:0:0:0:0:0:1' || lower === '0:0:0:0:0:0:0:0') {
    return true;
  }

  // Link-local unicast (fe80::/10)
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) {
    return true;
  }

  // Unique local addresses (fc00::/7 - fc00:: and fd00::)
  if (lower.startsWith('fc') || lower.startsWith('fd')) {
    return true;
  }

  // Documentation / benchmark prefixes (2001:db8::/32, 2001:2::/48)
  if (lower.startsWith('2001:db8') || lower.startsWith('2001:2:')) {
    return true;
  }

  // IPv4-mapped IPv6 addresses (::ffff:0:0/96)
  if (lower.includes('::ffff:')) {
    const parts = lower.split('::ffff:');
    const suffix = parts[1];
    if (suffix.includes('.')) {
      return isPrivateIPv4(suffix);
    }
  }

  return false;
}

/**
 * Validates a URL against protocol restrictions, invalid hostnames, and SSRF ranges.
 * @param {string} rawUrl
 * @returns {Promise<{ safe: boolean, reason?: string, resolvedIps?: string[] }>}
 */
async function validateUrlSafety(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    return { safe: false, reason: 'Empty or non-string URL' };
  }

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (err) {
    return { safe: false, reason: `Malformed URL: ${err.message}` };
  }

  // 1. Enforce HTTP/HTTPS only
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { safe: false, reason: `Forbidden protocol: ${parsed.protocol}` };
  }

  const hostname = parsed.hostname.toLowerCase();

  // 2. Reject obvious localhost / internal hostnames
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    return { safe: false, reason: 'Forbidden internal hostname' };
  }

  // 3. Resolve DNS and inspect all IP records
  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      return { safe: false, reason: 'DNS lookup returned no records' };
    }

    const resolvedIps = records.map(r => r.address);

    for (const record of records) {
      const isUnsafe = record.family === 6 ? isPrivateIPv6(record.address) : isPrivateIPv4(record.address);
      if (isUnsafe) {
        logger.security('SSRF Attempt Blocked', {
          url: rawUrl,
          hostname,
          blockedIp: record.address,
        });
        return {
          safe: false,
          reason: `Resolved IP ${record.address} is within a restricted/private network range`,
          resolvedIps,
        };
      }
    }

    return { safe: true, resolvedIps };
  } catch (err) {
    return { safe: false, reason: `DNS lookup failed: ${err.message}` };
  }
}

/**
 * Safely resolves redirects for a URL up to maxHops.
 * Validates safety on EVERY hop to prevent SSRF redirect bypasses.
 * @param {string} targetUrl
 * @param {number} maxHops
 * @returns {Promise<{ finalUrl: string, hops: number, status: number }>}
 */
async function resolveRedirects(targetUrl, maxHops = 5) {
  let currentUrl = targetUrl;
  let hops = 0;

  while (hops < maxHops) {
    const safety = await validateUrlSafety(currentUrl);
    if (!safety.safe) {
      throw new Error(`Unsafe URL encountered during redirect resolution: ${safety.reason}`);
    }

    const parsed = new URL(currentUrl);
    const client = parsed.protocol === 'https:' ? https : http;
    const validatedIp = safety.resolvedIps[0];

    const res = await new Promise((resolve, reject) => {
      const req = client.request(
        currentUrl,
        {
          method: 'HEAD',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ReelLink/1.0',
          },
          timeout: 8000,
          // DNS Rebinding Defense: Use the exact pre-validated IP address
          lookup: (hostname, opts, cb) => {
            const family = validatedIp.includes(':') ? 6 : 4;
            const callback = typeof opts === 'function' ? opts : cb;
            if (typeof opts === 'object' && opts && opts.all) {
              return callback(null, [{ address: validatedIp, family }]);
            }
            return callback(null, validatedIp, family);
          },
        },
        response => {
          resolve(response);
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Connection timed out during HEAD request'));
      });
      req.end();
    });

    const status = res.statusCode;
    if (status >= 300 && status < 400 && res.headers.location) {
      const nextUrl = new URL(res.headers.location, currentUrl).toString();
      logger.debug(`Redirect hop [${hops + 1}]: ${currentUrl} -> ${nextUrl}`);
      currentUrl = nextUrl;
      hops++;
    } else {
      return { finalUrl: currentUrl, hops, status };
    }
  }

  throw new Error(`Exceeded maximum redirect hops (${maxHops})`);
}

module.exports = {
  validateUrlSafety,
  resolveRedirects,
  isPrivateIPv4,
  isPrivateIPv6,
};
