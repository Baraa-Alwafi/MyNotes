import { useEffect, useMemo, useState } from 'react'

type View = 'today' | 'upcoming' | 'all' | 'calendar' | 'notes'
type Task = {
  id: string
  title: string
  due: string
  category: string
  priority: 'High' | 'Medium' | 'Low'
  done: boolean
}
type Note = {
  id: string
  title: string
  content: string
  color: string
  updatedAt: string
}
type Recurrence = {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  byDay: number[]
  count: number | null
  until: string | null
}
type CalendarEvent = {
  id: string
  uid: string
  sourceName?: string
  title: string
  description: string
  startDate: string
  startTime: string | null
  allDay: boolean
  recurrence: Recurrence | null
}

const taskStorageKey = 'daymark.tasks'
const noteStorageKey = 'daymark.notes'
const calendarStorageKey = 'daymark.calendar'
const calendarUrlStorageKey = 'daymark.calendar-url'
const colors = ['#efd395', '#a4a4a4', '#777674', '#4b4a48', '#262625', '#131313']
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const weekdayCodes: Record<string, number> = {
  SU: 0,
  MO: 1,
  TU: 2,
  WE: 3,
  TH: 4,
  FR: 5,
  SA: 6
}

function dateKey(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function addDays(date: Date, count: number): Date {
  const result = new Date(date)
  result.setDate(result.getDate() + count)
  return result
}

function dateDifference(start: string, end: string): number {
  const [startYear, startMonth, startDay] = start.split('-').map(Number)
  const [endYear, endMonth, endDay] = end.split('-').map(Number)
  return (
    (Date.UTC(endYear, endMonth - 1, endDay) - Date.UTC(startYear, startMonth - 1, startDay)) /
    86400000
  )
}

function parseCalendarDate(
  value: string
): { date: string; time: string | null; allDay: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value)
  if (!match) return null
  const [, year, month, day, hour, minute, second, utc] = match
  const allDay = !hour
  const date = allDay
    ? `${year}-${month}-${day}`
    : utc
      ? dateKey(
          new Date(
            Date.UTC(
              Number(year),
              Number(month) - 1,
              Number(day),
              Number(hour),
              Number(minute),
              Number(second ?? 0)
            )
          )
        )
      : `${year}-${month}-${day}`
  const time = allDay
    ? null
    : utc
      ? (() => {
          const parsed = new Date(
            Date.UTC(
              Number(year),
              Number(month) - 1,
              Number(day),
              Number(hour),
              Number(minute),
              Number(second ?? 0)
            )
          )
          return `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}`
        })()
      : `${hour}:${minute}`
  return { date, time, allDay }
}

