import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2'

export const SONIOX_API = 'https://api.soniox.com/v1'
// One reservation covers at most this much streaming; the worker asks for a
// new key when Soniox ends the session at the limit.
export const MAX_GRANT_SECONDS = 1800
export const MIN_GRANT_SECONDS = 60
// Usage logs that still miss a session this long after it must have ended are
// treated as final: the provisional (server clock) charge stands.
const LOG_GRACE_MS = 2 * 60 * 60 * 1000

export function admin(): SupabaseClient {
  return createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  })
}

export function sonioxKey(): string {
  const key = Deno.env.get('SONIOX_API_KEY')
  if (!key) throw new Error('SONIOX_API_KEY secret is not set')
  return key
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Balance plus the unused part of reservations held by open streams, which
// are refunded when they close: what the user can still spend right now.
export async function availableSeconds(db: SupabaseClient, userId: string): Promise<{ balance_seconds: number; email: string } | null> {
  const { data, error } = await db.from('profiles').select('balance_seconds, email').eq('id', userId).single()
  if (error || !data) return null
  const { data: open } = await db.from('soniox_grants').select('reserved_seconds, created_at')
    .eq('user_id', userId).is('released_at', null)
  const now = Date.now()
  const unused = (open ?? []).reduce((sum, grant) => sum + Math.max(0,
    grant.reserved_seconds - Math.ceil((now - new Date(grant.created_at).getTime()) / 1000)), 0)
  return { ...data, balance_seconds: data.balance_seconds + unused }
}

type Grant = { id: string; reserved_seconds: number; provisional_seconds: number | null; created_at: string; released_at: string | null }

async function usageSeconds(since: Date, until: Date): Promise<Map<string, number>> {
  const seconds = new Map<string, number>()
  let cursor: string | null = null
  do {
    const url = new URL(`${SONIOX_API}/usage-logs`)
    url.searchParams.set('start_time', since.toISOString())
    url.searchParams.set('end_time', until.toISOString())
    url.searchParams.set('limit', '1000')
    if (cursor) url.searchParams.set('cursor', cursor)
    const response = await fetch(url, { headers: { Authorization: `Bearer ${sonioxKey()}` } })
    if (!response.ok) throw new Error(`Soniox usage logs HTTP ${response.status}`)
    const page = await response.json() as { usage_logs: { client_reference_id: string; input_audio_duration_ms: number }[]; next_page_cursor?: string | null }
    for (const log of page.usage_logs) {
      if (!log.client_reference_id) continue
      seconds.set(log.client_reference_id, (seconds.get(log.client_reference_id) ?? 0) + log.input_audio_duration_ms / 1000)
    }
    cursor = page.next_page_cursor ?? null
  } while (cursor)
  return seconds
}

// Settle open grants against Soniox usage logs (the source of truth).
export async function reconcileOpenGrants(db: SupabaseClient): Promise<{ reconciled: number; pending: number }> {
  const { data, error } = await db.from('soniox_grants')
    .select('id, reserved_seconds, provisional_seconds, created_at, released_at')
    .is('reconciled_at', null)
    .order('created_at')
    .limit(500)
  if (error) throw error
  const now = Date.now()
  // Only sessions that have certainly ended: released, or past their duration cap.
  const grants = (data as Grant[]).filter(grant => grant.released_at
    || new Date(grant.created_at).getTime() + (grant.reserved_seconds + 120) * 1000 < now)
  if (!grants.length) return { reconciled: 0, pending: 0 }
  const since = new Date(Math.max(new Date(grants[0].created_at).getTime() - 60_000, now - 30 * 86_400_000)) // API window ≤ 31 days
  const usage = await usageSeconds(since, new Date(now + 60_000))
  let reconciled = 0
  for (const grant of grants) {
    const logged = usage.get(grant.id)
    const ended = new Date(grant.created_at).getTime() + grant.reserved_seconds * 1000
    let actual: number | null = null
    if (logged !== undefined) actual = Math.ceil(logged)
    else if (now - ended > LOG_GRACE_MS) actual = grant.provisional_seconds ?? grant.reserved_seconds
    if (actual === null) continue
    const { error: settleError } = await db.rpc('reconcile_soniox_grant', { p_grant: grant.id, p_actual: actual })
    if (settleError) throw settleError
    reconciled++
  }
  return { reconciled, pending: grants.length - reconciled }
}
