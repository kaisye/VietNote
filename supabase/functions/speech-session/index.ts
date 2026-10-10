// Issues single-use Soniox temporary keys against the caller's credit.
//   POST {action:"grant", source}      -> {api_key, grant_id, seconds, balance_seconds}
//   POST {action:"release", grant_id}  -> {used_seconds}
//   POST {action:"balance"}            -> {balance_seconds, email}
import { admin, availableSeconds, json, MAX_GRANT_SECONDS, MIN_GRANT_SECONDS, SONIOX_API, sonioxKey } from '../_shared/credits.ts'

const SOURCES = new Set(['system', 'microphone'])

Deno.serve(async request => {
  if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405)
  const db = admin()
  const token = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? ''
  const { data: auth, error: authError } = await db.auth.getUser(token)
  if (authError || !auth.user) return json({ error: 'unauthorized' }, 401)
  const user = auth.user
  const body = await request.json().catch(() => ({})) as { action?: string; source?: string; grant_id?: string }

  if (body.action === 'balance') {
    // Streams in progress hold a reservation; show only the time they have
    // actually used so the balance counts down minute by minute.
    const available = await availableSeconds(db, user.id)
    return available ? json(available) : json({ error: 'profile_missing' }, 404)
  }

  if (body.action === 'release') {
    if (!body.grant_id) return json({ error: 'grant_id_required' }, 400)
    const { data, error } = await db.rpc('release_soniox_grant', { p_user: user.id, p_grant: body.grant_id })
    if (error) return json({ error: 'release_failed' }, 500)
    return json({ used_seconds: data })
  }

  if (body.action === 'grant') {
    const source = SOURCES.has(body.source ?? '') ? body.source! : 'system'
    // Reserve at most half of what is left, so the other source (system audio
    // and microphone stream at once) can still get a key from the rest.
    const { data: profile } = await db.from('profiles').select('balance_seconds').eq('id', user.id).single()
    const half = Math.floor((profile?.balance_seconds ?? 0) / 2)
    const { data, error } = await db.rpc('reserve_soniox_grant', {
      p_user: user.id, p_source: source, p_max: Math.max(MIN_GRANT_SECONDS, Math.min(MAX_GRANT_SECONDS, half)), p_min: MIN_GRANT_SECONDS,
    })
    if (error) {
      if (error.message.includes('insufficient_credit')) return json({ error: 'insufficient_credit' }, 402)
      return json({ error: 'reserve_failed' }, 500)
    }
    const grant = (data as { grant_id: string; reserved_seconds: number; balance_seconds: number }[])[0]
    const response = await fetch(`${SONIOX_API}/auth/temporary-api-key`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sonioxKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usage_type: 'transcribe_websocket',
        expires_in_seconds: 60,
        single_use: true,
        max_session_duration_seconds: grant.reserved_seconds,
        client_reference_id: grant.grant_id,
      }),
    })
    if (!response.ok) {
      await db.rpc('cancel_soniox_grant', { p_grant: grant.grant_id })
      return json({ error: 'speech_unavailable' }, 502)
    }
    const key = await response.json() as { api_key: string }
    return json({ api_key: key.api_key, grant_id: grant.grant_id, seconds: grant.reserved_seconds, balance_seconds: grant.balance_seconds })
  }

  return json({ error: 'unknown_action' }, 400)
})
