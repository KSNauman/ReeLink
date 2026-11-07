const test = require('node:test');
const assert = require('node:assert');
const { validateUrlSafety, isPrivateIPv4 } = require('../../src/security/validate-url');

test('isPrivateIPv4: identifies private, loopback, and link-local ranges', () => {
  assert.strictEqual(isPrivateIPv4('127.0.0.1'), true, 'Loopback should be private');
  assert.strictEqual(isPrivateIPv4('127.255.255.255'), true);
  assert.strictEqual(isPrivateIPv4('10.0.0.1'), true, 'Class A private');
  assert.strictEqual(isPrivateIPv4('172.16.0.1'), true, 'Class B private');
  assert.strictEqual(isPrivateIPv4('172.31.255.255'), true, 'Class B private');
  assert.strictEqual(isPrivateIPv4('192.168.1.1'), true, 'Class C private');
  assert.strictEqual(isPrivateIPv4('169.254.169.254'), true, 'Link-local cloud metadata');
  assert.strictEqual(isPrivateIPv4('0.0.0.0'), true);

  assert.strictEqual(isPrivateIPv4('8.8.8.8'), false, 'Google DNS should be public');
  assert.strictEqual(isPrivateIPv4('140.82.121.4'), false, 'GitHub IP should be public');
});

test('isPrivateIPv6: identifies IPv6 loopback, link-local, and unique-local ranges', () => {
  const { isPrivateIPv6 } = require('../../src/security/validate-url');
  assert.strictEqual(isPrivateIPv6('::1'), true, 'IPv6 loopback');
  assert.strictEqual(isPrivateIPv6('fe80::1'), true, 'IPv6 link-local');
  assert.strictEqual(isPrivateIPv6('fc00::1'), true, 'IPv6 unique-local fc00');
  assert.strictEqual(isPrivateIPv6('fd12:3456:789a::1'), true, 'IPv6 unique-local fd00');
  assert.strictEqual(isPrivateIPv6('2001:db8::1'), true, 'IPv6 documentation');
  assert.strictEqual(isPrivateIPv6('::ffff:127.0.0.1'), true, 'IPv4-mapped loopback');
  assert.strictEqual(isPrivateIPv6('::ffff:192.168.1.1'), true, 'IPv4-mapped private Class C');
  assert.strictEqual(isPrivateIPv6('2606:4700:4700::1111'), false, 'Cloudflare public DNS');
});

test('validateUrlSafety: blocks forbidden protocols and private IPs', async () => {
  const blockedCases = [
    { url: 'file:///C:/Windows/System32/calc.exe', reason: 'Forbidden protocol' },
    { url: 'ftp://ftp.example.com/file.txt', reason: 'Forbidden protocol' },
    { url: 'gopher://127.0.0.1/', reason: 'Forbidden protocol' },
    { url: 'http://localhost:8080/admin', reason: 'Forbidden internal hostname' },
    { url: 'http://127.0.0.1/status', reason: 'restricted/private' },
    { url: 'http://192.168.1.1/router', reason: 'restricted/private' },
    { url: 'http://169.254.169.254/latest/meta-data', reason: 'restricted/private' },
    { url: 'http://10.0.0.5/api', reason: 'restricted/private' },
    { url: 'not-a-url', reason: 'Malformed URL' },
  ];

  for (const { url, reason } of blockedCases) {
    const result = await validateUrlSafety(url);
    assert.strictEqual(result.safe, false, `Expected ${url} to be blocked`);
    assert.ok(result.reason.toLowerCase().includes(reason.toLowerCase()), `Expected reason containing "${reason}", got: ${result.reason}`);
  }
});

test('validateUrlSafety: permits legitimate public HTTPS domains', async () => {
  const allowed = await validateUrlSafety('https://github.com/torvalds/linux');
  assert.strictEqual(allowed.safe, true);
  assert.ok(allowed.resolvedIps.length > 0);
});
