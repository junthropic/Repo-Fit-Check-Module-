// The one call to the model. The client is passed in, so a test can hand over a fake and look at the request.
import core from './core.cjs';

export const DEFAULT_MODEL = 'claude-haiku-5-5';

export function makeCallModel(client, model) {
  return async function callModel({ question, signal }) {
    // No temperature and no thinking setting: the current models reject non-default sampling parameters, so the
    // repeatability of a sentence comes from the cache (core.cjs), not from the model.
    const response = await client.messages.create({
      model: model || DEFAULT_MODEL,
      max_tokens: 400,
      system: core.SYSTEM_PROMPT,
      messages: [{ role: 'user', content: core.wrapQuestion(question) }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: core.OUTPUT_SCHEMA } },
    }, { signal });
    if (response.stop_reason !== 'end_turn') throw new Error('model stopped: ' + response.stop_reason);
    const block = response.content.find((b) => b.type === 'text');
    if (!block) throw new Error('no text in the answer');
    return JSON.parse(block.text);
  };
}
