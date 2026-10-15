import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { PLAYER_URL } from '../services/youtube'

export interface PlayerControl { seek: (time: number) => void; play: () => void; pause: () => void; toggle: () => void; volume: (percent: number) => void }

/** Why the player could not play, by YouTube's error code. */
export const playerError = (code: number) =>
  code === 100 ? 'Không tìm thấy video: có thể đã bị xoá hoặc để riêng tư.'
  : code === 101 || code === 150 ? 'Chủ video không cho phát ở ngoài YouTube. Hãy mở video trong trình duyệt rồi dùng Phiên dịch.'
  : code === 153 ? 'YouTube chưa cho phát video trong app. Hãy thử lại sau ít phút.'
  : 'Trình phát gặp lỗi khi mở video này.'

/** YouTube's own player, framed from VietNote's player page, reporting where it is several times a second. */
export function YouTubePlayer({ videoId, start, onTime, onError, onReady, control }: { videoId: string; start: number; onTime: (time: number, playing: boolean) => void; onError: (code: number) => void; onReady: () => void; control: Ref<PlayerControl> }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const handlers = useRef({ onTime, onError, onReady })
  handlers.current = { onTime, onError, onReady }
  // Only the first start counts: later seeks go through `control`, not a reload.
  const src = useRef(`${PLAYER_URL}?v=${videoId}&t=${Math.floor(start)}`)
  if (!src.current.includes(`v=${videoId}`)) src.current = `${PLAYER_URL}?v=${videoId}&t=${Math.floor(start)}`

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data?.vietnotePlayer) return
      const { type, time, playing, code } = event.data
      if (type === 'time' && Number.isFinite(time)) handlers.current.onTime(time, Boolean(playing))
      else if (type === 'error') handlers.current.onError(Number(code))
      else if (type === 'ready') handlers.current.onReady()
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [])

  const send = (message: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(message, '*')
  useImperativeHandle(control, () => ({ seek: time => send({ command: 'seek', time }), play: () => send({ command: 'play' }), pause: () => send({ command: 'pause' }), toggle: () => send({ command: 'toggle' }), volume: percent => send({ command: 'volume', value: percent }) }), [])

  return <iframe ref={frame} className="watch-frame" src={src.current} title="Trình phát video" allow="autoplay; encrypted-media; picture-in-picture" referrerPolicy="strict-origin-when-cross-origin"/>
}
