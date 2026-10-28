// Server-only: callers never receive the key, raw upstream text, or exception text.
const TARGET = 'https://hackathon.api.qloo.com/search?query=jazz&take=1';
export async function probeQlooKey(secret: string | undefined, requestFetch: typeof fetch = fetch) {
  if (!secret?.trim()) return { status: 503, data: { configured: false, error: 'QLOO_KEY_NOT_CONFIGURED', upstreamRequests: 0 } };
  try {
    const response = await requestFetch(TARGET, {
      method: 'GET', headers: { Accept: 'application/json', 'X-Api-Key': secret.trim() },
      redirect: 'manual', signal: AbortSignal.timeout(20000),
    });
    const upstreamStatus = response.status;
    // Never return an upstream body: providers may reflect request credentials in errors.
    let entityCount: number | null = null;
    let validShape = false;
    if (upstreamStatus === 200) {
      const parsed: unknown = await response.json().catch(() => null);
      if (parsed && typeof parsed === 'object') {
        const obj = parsed as Record<string, unknown>;
        const nested = obj.results && typeof obj.results === 'object' ? obj.results as Record<string,unknown> : null;
        const entities = Array.isArray(obj.results) ? obj.results : Array.isArray(obj.entities) ? obj.entities : nested?.entities;
        if (Array.isArray(entities)) { entityCount = entities.length; validShape = true; }
      }
    } else {
      await response.body?.cancel();
    }
    return { status: 200, data: { configured: true, upstreamStatus, authenticated: upstreamStatus === 200, validShape, entityCount, upstreamRequests: 1, endpoint: '/search', take: 1 } };
  } catch {
    return { status: 502, data: { configured: true, error: 'QLOO_NETWORK_OR_TIMEOUT', upstreamRequests: 1 } };
  }
}
