// Counters and cache on a Cloudflare KV namespace.
// KV has no atomic increment, so two requests at the same moment can count as one. The limits are a brake, not a
// meter; the hard ceiling on spending is the spend limit set on the Anthropic workspace.
const MIN_TTL = 60; // KV refuses a shorter expiry

export function kvStore(kv) {
  const ttl = (seconds) => Math.max(MIN_TTL, seconds);
  return {
    async get(key) { return kv.get(key); },
    async put(key, value, seconds) { await kv.put(key, value, { expirationTtl: ttl(seconds) }); },
    async incr(key, seconds) {
      const n = (Number.parseInt(await kv.get(key), 10) || 0) + 1;
      await kv.put(key, String(n), { expirationTtl: ttl(seconds) });
      return n;
    },
  };
}
