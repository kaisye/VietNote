import { useLayoutEffect, useRef, useState } from 'react'

// Follows new content while the user is at the bottom; pauses once they scroll up to reread.
// `hold` freezes it while a passage is selected or quoted, so the text stays put.
export function useStickToBottom(deps: unknown[], hold = false) {
  const ref = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [following, setFollowing] = useState(true)
  const scrollToBottom = () => { const el = ref.current; if (el) el.scrollTop = el.scrollHeight }
  const onScroll = () => {
    const el = ref.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    stick.current = atBottom
    setFollowing(atBottom)
  }
  useLayoutEffect(() => { if (stick.current && !hold) scrollToBottom() }, [...deps, hold])
  const resume = () => { stick.current = true; setFollowing(true); ref.current?.scrollTo({ top: ref.current.scrollHeight, behavior: 'smooth' }) }
  return { ref, onScroll, following, resume }
}
