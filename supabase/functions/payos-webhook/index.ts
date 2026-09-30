// payOS payment webhook. Authenticated by the payload signature (checksum key),
// not a user JWT. Always answers 2xx for well-signed payloads so payOS stops
// retrying; payOS's own test call on confirm-webhook has no matching order.
import { admin, json } from '../_shared/credits.ts'
import { verifySignature } from '../_shared/payos.ts'

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const body = await request.json().catch(() => null) as { code?: string; data?: Record<string, unknown>; signature?: string } | null
  if (!Deno.env.get('PAYOS_CHECKSUM_KEY')) return json({ error: 'not_configured' }, 503)
  if (!body?.data || typeof body.signature !== 'string' || !await verifySignature(body.data, body.signature)) {
    return json({ error: 'invalid_signature' }, 401)
  }
  const data = body.data as { orderCode?: number; amount?: number; code?: string; reference?: string }
  if (body.code !== '00' || data.code !== '00' || typeof data.orderCode !== 'number') return json({ ok: true })
  const { error } = await admin().rpc('pay_credit_order', {
    p_order: data.orderCode, p_amount: data.amount ?? 0, p_reference: data.reference ?? null,
  })
  if (error && !error.message.includes('unknown_order')) {
    console.error('pay_credit_order', data.orderCode, error.message)
    return json({ error: 'not_credited' }, 500)
  }
  return json({ ok: true })
})
