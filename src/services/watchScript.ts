import { LEAD, lineAt, type WatchLine } from './youtube'

const key = (at: number) => at.toFixed(2)

/** Keep only lines the viewer reached; a seek does not reveal the skipped interval. */
export function collectWatched(previous: WatchLine[], lines: WatchLine[], before: number, time: number): WatchLine[] {
  const latest = new Map(lines.map(line => [key(line.start), line]))
  const seen = new Map(previous.map(line => [key(line.start), latest.get(key(line.start)) ?? line]))
  if (before >= 0 && time >= before && time - before <= 2) {
    for (const line of lines) if (line.start > before + LEAD && line.start <= time + LEAD) seen.set(key(line.start), line)
  }
  const current = lineAt(lines, time)
  if (current >= 0) seen.set(key(lines[current].start), lines[current])
  const next = [...seen.values()].sort((a, b) => a.start - b.start)
  return next.length === previous.length && next.every((line, index) => line === previous[index]) ? previous : next
}
