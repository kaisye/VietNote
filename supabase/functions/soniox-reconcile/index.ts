// Scheduled job: settle finished Soniox grants against Soniox usage logs.
// Called by pg_cron with the CRON_SECRET header; never by the app.
import { admin, json, reconcileOpenGrants } from '../_shared/credits.ts'

Deno.serve(async request => {
  const secret = Deno.env.get('CRON_SECRET')
  if (!secret || request.headers.get('x-cron-secret') !== secret) return json({ error: 'unauthorized' }, 401)
  try {
    return json(await reconcileOpenGrants(admin()))
  } catch (error) {
    return json({ error: String(error) }, 500)
  }
})
