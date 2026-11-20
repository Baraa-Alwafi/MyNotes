// @vitest-environment jsdom

// Runtime validation coverage for: note writing and task status
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

type ReminderNotice = { title: string; body: string }
let sendTaskReminder: ((notice: ReminderNotice) => void) | undefined

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('crypto', { randomUUID: () => 'checklist-item-1' })
  sendTaskReminder = undefined
  window.api = {
    fetchCalendar: vi.fn().mockResolvedValue(''),
    syncTaskReminders: vi.fn(),
    onTaskReminder: vi.fn((callback: (notice: ReminderNotice) => void) => {
      sendTaskReminder = callback
      return vi.fn()
    })
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('Notes editor', () => {
  it('saves writing size, zoom, checklist state, and linked task', () => {
    render(<App />)

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', {
        name: /Notes/
      })
    )
    fireEvent.click(screen.getByRole('button', { name: /A little space to think/ }))

    fireEvent.click(screen.getByRole('button', { name: 'Increase text size' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.change(screen.getByLabelText('Link this note to a task'), {
      target: { value: 'welcome-1' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add item' }))
    fireEvent.change(screen.getByLabelText('Checklist item 1'), {
      target: { value: 'Review the draft' }
    })
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark checklist item 1 as complete' }))

    expect((screen.getByLabelText('Note content') as HTMLTextAreaElement).style.fontSize).toBe(
      '18px'
    )
    expect(screen.getByText('110%')).toBeTruthy()

    const savedNotes = JSON.parse(localStorage.getItem('daymark.notes') ?? '[]')
    expect(savedNotes[0]).toMatchObject({
      fontSize: 18,
      linkedTaskId: 'welcome-1',
      checklist: [{ text: 'Review the draft', done: true }]
    })
    expect(JSON.parse(localStorage.getItem('daymark.note-zoom') ?? 'null')).toBe(110)
  })

  it('marks an unfinished task with a past deadline as missed', () => {
    localStorage.setItem(
      'daymark.tasks',
      JSON.stringify([
        {
          id: 'overdue-task',
          title: 'Overdue task',
          due: '2000-01-01',
          category: 'Personal',
          priority: 'High',
          done: false
        }
      ])
    )

    render(<App />)

    expect(screen.getByText('Overdue task')).toBeTruthy()
    expect(screen.getByText('Missed')).toBeTruthy()
  })

  it('shows and dismisses a reminder while the app window is open', () => {
    render(<App />)

    act(() => {
      sendTaskReminder?.({
        title: 'MyNotes task reminder',
        body: 'Review the draft is due at 6:00 PM.'
      })
    })

    expect(screen.getByRole('status').textContent).toContain('Review the draft is due at 6:00 PM.')
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss reminder' }))
    expect(screen.queryByRole('status')).toBeNull()
  })
})
