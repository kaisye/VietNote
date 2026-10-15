/** Playback seconds that should consume Watch Video credit. */
export function billablePlayback(previous: number, current: number, playing: boolean, kind: string | undefined) {
  const elapsed = current - previous
  // Large jumps are seeks, while none/heard videos are billed by their full audio job.
  return playing && kind !== 'none' && kind !== 'heard' && elapsed > 0 && elapsed <= 2.5 ? elapsed : 0
}
