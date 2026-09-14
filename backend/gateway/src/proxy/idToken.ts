/**
 * Cloud Run IAM ID tokens — ARCHITECTURE.md §6.1. The agent service is
 * `--no-allow-unauthenticated`; only the gateway's runtime service account holds
 * `run.invoker`, and it proves that on every hop with an ID token minted by the metadata
 * server for the agent's URL as audience. No SDK: the metadata endpoint is one HTTP GET, and
 * the only parsing needed is the JWT's `exp` so the token is reused until shortly before it
 * expires.
 *
 * Fail loud: if the gateway is configured to mint tokens and cannot, the request fails HERE
 * with the metadata server's status, not later as an unexplained 403 from the agent.
 */
const METADATA_IDENTITY =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity';

/** Refresh this long before `exp`, so a token never expires in flight. */
const REFRESH_MARGIN_S = 60;

export interface IdTokenOptions {
  audience: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}

function expiryOf(jwt: string): number {
  const payload = jwt.split('.')[1];
  if (!payload) throw new Error('id token: not a JWT');
  const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: number };
  if (typeof parsed.exp !== 'number') throw new Error('id token: no exp claim');
  return parsed.exp;
}

export function makeMetadataIdToken({
  audience,
  fetch: doFetch = globalThis.fetch,
  now = Date.now
}: IdTokenOptions): () => Promise<string> {
  let cached: { token: string; expS: number } | undefined;
  let inFlight: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const url = `${METADATA_IDENTITY}?audience=${encodeURIComponent(audience)}&format=full`;
    const res = await doFetch(url, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) throw new Error(`id token: metadata server answered ${res.status}`);
    const token = (await res.text()).trim();
    cached = { token, expS: expiryOf(token) };
    return token;
  };

  return async () => {
    if (cached && now() / 1000 < cached.expS - REFRESH_MARGIN_S) return cached.token;
    // Concurrent first requests share one mint rather than each hitting the metadata server.
    inFlight ??= mint().finally(() => {
      inFlight = undefined;
    });
    return inFlight;
  };
}
