import { CheckCircle2, LoaderCircle, XCircle } from 'lucide-react'
import type { AiProviderHealth } from '../services/desktop'

export type Health = AiProviderHealth & { checking: boolean }

export function ApiHealthIcon({ health }: { health: Health }) {
  if (health.checking) return <LoaderCircle className="api-health-icon checking" size={18} aria-label={health.message}/>
  return health.ready
    ? <CheckCircle2 className="api-health-icon ready" size={18} aria-label={health.message}/>
    : <XCircle className="api-health-icon unavailable" size={18} aria-label={health.message}/>
}