function parseRecurrence(value: string): Recurrence | null {
  const parts = Object.fromEntries(
    value.split(';').map((part) => {
      const separator = part.indexOf('=')
      return [part.slice(0, separator).toUpperCase(), part.slice(separator + 1)]
    })
  )
  const frequency = parts.FREQ
  if (!['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(frequency)) return null
  const byDay = (parts.BYDAY ?? '')
    .split(',')
    .map((day) => weekdayCodes[day.slice(-2).toUpperCase()])
    .filter((day): day is number => day !== undefined)
  const until = parts.UNTIL ? (parseCalendarDate(parts.UNTIL)?.date ?? null) : null
  return {
    frequency: frequency as Recurrence['frequency'],
    interval: Math.max(1, Number.parseInt(parts.INTERVAL ?? '1', 10) || 1),
    byDay,
    count: parts.COUNT ? Number.parseInt(parts.COUNT, 10) || null : null,
    until
  }
}

function decodeIcsText(value: string): string {
  return value
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

function parseIcs(content: string): CalendarEvent[] {
  const lines = content
    .replace(/\r\n[ \t]/g, '')
    .replace(/\n[ \t]/g, '')
    .split(/\r?\n/)
  const events: CalendarEvent[] = []
  let properties: Record<string, string> | null = null

  for (const line of lines) {
    if (line.toUpperCase() === 'BEGIN:VEVENT') {
      properties = {}
      continue
    }
    if (line.toUpperCase() === 'END:VEVENT') {
      if (!properties) continue
      const start = parseCalendarDate(properties.DTSTART ?? '')
      if (!start || properties.STATUS?.toUpperCase() === 'CANCELLED') {
        properties = null
        continue
      }
      const recurrence = properties.RRULE ? parseRecurrence(properties.RRULE) : null
      const uid = properties.UID || `${start.date}-${properties.SUMMARY ?? 'event'}`
      events.push({
        id: uid,
        uid,
        title: decodeIcsText(properties.SUMMARY || 'Untitled event'),
        description: decodeIcsText(properties.DESCRIPTION ?? ''),
        startDate: start.date,
        startTime: start.time,
        allDay: start.allDay,
        recurrence
      })
      properties = null
      continue
    }
    if (!properties) continue
    const separator = line.indexOf(':')
    if (separator < 0) continue
    const propertyName = line.slice(0, separator).split(';')[0].toUpperCase()
    if (['UID', 'SUMMARY', 'DESCRIPTION', 'DTSTART', 'STATUS', 'RRULE'].includes(propertyName)) {
      properties[propertyName] = line.slice(separator + 1)
    }
  }

  return events
}

function recurrenceIndex(event: CalendarEvent, targetDate: string): number | null {
  const recurrence = event.recurrence
  const daysSinceStart = dateDifference(event.startDate, targetDate)
  if (!recurrence || daysSinceStart < 0 || (recurrence.until && targetDate > recurrence.until)) {
    return null
  }

  let index: number | null = null
  if (recurrence.frequency === 'DAILY') {
    if (daysSinceStart % recurrence.interval === 0) {
      index = daysSinceStart / recurrence.interval
    }
  } else if (recurrence.frequency === 'MONTHLY' || recurrence.frequency === 'YEARLY') {
    const [startYear, startMonth, startDay] = event.startDate.split('-').map(Number)
    const [targetYear, targetMonth, targetDay] = targetDate.split('-').map(Number)
    const interval =
      recurrence.frequency === 'MONTHLY'
        ? (targetYear - startYear) * 12 + targetMonth - startMonth
        : targetYear - startYear
    const samePeriod = recurrence.frequency === 'MONTHLY' || targetMonth === startMonth
    if (
      samePeriod &&
      targetDay === startDay &&
      interval >= 0 &&
      interval % recurrence.interval === 0
    ) {
      index = interval / recurrence.interval
    }
  } else {
    const startWeekday = new Date(`${event.startDate}T12:00:00`).getDay()
    const weekdays = recurrence.byDay.length ? recurrence.byDay : [startWeekday]
    let occurrence = 0
    for (let offset = 0; offset <= daysSinceStart; offset += 1) {
      const day = dateKey(addDays(new Date(`${event.startDate}T12:00:00`), offset))
      const weekIndex = Math.floor((offset + ((startWeekday + 6) % 7)) / 7)
      const weekday = new Date(`${day}T12:00:00`).getDay()
      if (weekIndex % recurrence.interval === 0 && weekdays.includes(weekday)) {
        if (offset === daysSinceStart) index = occurrence
        occurrence += 1
      }
    }
  }

  return index !== null && (recurrence.count === null || index < recurrence.count) ? index : null
}

function isEventOnDate(event: CalendarEvent, date: string): boolean {
  if (!event.recurrence) return event.startDate === date
  return recurrenceIndex(event, date) !== null
}

function readStorage<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key)
    return stored ? (JSON.parse(stored) as T) : fallback
  } catch (error) {
    console.error(`Unable to read ${key} from local storage`, error)
    return fallback
  }
}

function readCalendarUrl(): string {
  try {
    return localStorage.getItem(calendarUrlStorageKey) ?? ''
  } catch (error) {
    console.error(`Unable to read ${calendarUrlStorageKey} from local storage`, error)
    return ''
  }
}

function fetchCalendarFeed(url: string): Promise<string> {
  if (typeof window.api?.fetchCalendar !== 'function') {
    throw new Error('Calendar links sync in the MyNotes desktop app, not in the browser preview.')
  }
  return window.api.fetchCalendar(url)
}

function Icon({
  name,
  size = 18
}: {
  name:
    | 'today'
    | 'upcoming'
    | 'all'
    | 'calendar'
    | 'notes'
    | 'search'
    | 'plus'
    | 'check'
    | 'trash'
    | 'back'
    | 'spark'
  size?: number
}): React.JSX.Element {
  const paths: Record<typeof name, React.ReactNode> = {
    today: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
        <path d="m9 15 2 2 4-4" />
      </>
    ),
    upcoming: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    all: (
      <>
        <path d="M9 6h11M9 12h11M9 18h11" />
        <path d="M4 6h.01M4 12h.01M4 18h.01" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="2" />
        <path d="M16 3v4M8 3v4M3 10h18" />
        <path d="M8 14h2M14 14h2M8 18h2" />
      </>
    ),
    notes: (
      <>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
        <path d="M14 2v6h6M8 13h8M8 17h6" />
      </>
    ),
    search: (
      <>
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-4-4" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    check: <path d="m5 12 4 4L19 6" />,
    trash: (
      <>
        <path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6" />
        <path d="M10 11v5m4-5v5" />
      </>
    ),
    back: <path d="m15 18-6-6 6-6" />,
    spark: (
      <>
        <path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-1.9-5.8L4 11l6.1-2.2L12 3Z" />
        <path d="m19 14 1 2.5 2.5 1-2.5 1L19 21l-1-2.5-2.5-1 2.5-1 1-2.5Z" />
      </>
    )
  }

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  )
}

