// Cloudflare Worker entry. Only wiring: the policy is in core.cjs, the model call in anthropic-model.mjs.
// Secret: ANTHROPIC_API_KEY (wrangler secret put). It exists only here, in the Worker's environment.
import Anthropic from '@anthropic-ai/sdk';
import core from './core.cjs';
import { makeCallModel, DEFAULT_MODEL } from './anthropic-model.mjs';
import { kvStore } from './kv-store.mjs';

export default {
  async fetch(request, env) {
    const deps = { store: kvStore(env.S1_KV) };
    if (env.ANTHROPIC_API_KEY) {
      // no retries: the page gives up after 3 seconds and falls back to the glossary
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0 });
      deps.callModel = makeCallModel(client, env.S1_MODEL || DEFAULT_MODEL);
    }
    return core.handle(request, env, deps);
  },
};
