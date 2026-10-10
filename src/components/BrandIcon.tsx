import { useId } from 'react'

/** The VietNote app icon (Relay): a white tile with three folded planes in a pink-to-magenta gradient. */
export function BrandIcon({ size }: { size: number }) {
  // Gradient ids must be unique: several icons can be on one page.
  const id = useId().replace(/:/g, '')
  const gradient = (name: string, from: string, to: string) =>
    <linearGradient id={`${id}-${name}`} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor={from}/><stop offset="1" stopColor={to}/></linearGradient>
  return <svg viewBox="0 0 512 512" width={size} height={size} aria-hidden="true">
    <defs>{gradient('left', '#EF3184', '#EF46DB')}{gradient('fold', '#F07799', '#F283D4')}{gradient('right', '#CC2630', '#DF3CD6')}</defs>
    <rect width="512" height="512" rx="96" fill="#FFFFFF"/>
    <g transform="translate(10 66) scale(1.1)">
      <path fill={`url(#${id}-left)`} d="M80 80 168 32V280L80 232Z"/>
      <path fill={`url(#${id}-fold)`} d="M168 168 280 104 368 152 280 216 168 280Z"/>
      <path fill={`url(#${id}-right)`} d="M280 216 368 152V272L280 320Z"/>
    </g>
  </svg>
}