function App(): React.JSX.Element {
  const today = dateKey(new Date())
  const tomorrow = dateKey(addDays(new Date(`${today}T12:00:00`), 1))
  const [view, setView] = useState<View>('today')
  const [tasks, setTasks] = useState<Task[]>(() =>
    readStorage(taskStorageKey, [
      {
        id: 'welcome-1',
        title: 'Plan the week ahead',
        due: today,
        category: 'Personal',
        priority: 'Medium',
        done: false
      },
      {
        id: 'welcome-2',
        title: 'Review project notes',
        due: today,
        category: 'Work',
        priority: 'High',
        done: false
      },
      {
        id: 'welcome-3',
        title: 'Take a proper lunch break',
        due: today,
        category: 'Wellbeing',
        priority: 'Low',
        done: true
      },
      {
        id: 'welcome-4',
        title: 'Send the design follow-up',
        due: dateKey(addDays(new Date(), 1)),
        category: 'Work',
        priority: 'Medium',
        done: false
      }
    ])
  )
  const [notes, setNotes] = useState<Note[]>(() =>
    readStorage(noteStorageKey, [
      {
        id: 'welcome-note',
        title: 'A little space to think',
        content:
          'Keep the important things close, and give yourself room to focus on what matters today.\n\nUse notes to capture ideas, meeting takeaways, or anything you want to remember.',
        color: colors[0],
        updatedAt: new Date().toISOString()
      },
      {
        id: 'welcome-ideas',
        title: 'Ideas to explore',
        content: 'A small collection of things worth coming back to.',
        color: colors[1],
        updatedAt: new Date(Date.now() - 86400000).toISOString()
      }
    ])
  )
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>(() =>
    readStorage(calendarStorageKey, [])
  )
  const [calendarUrl, setCalendarUrl] = useState(readCalendarUrl)
  const [calendarUrlInput, setCalendarUrlInput] = useState(readCalendarUrl)
  const [calendarRefresh, setCalendarRefresh] = useState(0)
  const [query, setQuery] = useState('')
  const [addingTask, setAddingTask] = useState(false)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [newTaskDue, setNewTaskDue] = useState(today)
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null)
  const [selectedDate, setSelectedDate] = useState(today)
  const [calendarMonth, setCalendarMonth] = useState(
    () => new Date(`${today.slice(0, 7)}-01T12:00:00`)
  )
  const [calendarFeedback, setCalendarFeedback] = useState('')

  useEffect(() => {
    try {
      localStorage.setItem(taskStorageKey, JSON.stringify(tasks))
    } catch (error) {
      console.error('Unable to save tasks to local storage', error)
    }
  }, [tasks])

  useEffect(() => {
    try {
      localStorage.setItem(noteStorageKey, JSON.stringify(notes))
    } catch (error) {
      console.error('Unable to save notes to local storage', error)
    }
  }, [notes])

  useEffect(() => {
    try {
      localStorage.setItem(calendarStorageKey, JSON.stringify(calendarEvents))
    } catch (error) {
      console.error('Unable to save calendar events to local storage', error)
    }
  }, [calendarEvents])

  useEffect(() => {
    if (!calendarUrl) return
    let cancelled = false

    async function refreshSavedCalendar(): Promise<void> {
      try {
        const content = await fetchCalendarFeed(calendarUrl)
        const imported = parseIcs(content)
        if (imported.length === 0) {
          throw new Error('The saved calendar link returned no usable events.')
        }
        if (cancelled) return

        const sourceEvents = imported.map((item) => ({
          ...item,
          id: `${calendarUrl}:${item.uid}`,
          sourceName: calendarUrl
        }))
        setCalendarEvents((current) => [
          ...current.filter((item) => item.sourceName !== calendarUrl),
          ...sourceEvents
        ])
        setCalendarFeedback(
          `Synced ${imported.length} event${imported.length === 1 ? '' : 's'} from your calendar link.`
        )
      } catch (error) {
        console.error('Unable to sync the saved calendar link', error)
        if (!cancelled) {
          setCalendarFeedback(
            error instanceof Error ? error.message : 'Could not sync your calendar link.'
          )
        }
      }
    }

    void refreshSavedCalendar()
    return () => {
      cancelled = true
    }
  }, [calendarRefresh, calendarUrl])

  const completedCount = tasks.filter((task) => task.done).length
  const openCount = tasks.filter((task) => !task.done).length
  const visibleTasks = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return tasks
      .filter((task) => {
        if (view === 'today' && task.due > today) return false
        if (view === 'upcoming' && task.due <= today) return false
        if (!normalizedQuery) return true
        return `${task.title} ${task.category}`.toLowerCase().includes(normalizedQuery)
      })
      .sort((a, b) => Number(a.done) - Number(b.done) || a.due.localeCompare(b.due))
  }, [query, tasks, today, view])

  const normalizedNoteQuery = query.trim().toLowerCase()
  const visibleNotes = notes.filter((note) =>
    `${note.title} ${note.content}`.toLowerCase().includes(normalizedNoteQuery)
  )
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null
  const calendarDays = useMemo(() => {
    const firstOfMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1, 12)
    const firstVisibleDay = addDays(firstOfMonth, -firstOfMonth.getDay())
    return Array.from({ length: 42 }, (_, index) => {
      const date = addDays(firstVisibleDay, index)
      const key = dateKey(date)
      return {
        date,
        key,
        isCurrentMonth: date.getMonth() === calendarMonth.getMonth(),
        events: calendarEvents.filter((item) => isEventOnDate(item, key)),
        tasks: tasks.filter((task) => task.due === key),
        notes: notes.filter((note) => dateKey(new Date(note.updatedAt)) === key)
      }
    })
  }, [calendarEvents, calendarMonth, notes, tasks])
  const selectedDay = calendarDays.find((day) => day.key === selectedDate)
  const selectedDayItems = selectedDay ?? { events: [], tasks: [], notes: [] }
  const calendarMonthLabel = new Intl.DateTimeFormat('en', {
    month: 'long',
    year: 'numeric'
  }).format(calendarMonth)
  const selectedDateLabel = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date(`${selectedDate}T12:00:00`))
  const title =
    view === 'today'
      ? 'Today'
      : view === 'upcoming'
        ? 'Upcoming'
        : view === 'all'
          ? 'All tasks'
          : view === 'calendar'
            ? 'Calendar'
            : 'Your notes'
  const dateLabel = new Intl.DateTimeFormat('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric'
  }).format(new Date())

  function addTask(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const title = newTaskTitle.trim()
    if (!title) return
    setTasks((current) => [
      {
        id: crypto.randomUUID(),
        title,
        due: newTaskDue,
        category: 'Personal',
        priority: 'Medium',
        done: false
      },
      ...current
    ])
    setNewTaskTitle('')
    setAddingTask(false)
  }

  function syncCalendarLink(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    const link = calendarUrlInput.trim()
    if (!link) {
      setCalendarFeedback('Paste your UQU calendar link to sync it.')
      return
    }

    try {
      if (typeof window.api?.fetchCalendar !== 'function') {
        throw new Error(
          'Calendar links sync in the MyNotes desktop app, not in the browser preview.'
        )
      }
      localStorage.setItem(calendarUrlStorageKey, link)
      setCalendarUrlInput(link)
      setCalendarUrl(link)
      setCalendarRefresh((current) => current + 1)
      setCalendarFeedback('Syncing your calendar…')
    } catch (error) {
      console.error('Unable to save the calendar link', error)
      setCalendarFeedback(
        error instanceof Error ? error.message : 'Could not save your calendar link on this device.'
      )
    }
  }

  async function importCalendarFile(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const input = event.currentTarget
    const file = input.files?.[0]
    if (!file) return

    try {
      if (!file.name.toLowerCase().endsWith('.ics')) {
        throw new Error('Choose an .ics calendar file.')
      }

      const imported = parseIcs(await file.text())
      if (imported.length === 0) {
        throw new Error('This file contains no usable calendar events.')
      }

      const sourceName = `file:${file.name}`
      const sourceEvents = imported.map((item) => ({
        ...item,
        id: `${sourceName}:${item.uid}`,
        sourceName
      }))
      setCalendarEvents((current) => [
        ...current.filter((item) => item.sourceName !== sourceName),
        ...sourceEvents
      ])
      setCalendarFeedback(
        `Imported ${imported.length} event${imported.length === 1 ? '' : 's'} from ${file.name}.`
      )
    } catch (error) {
      console.error('Unable to import calendar file', error)
      setCalendarFeedback(
        error instanceof Error ? error.message : 'Could not import this calendar file.'
      )
    } finally {
      input.value = ''
    }
  }

  function moveCalendarMonth(amount: number): void {
    const nextMonth = new Date(
      calendarMonth.getFullYear(),
      calendarMonth.getMonth() + amount,
      1,
      12
    )
    setCalendarMonth(nextMonth)
    setSelectedDate(dateKey(nextMonth))
    setAddingTask(false)
  }

  function selectCalendarDate(key: string): void {
    setSelectedDate(key)
    setCalendarMonth(new Date(`${key.slice(0, 7)}-01T12:00:00`))
  }

  function createNote(): void {
    const note: Note = {
      id: crypto.randomUUID(),
      title: 'Untitled note',
      content: '',
      color: colors[notes.length % colors.length],
      updatedAt: new Date().toISOString()
    }
    setNotes((current) => [note, ...current])
    setSelectedNoteId(note.id)
  }

  function updateNote(field: 'title' | 'content', value: string): void {
    if (!selectedNote) return
    setNotes((current) =>
      current.map((note) =>
        note.id === selectedNote.id
          ? { ...note, [field]: value, updatedAt: new Date().toISOString() }
          : note
      )
    )
  }

  const navItems: {
    id: View
    label: string
    icon: 'today' | 'upcoming' | 'all' | 'calendar' | 'notes'
    count?: number
  }[] = [
    { id: 'today', label: 'Today', icon: 'today' },
    { id: 'upcoming', label: 'Upcoming', icon: 'upcoming' },
    { id: 'all', label: 'All tasks', icon: 'all', count: openCount },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', count: calendarEvents.length },
    { id: 'notes', label: 'Notes', icon: 'notes', count: notes.length }
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => {
            setView('today')
            setSelectedNoteId(null)
            setAddingTask(false)
          }}
          aria-label="MyNotes — open Today"
          type="button"
        >
          <span className="brand-mark">
            <Icon name="spark" size={19} />
          </span>
          <span>MyNotes</span>
        </button>

        <nav className="primary-nav" aria-label="Main navigation">
          {navItems.map((item) => (
            <button
              className={`nav-item ${view === item.id ? 'active' : ''}`}
              key={item.id}
              onClick={() => {
                setView(item.id)
                setSelectedNoteId(null)
              }}
              type="button"
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {item.count !== undefined && <span className="nav-count">{item.count}</span>}
            </button>
          ))}
        </nav>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <span>MyNotes</span>
            <span className="breadcrumb-slash">/</span>
            <strong>{title}</strong>
          </div>
          <div className="topbar-actions">
            <label className="search-box">
              <Icon name="search" size={17} />
              <input
                aria-label="Search tasks and notes"
                placeholder="Search anything..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <kbd>⌘ K</kbd>
            </label>
          </div>
        </header>

        {view === 'notes' || view === 'calendar' ? (
          <section className={`notes-workspace ${view === 'calendar' ? 'calendar-container' : ''}`}>
            {view === 'notes' && (
              <div className="notes-heading">
                <div>
                  <p className="eyebrow">YOUR THINKING SPACE</p>
                  <h1>
                    Notes<span className="title-dot">.</span>
                  </h1>
                  <p className="section-subtitle">
                    A home for ideas, reminders, and everything in between.
                  </p>
                </div>
                <button className="primary-button" onClick={createNote} type="button">
                  <Icon name="plus" size={17} /> New note
                </button>
              </div>
            )}

            <div className="notes-layout">
              <div className="notes-list">
                {view === 'notes' && (
                  <div className="notes-list-heading">
                    <span>ALL NOTES</span>
                    <span>{notes.length}</span>
                  </div>
                )}
                {view === 'calendar' ? (
                  <section className="calendar-workspace">
                    <div className="calendar-heading">
                      <div>
                        <p className="eyebrow">YOUR SCHEDULE, IN ONE PLACE</p>
                        <h1>
                          Calendar<span className="title-dot">.</span>
                        </h1>
                        <p className="section-subtitle">
                          Tasks, UQU events, and recent note activity together.
                        </p>
                      </div>
                      <div className="calendar-source-controls">
                        <form className="calendar-link-form" onSubmit={syncCalendarLink}>
                          <label htmlFor="calendar-link">UQU calendar link</label>
                          <div className="calendar-link-controls">
                            <input
                              autoComplete="off"
                              id="calendar-link"
                              inputMode="url"
                              onChange={(event) => setCalendarUrlInput(event.target.value)}
                              placeholder="Paste an https:// or webcal:// link"
                              spellCheck={false}
                              type="text"
                              value={calendarUrlInput}
                            />
                            <button className="primary-button" type="submit">
                              <Icon name="calendar" size={16} />
                              {calendarUrl ? 'Sync calendar' : 'Add calendar link'}
                            </button>
                          </div>
                          <p>Saved on this device and refreshed when MyNotes opens.</p>
                        </form>
                        <div className="calendar-file-import">
                          <label htmlFor="calendar-file">Or import a calendar file (.ics)</label>
                          <input
                            accept=".ics,text/calendar"
                            id="calendar-file"
                            onChange={importCalendarFile}
                            type="file"
                          />
                        </div>
                      </div>
                    </div>

                    {calendarFeedback && (
                      <p className="calendar-feedback" role="status">
                        {calendarFeedback}
                      </p>
                    )}

                    <div className="calendar-toolbar">
                      <div className="month-controls">
                        <button
                          aria-label="Previous month"
                          className="month-arrow"
                          onClick={() => moveCalendarMonth(-1)}
                          type="button"
                        >
                          <Icon name="back" size={17} />
                        </button>
                        <button
                          aria-label="Next month"
                          className="month-arrow next-month"
                          onClick={() => moveCalendarMonth(1)}
                          type="button"
                        >
                          <Icon name="back" size={17} />
                        </button>
                        <strong>{calendarMonthLabel}</strong>
                        <button
                          className="today-button"
                          onClick={() => {
                            setCalendarMonth(new Date(`${today.slice(0, 7)}-01T12:00:00`))
                            setSelectedDate(today)
                          }}
                          type="button"
                        >
                          Today
                        </button>
                      </div>
                      <div className="calendar-legend">
                        <span>
                          <i className="legend-dot task-legend" /> Tasks
                        </span>
                        <span>
                          <i className="legend-dot event-legend" /> UQU events
                        </span>
                        <span>
                          <i className="legend-dot note-legend" /> Notes
                        </span>
                      </div>
                    </div>

                    <div className="calendar-layout">
                      <div className="calendar-grid-panel">
                        <div className="calendar-weekdays">
                          {weekdayNames.map((day) => (
                            <span key={day}>{day.slice(0, 3)}</span>
                          ))}
                        </div>
                        <div className="calendar-grid">
                          {calendarDays.map((day) => {
                            const entries = [
                              ...day.events.map((item) => ({
                                id: `event-${item.id}`,
                                title: item.title,
                                kind: 'event'
                              })),
                              ...day.tasks.map((item) => ({
                                id: `task-${item.id}`,
                                title: item.title,
                                kind: 'task'
                              })),
                              ...day.notes.map((item) => ({
                                id: `note-${item.id}`,
                                title: item.title || 'Untitled note',
                                kind: 'note'
                              }))
                            ]
                            return (
                              <button
                                aria-label={`${weekdayNames[day.date.getDay()]}, ${day.key}${entries.length ? `, ${entries.length} items` : ''}`}
                                aria-pressed={day.key === selectedDate}
                                className={`calendar-day ${day.isCurrentMonth ? '' : 'outside-month'} ${day.key === today ? 'is-today' : ''} ${day.key === selectedDate ? 'selected-day' : ''}`}
                                key={day.key}
                                onClick={() => selectCalendarDate(day.key)}
                                type="button"
                              >
                                <span className="calendar-day-number">{day.date.getDate()}</span>
                                <span className="calendar-day-entries">
                                  {entries.slice(0, 2).map((entry) => (
                                    <span
                                      className={`calendar-day-entry ${entry.kind}`}
                                      key={entry.id}
                                      title={entry.title}
                                    >
                                      {entry.title}
                                    </span>
                                  ))}
                                  {entries.length > 2 && (
                                    <span className="calendar-more">
                                      +{entries.length - 2} more
                                    </span>
                                  )}
                                </span>
                              </button>
                            )
                          })}
                        </div>
                      </div>

                      <aside className="calendar-day-panel">
                        <div className="calendar-day-panel-heading">
                          <div>
                            <p className="eyebrow">DAY PLAN</p>
                            <h2>{selectedDateLabel}</h2>
                          </div>
                          <button
                            className="day-add-button"
                            onClick={() => {
                              setNewTaskDue(selectedDate)
                              setAddingTask(true)
                            }}
                            type="button"
                          >
                            <Icon name="plus" size={15} /> Task
                          </button>
                        </div>

                        {addingTask && (
                          <form className="calendar-add-task" onSubmit={addTask}>
                            <input
                              autoFocus
                              aria-label="New task title"
                              placeholder="What needs doing?"
                              value={newTaskTitle}
                              onChange={(event) => setNewTaskTitle(event.target.value)}
                            />
                            <button className="save-task-button" type="submit">
                              Add
                            </button>
                            <button
                              aria-label="Cancel adding task"
                              className="cancel-task-button"
                              onClick={() => setAddingTask(false)}
                              type="button"
                            >
                              Cancel
                            </button>
                          </form>
                        )}

                        <div className="selected-day-items">
                          {selectedDayItems.events.map((item) => (
                            <article className="calendar-item event-item" key={item.id}>
                              <span className="calendar-item-marker" />
                              <div className="calendar-item-copy">
                                <strong>{item.title}</strong>
                                <span>
                                  {item.allDay ? 'All day' : (item.startTime ?? 'Scheduled event')}{' '}
                                  · UQU
                                </span>
                                {item.description && <small>{item.description}</small>}
                              </div>
                              <button
                                aria-label={`Remove ${item.title} from calendar`}
                                className="icon-button calendar-item-delete"
                                onClick={() =>
                                  setCalendarEvents((current) =>
                                    current.filter((event) => event.id !== item.id)
                                  )
                                }
                                type="button"
                              >
                                <Icon name="trash" size={14} />
                              </button>
                            </article>
                          ))}
                          {selectedDayItems.tasks.map((task) => (
                            <article
                              className={`calendar-item task-item ${task.done ? 'is-done' : ''}`}
                              key={task.id}
                            >
                              <button
                                aria-label={
                                  task.done
                                    ? `Mark ${task.title} as not done`
                                    : `Complete ${task.title}`
                                }
                                className={`task-check ${task.done ? 'checked' : ''}`}
                                onClick={() =>
                                  setTasks((current) =>
                                    current.map((item) =>
                                      item.id === task.id ? { ...item, done: !item.done } : item
                                    )
                                  )
                                }
                                type="button"
                              >
                                {task.done && <Icon name="check" size={12} />}
                              </button>
                              <div className="calendar-item-copy">
                                <strong>{task.title}</strong>
                                <span>{task.category} · Task</span>
                              </div>
                            </article>
                          ))}
                          {selectedDayItems.notes.map((note) => (
                            <button
                              className="calendar-item note-item"
                              key={note.id}
                              onClick={() => {
                                setSelectedNoteId(note.id)
                                setView('notes')
                              }}
                              type="button"
                            >
                              <span className="calendar-item-marker" />
                              <span className="calendar-item-copy">
                                <strong>{note.title || 'Untitled note'}</strong>
                                <span>Edited note</span>
                              </span>
                              <span className="note-open-arrow">→</span>
                            </button>
                          ))}
                          {selectedDayItems.events.length === 0 &&
                            selectedDayItems.tasks.length === 0 &&
                            selectedDayItems.notes.length === 0 && (
                              <div className="calendar-day-empty">
                                <span className="empty-note-icon">
                                  <Icon name="calendar" size={21} />
                                </span>
                                <strong>A clear day</strong>
                                <span>No tasks, events, or note activity.</span>
                              </div>
                            )}
                        </div>
                      </aside>
                    </div>

                    <p className="calendar-footnote">
                      Notes appear on the day they were last edited. UQU calendar events and your
                      tasks are saved locally on this device.
                    </p>
                  </section>
                ) : visibleNotes.length === 0 ? (
                  <div className="empty-list">
                    {notes.length === 0
                      ? 'Your notes will show up here.'
                      : 'No notes match your search.'}
                  </div>
                ) : (
                  visibleNotes.map((note) => (
                    <button
                      className={`note-row ${selectedNote?.id === note.id ? 'selected' : ''}`}
                      key={note.id}
                      onClick={() => setSelectedNoteId(note.id)}
                      type="button"
                    >
                      <span className="note-color" style={{ backgroundColor: note.color }} />
                      <span className="note-row-copy">
                        <strong>{note.title || 'Untitled note'}</strong>
                        <small>{note.content || 'No additional text'}</small>
                      </span>
                      <span className="note-row-date">
                        {new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(
                          new Date(note.updatedAt)
                        )}
                      </span>
                    </button>
                  ))
                )}
              </div>

              {view === 'notes' && selectedNote ? (
                <article className="note-editor">
                  <div className="editor-topline">
                    <span>
                      <span className="save-dot" /> SAVED LOCALLY
                    </span>
                    <button
                      aria-label="Delete note"
                      className="icon-button delete-note"
                      onClick={() => {
                        setNotes((current) => current.filter((note) => note.id !== selectedNote.id))
                        setSelectedNoteId(null)
                      }}
                      type="button"
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  </div>
                  <input
                    className="note-title-input"
                    aria-label="Note title"
                    value={selectedNote.title}
                    onChange={(event) => updateNote('title', event.target.value)}
                    placeholder="Untitled note"
                  />
                  <textarea
                    className="note-content-input"
                    aria-label="Note content"
                    value={selectedNote.content}
                    onChange={(event) => updateNote('content', event.target.value)}
                    placeholder="Start writing your thoughts..."
                  />
                  <div className="editor-footer">
                    <span>Created for your eyes only</span>
                    <span>
                      {selectedNote.content.trim().split(/\s+/).filter(Boolean).length} words
                    </span>
                  </div>
                </article>
              ) : view === 'notes' ? (
                <div className="note-empty-state">
                  <span className="empty-note-icon">
                    <Icon name="notes" size={23} />
                  </span>
                  <h2>{notes.length ? 'Pick up where you left off' : 'Start with a blank page'}</h2>
                  <p>
                    {notes.length
                      ? 'Choose a note from the list to read or edit it.'
                      : 'Capture a thought before it slips away.'}
                  </p>
                  {!notes.length && (
                    <button className="text-button" onClick={createNote} type="button">
                      Create your first note <span>→</span>
                    </button>
                  )}
                </div>
              ) : null}
            </div>
          </section>
        ) : (
          <div className="dashboard">
            <section className="dashboard-heading">
              <div>
                <p className="eyebrow">
                  {view === 'today' ? dateLabel.toUpperCase() : 'KEEP YOUR MOMENTUM'}
                </p>
                <h1>
                  {view === 'today' ? 'Today' : view === 'upcoming' ? 'Coming up' : 'All tasks'}
                  <span className="title-dot">.</span>
                </h1>
                <p className="section-subtitle">
                  {view === 'today'
                    ? 'A fresh day to make meaningful progress.'
                    : view === 'upcoming'
                      ? 'See what’s on the horizon and plan ahead.'
                      : 'Everything you need to get across the finish line.'}
                </p>
              </div>
              <button className="primary-button" onClick={() => setAddingTask(true)} type="button">
                <Icon name="plus" size={17} /> Add a task
              </button>
            </section>

            <section className="welcome-card">
              <div className="welcome-content">
                <span className="welcome-kicker">
                  <span className="welcome-spark">✳</span> YOUR DAILY CHECK-IN
                </span>
                <h2>{openCount === 0 ? 'You’ve made it through.' : 'One thing at a time.'}</h2>
                <p>
                  {openCount === 0
                    ? 'Enjoy the breathing room. You’ve earned it.'
                    : 'You have things to do, but no need to do them all at once.'}
                </p>
                <div className="progress-wrap">
                  <div className="progress-track">
                    <span
                      style={{
                        width: `${tasks.length ? (completedCount / tasks.length) * 100 : 0}%`
                      }}
                    />
                  </div>
                  <span>
                    {completedCount} of {tasks.length} done
                  </span>
                </div>
              </div>
              <div className="welcome-art" aria-hidden="true">
                <div className="art-sun" />
                <div className="art-arch">
                  <div className="art-inner-arch" />
                </div>
                <span className="art-star star-one">✳</span>
                <span className="art-star star-two">✦</span>
                <span className="art-dot" />
              </div>
            </section>

            <section className="task-section">
              <div className="task-section-heading">
                <div>
                  <h2>
                    {view === 'today'
                      ? 'Your tasks'
                      : view === 'upcoming'
                        ? 'Coming up next'
                        : 'All your tasks'}
                  </h2>
                  <p>{visibleTasks.filter((task) => !task.done).length} left to do</p>
                </div>
                <div className="task-filter">
                  <span className="filter-dot" />
                  {view === 'today' ? 'Today' : view === 'upcoming' ? 'Upcoming' : 'All tasks'}
                </div>
              </div>

              {addingTask && (
                <form className="add-task-form" onSubmit={addTask}>
                  <span className="unchecked-circle" />
                  <input
                    autoFocus
                    aria-label="Task name"
                    placeholder="What needs to get done?"
                    value={newTaskTitle}
                    onChange={(event) => setNewTaskTitle(event.target.value)}
                  />
                  <input
                    aria-label="Task due date"
                    className="date-input"
                    type="date"
                    value={newTaskDue}
                    onChange={(event) => setNewTaskDue(event.target.value)}
                  />
                  <button className="save-task-button" type="submit">
                    Add
                  </button>
                  <button
                    className="cancel-task-button"
                    onClick={() => setAddingTask(false)}
                    type="button"
                  >
                    Cancel
                  </button>
                </form>
              )}

              <div className="task-list">
                {visibleTasks.length === 0 ? (
                  <div className="task-empty">
                    <span className="task-empty-check">
                      <Icon name="check" size={18} />
                    </span>
                    <strong>{query ? 'No matching tasks' : 'Nothing on your list'}</strong>
                    <span>
                      {query ? 'Try another search.' : 'Take a breath, or add something new.'}
                    </span>
                  </div>
                ) : (
                  visibleTasks.map((task) => (
                    <div className={`task-row ${task.done ? 'is-done' : ''}`} key={task.id}>
                      <button
                        aria-label={
                          task.done ? `Mark ${task.title} as not done` : `Complete ${task.title}`
                        }
                        className={`task-check ${task.done ? 'checked' : ''}`}
                        onClick={() =>
                          setTasks((current) =>
                            current.map((item) =>
                              item.id === task.id ? { ...item, done: !item.done } : item
                            )
                          )
                        }
                        type="button"
                      >
                        {task.done && <Icon name="check" size={13} />}
                      </button>
                      <div className="task-main">
                        <span className="task-title">{task.title}</span>
                        <span className="task-meta">
                          <span className={`priority-dot ${task.priority.toLowerCase()}`} />
                          {task.category}
                        </span>
                      </div>
                      <span className="task-due">
                        {task.due === today
                          ? 'Today'
                          : task.due === tomorrow
                            ? 'Tomorrow'
                            : new Intl.DateTimeFormat('en', {
                                month: 'short',
                                day: 'numeric'
                              }).format(new Date(`${task.due}T12:00:00`))}
                      </span>
                      <button
                        aria-label={`Delete ${task.title}`}
                        className="icon-button task-delete"
                        onClick={() =>
                          setTasks((current) => current.filter((item) => item.id !== task.id))
                        }
                        type="button"
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              {!addingTask && (
                <button
                  className="add-another-button"
                  onClick={() => setAddingTask(true)}
                  type="button"
                >
                  <span>
                    <Icon name="plus" size={15} />
                  </span>{' '}
                  Add a task
                </button>
              )}
            </section>

            <footer className="dashboard-footer">
              <span>
                <span className="save-dot" /> Your tasks are saved on this device
              </span>
              <button className="footer-note-link" onClick={() => setView('notes')} type="button">
                Need to jot something down?{' '}
                <strong>
                  Open notes <span>→</span>
                </strong>
              </button>
            </footer>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
