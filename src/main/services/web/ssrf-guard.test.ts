import { describe, it, expect } from 'vitest';
import { assertPublicUrl, isPrivateIp, isUnsafeUrlSync, UnsafeUrlError } from './ssrf-guard';

describe('isPrivateIp', () => {
  it('flags loopback / private / link-local / metadata / CGNAT', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fd12::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
  });
  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '93.184.216.34', '2001:4860:4860::8888']) {
      expect(isPrivateIp(ip), ip).toBe(false);
    }
  });
});

describe('isUnsafeUrlSync', () => {
  it('rejects non-http(s) schemes', () => {
    for (const u of ['file:///etc/passwd', 'ftp://host/x', 'javascript:alert(1)', 'data:text/html,x', 'not a url']) {
      expect(isUnsafeUrlSync(u), u).toBe(true);
    }
  });
  it('rejects local / private / metadata hosts', () => {
    for (const u of ['http://localhost/x', 'http://app.local', 'http://x.internal', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1', 'http://169.254.169.254', 'http://[::1]/', 'http://172.16.0.1']) {
      expect(isUnsafeUrlSync(u), u).toBe(true);
    }
  });
  it('allows public http(s) hosts', () => {
    for (const u of ['https://example.com/page', 'http://example.org', 'https://93.184.216.34/', 'http://172.32.0.1']) {
      expect(isUnsafeUrlSync(u), u).toBe(false);
    }
  });
});

describe('assertPublicUrl', () => {
  it('rejects invalid URLs', async () => {
    await expect(assertPublicUrl('not a url')).rejects.toMatchObject({ reason: 'invalid' });
  });
  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toMatchObject({ reason: 'protocol' });
  });
  it('rejects literal private / loopback / metadata IPs before any DNS', async () => {
    for (const u of ['http://127.0.0.1', 'http://169.254.169.254', 'http://10.0.0.1', 'http://[::1]/']) {
      await expect(assertPublicUrl(u), u).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });
  it('rejects local hostnames', async () => {
    await expect(assertPublicUrl('http://localhost:8080')).rejects.toMatchObject({ reason: 'private' });
  });
  it('allows a public literal IP (numeric lookup, no network)', async () => {
    const url = await assertPublicUrl('http://8.8.8.8/path');
    expect(url.hostname).toBe('8.8.8.8');
  });
});
