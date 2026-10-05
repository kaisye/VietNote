// LLM proxy for summaries, paragraph translation and meeting titles.
//   POST {system, user, max_tokens, json} -> {content, finish_reason}
// The model and the OpenRouter key stay on the server; callers must be signed
// in with a positive balance and are rate limited per minute.
import { admin, availableSeconds, json } from '../_shared/credits.ts'
import { relayAiStream } from '../_shared/ai-stream.ts'

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions'
const MAX_OUTPUT_TOKENS = 2000
const MAX_INPUT_CHARS = 200_000
const REQUESTS_PER_MINUTE = 30

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const db = admin()
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const { data: auth, error: authError } = await db.auth.getUser(token)
  if (authError || !auth.user) return json({ error: 'unauthorized' }, 401)
  const userId = auth.user.id

  const body = await request.json().catch(() => ({})) as { system?: unknown; user?: unknown; max_tokens?: unknown; json?: unknown; stream?: unknown }
  if (typeof body.system !== 'string' || typeof body.user !== 'string' || !body.user.trim()) return json({ error: 'invalid_request' }, 400)
  if (body.system.length + body.user.length > MAX_INPUT_CHARS) return json({ error: 'input_too_long' }, 413)
  const maxTokens = Math.min(MAX_OUTPUT_TOKENS, Math.max(1, Math.floor(Number(body.max_tokens) || 500)))

  // Open streams hold up to 30 minutes each; that reserved time still counts.
  const available = await availableSeconds(db, userId)
  if (!available || available.balance_seconds <= 0) return json({ error: 'insufficient_credit' }, 402)
  const since = new Date(Date.now() - 60_000).toISOString()
  const { count } = await db.from('ai_usage').select('id', { count: 'exact', head: true }).eq('user_id', userId).gte('created_at', since)
  if ((count ?? 0) >= REQUESTS_PER_MINUTE) return json({ error: 'rate_limited' }, 429)

  const model = Deno.env.get('OPENROUTER_MODEL') || 'qwen/qwen3.7-flash'
  const key = Deno.env.get('OPENROUTER_API_KEY')
  if (!key) return json({ error: 'not_configured' }, 503)
  // Qwen Flash thinks by default and bills it as output; these tasks don't need it.
  const payload: Record<string, unknown> = {
    model,
    messages: [{ role: 'system', content: body.system }, { role: 'user', content: body.user }],
    max_tokens: maxTokens,
    reasoning: { effort: 'none' },
  }
  // Without include_usage the final chunk may omit token counts and cost.
  if (body.stream === true) { payload.stream = true; payload.stream_options = { include_usage: true } }
  if (body.json === true) payload.response_format = { type: 'json_object' }
  // One retry covers the provider's brief 429/5xx blips.
  let response: Response | undefined
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise(resolve => setTimeout(resolve, 1500))
    response = await fetch(OPENROUTER_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'VietNote' },
      body: JSON.stringify(payload),
    }).catch(() => undefined)
    if (response && response.status !== 429 && response.status < 500) break
  }
  if (!response?.ok) {
    console.error('openrouter', response?.status, await response?.text().catch(() => ''))
    return json({ error: 'upstream_unavailable' }, 502)
  }
  if (body.stream === true) {
    if (!response.body) return json({ error: 'upstream_unavailable' }, 502)
    // Count the request before streaming, then fill in the final provider usage.
    const { data: row } = await db.from('ai_usage').insert({
      user_id: userId, model, prompt_tokens: 0, completion_tokens: 0, cost_usd: null,
    }).select('id').single()
    const stream = relayAiStream(response.body, async usage => {
      const values = {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        cost_usd: usage.cost ?? null,
      }
      if (row) await db.from('ai_usage').update(values).eq('id', row.id)
      else await db.from('ai_usage').insert({ user_id: userId, model, ...values })
    })
    return new Response(stream, { headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no',
    } })
  }
  const data = await response.json() as {
    choices?: { message?: { content?: string }; finish_reason?: string }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  }
  await db.from('ai_usage').insert({
    user_id: userId, model,
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
    cost_usd: data.usage?.cost ?? null,
  })
  const choice = data.choices?.[0]
  return json({ content: choice?.message?.content ?? '', finish_reason: choice?.finish_reason ?? null })
})
