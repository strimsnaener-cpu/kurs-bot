// LLM provider abstraction. OpenAI-compatible Chat Completions over fetch (no SDK needed).
// Any provider exposing the same API (OpenAI, Azure OpenAI, OpenRouter, a local server) works via OPENAI_BASE_URL.
// Adding another provider = another object with the same chat() shape.

export function makeLLM(env = {}, fetchImpl = fetch) {
  if (!env.OPENAI_API_KEY) return null;
  const base = (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = env.OPENAI_MODEL || 'gpt-4o-mini';
  return {
    name: 'openai', model,
    async chat({ messages, tools }) {
      const res = await fetchImpl(`${base}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 600, ...(tools?.length ? { tools } : {}) }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`Ошибка AI-провайдера ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const j = await res.json();
      const m = j.choices?.[0]?.message || {};
      return {
        message: m,
        content: (m.content || '').trim(),
        toolCalls: (m.tool_calls || []).map(t => ({ id: t.id, name: t.function?.name, args: safeJson(t.function?.arguments) })),
        usage: { in: j.usage?.prompt_tokens || 0, out: j.usage?.completion_tokens || 0 },
      };
    },
  };
}

function safeJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
