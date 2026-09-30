// Issues single-use Soniox temporary keys against the caller's credit.
//   POST {action:"grant", source}      -> {api_key, grant_id, seconds, balance_seconds}
//   POST {action:"release", grant_id}  -> {used_seconds}
//   POST {action:"balance"}            -> {balance_seconds, email}
import { admin, json, MAX_GRANT_SECONDS, MIN_GRANT_SECONDS, SONIOX_API, sonioxKey } from '../_shared/credits.ts'

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
    const { data, error } = await db.from('profiles').select('balance_seconds, email').eq('id', user.id).single()
    if (error) return json({ error: 'profile_missing' }, 404)
    // Streams in progress hold a 30-minute reservation; show only the time they
    // have actually used so the balance counts down minute by minute.
    const { data: open } = await db.from('soniox_grants').select('reserved_seconds, created_at')
      .eq('user_id', user.id).is('released_at', null)
    const now = Date.now()
    const unused = (open ?? []).reduce((sum, grant) => sum + Math.max(0,
      grant.reserved_seconds - Math.ceil((now - new Date(grant.created_at).getTime()) / 1000)), 0)
    return json({ ...data, balance_seconds: data.balance_seconds + unused })
  }

  if (body.action === 'release') {
    if (!body.grant_id) return json({ error: 'grant_id_required' }, 400)
    const { data, error } = await db.rpc('release_soniox_grant', { p_user: user.id, p_grant: body.grant_id })
    if (error) return json({ error: 'release_failed' }, 500)
    return json({ used_seconds: data })
  }

  if (body.action === 'grant') {
    const source = SOURCES.has(body.source ?? '') ? body.source! : 'system'
    const { data, error } = await db.rpc('reserve_soniox_grant', {
      p_user: user.id, p_source: source, p_max: MAX_GRANT_SECONDS, p_min: MIN_GRANT_SECONDS,
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
      return json({ error: 'soniox_unavailable' }, 502)
    }
    const key = await response.json() as { api_key: string }
    return json({ api_key: key.api_key, grant_id: grant.grant_id, seconds: grant.reserved_seconds, balance_seconds: grant.balance_seconds })
  }

  return json({ error: 'unknown_action' }, 400)
})
