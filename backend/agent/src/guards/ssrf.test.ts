import { describe, expect, it } from 'vitest';
import { vetUrl } from './ssrf.js';

/** Injectable resolver: host → addresses. Tests never touch real DNS. */
const resolver = (table: Record<string, string[]>) => async (host: string) => {
  const addrs = table[host];
  if (!addrs) throw new Error(`ENOTFOUND ${host}`);
  return addrs;
};

const publicOnly = resolver({ 'example.com': ['93.184.216.34'] });

describe('vetUrl', () => {
  it('accepts a public https URL and carries the resolved address', async () => {
    const vetted = await vetUrl('https://example.com/page?id=1', publicOnly);
    expect(vetted.url).toBe('https://example.com/page?id=1');
    expect(vetted.address).toBe('93.184.216.34');
  });

  it.each(['ftp://example.com/x', 'file:///etc/passwd', 'javascript:alert(1)'])(
    'rejects non-http(s) scheme %s',
    async (url) => {
      await expect(vetUrl(url, publicOnly)).rejects.toThrow();
    }
  );

  it('rejects credentials embedded in the URL', async () => {
    await expect(vetUrl('https://user:pass@example.com/', publicOnly)).rejects.toThrow();
  });

  it.each([
    'http://10.0.0.8/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://127.0.0.1:8000/health',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[fe80::1]/',
    'http://[::ffff:127.0.0.1]/'
  ])('rejects literal private/reserved address %s', async (url) => {
    await expect(vetUrl(url, publicOnly)).rejects.toThrow();
  });

  it('rejects the GCP metadata endpoint 169.254.169.254 — a live threat on Cloud Run', async () => {
    await expect(vetUrl('http://169.254.169.254/computeMetadata/v1/', publicOnly)).rejects.toThrow();
  });

  it('rejects a hostname whose DNS resolves only to private addresses (rebinding defense)', async () => {
    const evil = resolver({ 'internal.attacker.dev': ['169.254.169.254'] });
    await expect(vetUrl('https://internal.attacker.dev/', evil)).rejects.toThrow();
  });

  it('rejects a hostname resolving to a mix that includes a private address', async () => {
    const mixed = resolver({ 'flaky.example': ['93.184.216.34', '10.0.0.5'] });
    await expect(vetUrl('https://flaky.example/', mixed)).rejects.toThrow();
  });
});
