import { Loader2, Volume2, VolumeX } from 'lucide-react'
import { HoverMenu } from './HoverMenu'
import { voiceOptions, type SpeechVoice } from '../hooks/useSpeech'
import type { IslandState } from '../services/island'

/** Read-aloud button: a click turns it on or off, hovering picks the voice. */
export function SpeechMenu({ speech, name = 'speech', open, onOpen, below, size, onToggle, onVoice }: {
  speech: NonNullable<IslandState['speech']>; name?: string; open: boolean; onOpen: (open: boolean) => void; below?: boolean; size: number
  onToggle: (enabled: boolean) => void; onVoice: (voice: SpeechVoice) => void
}) {
  const icon = speech.loading ? <Loader2 size={size} className="speech-loading"/> : speech.enabled ? <Volume2 size={size}/> : <VolumeX size={size}/>
  return <HoverMenu name={name} open={open} onOpen={onOpen} below={below} value={speech.enabled ? speech.voice : null} options={voiceOptions}
    on={speech.enabled} icon={icon} onChange={onVoice} onClick={() => onToggle(!speech.enabled)}
    title={speech.loading ? 'Đang tải giọng đọc…' : speech.enabled ? 'Tắt đọc bản dịch' : 'Đọc bản dịch tiếng Việt'}/>
}
