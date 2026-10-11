import { useEffect, useState } from 'react'
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react'
import { dayKey } from '../services/notes'

const WEEKDAYS = ['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN']
const OPEN_KEY = 'notesCalendarOpen'

/**
 * A month of days; a day with notes has a dot, darker with more notes. Choosing a day shows only
 * its notes, choosing it again shows all of them.
 */
export function NoteCalendar({ counts, selected, onSelect }: { counts: Map<string, number>; selected: string | null; onSelect: (day: string | null) => void }) {
  const [open, setOpen] = useState(() => { try { return localStorage.getItem(OPEN_KEY) !== '0' } catch { return true } })
  const [month, setMonth] = useState(() => { const today = new Date(); return new Date(today.getFullYear(), today.getMonth(), 1) })
  useEffect(() => { try { localStorage.setItem(OPEN_KEY, open ? '1' : '0') } catch { /* private window */ } }, [open])
  // A day chosen elsewhere (or cleared) brings its month into view.
  useEffect(() => { if (selected) { const [year, monthIndex] = selected.split('-').map(Number); setMonth(new Date(year, monthIndex - 1, 1)) } }, [selected])

  const today = dayKey(new Date())
  const lead = (month.getDay() + 6) % 7
  const length = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length }, (_, index) => dayKey(new Date(month.getFullYear(), month.getMonth(), index + 1)))]
  const shift = (by: number) => setMonth(new Date(month.getFullYear(), month.getMonth() + by, 1))
  const inMonth = cells.reduce((sum, day) => sum + (day ? counts.get(day) ?? 0 : 0), 0)
  const title = `Tháng ${month.getMonth() + 1}, ${month.getFullYear()}`

  return <div className={`note-calendar ${open ? 'open' : ''}`}>
    <div className="note-calendar-bar">
      <button className="note-calendar-toggle" aria-expanded={open} title={`${inMonth} ghi chú trong tháng · ${open ? 'Thu gọn lịch' : 'Mở lịch'}`} onClick={() => setOpen(!open)}><CalendarDays size={15}/><span>{title}</span><ChevronDown size={14} className="chevron"/></button>
      {open && <><button aria-label="Tháng trước" onClick={() => shift(-1)}><ChevronLeft size={15}/></button><button aria-label="Tháng sau" onClick={() => shift(1)}><ChevronRight size={15}/></button></>}
    </div>
    {open && <div className="note-calendar-grid" role="grid" aria-label={title}>
      {WEEKDAYS.map(day => <span key={day} className="weekday">{day}</span>)}
      {cells.map((day, index) => {
        if (!day) return <span key={`blank-${index}`}/>
        const count = counts.get(day) ?? 0
        const level = count >= 4 ? 3 : count >= 2 ? 2 : count ? 1 : 0
        return <button key={day} className={`level-${level} ${day === today ? 'today' : ''} ${day === selected ? 'selected' : ''}`} disabled={!count} title={count ? `${count} ghi chú` : undefined} onClick={() => onSelect(day === selected ? null : day)}>{Number(day.slice(8))}{count > 0 && <i/>}</button>
      })}
    </div>}
  </div>
}
