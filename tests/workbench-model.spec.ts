import { describe, test, expect } from 'vitest'
import { activeTask, navLayout, openPage, openTask, readNavigation, routeTab, INITIAL_NAVIGATION } from '../src/client/workbench/workbench-model.ts'

describe('reference-derived measured navigation', () => {
  test('fits every translated item without a More button', () => {
    expect(navLayout([44, 56, 68, 44], 218, 54)).toEqual({ visible: [0, 1, 2, 3], overflow: [] })
  })
  test('moves trailing items to More, reserving its measured width', () => {
    expect(navLayout([44, 56, 68, 44], 170, 54)).toEqual({ visible: [0, 1], overflow: [2, 3] })
  })
  test('subpixel tolerance prevents unstable overflow decisions', () => {
    expect(navLayout([50, 50], 101.5, 50)).toEqual({ visible: [0, 1], overflow: [] })
  })
  test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('invalid width %s never hides a feature', available => {
    expect(navLayout([50, 50], available, 50).overflow).toEqual([])
  })
  test('unusable measurements fail open and empty lists are safe', () => {
    expect(navLayout([50, Number.NaN], 100, 40).overflow).toEqual([])
    expect(navLayout([], 100, 40)).toEqual({ visible: [], overflow: [] })
    expect(navLayout([80, 80], 60, 50).overflow).toEqual([])
  })
})
describe('workbench page and full-width task navigation', () => {
  test('a task belongs to its origin: switching away suspends, returning resumes', () => {
    const task = openTask(INITIAL_NAVIGATION, 'transfer')
    expect(activeTask(task)).toBe('transfer')
    const away = openPage(task, 'entries')
    expect(activeTask(away)).toBeNull()
    expect(activeTask(openPage(away, 'home'))).toBe('transfer')
  })
  test('business row navigation returns to entries and closes the report task', () => {
    expect(routeTab(openTask(INITIAL_NAVIGATION, 'security'), 'entries')).toEqual({ page: 'entries', task: null })
  })
  test('all eight original destinations remain routable', () => {
    for (const tab of ['entries','security','transfer','backup','permissions','sessions','audit','trash'] as const) {
      const state = routeTab(INITIAL_NAVIGATION, tab)
      expect(state.task?.kind ?? state.page).toBe(tab)
    }
  })
  test('storage can restore only an allowlisted main page, never task or secret data', () => {
    expect(readNavigation('{"page":"backup","task":{"kind":"transfer"},"password":"fixture"}')).toEqual({ page: 'backup', task: null })
    expect(readNavigation('{"page":"__proto__"}')).toEqual(INITIAL_NAVIGATION)
    expect(readNavigation('broken')).toEqual(INITIAL_NAVIGATION)
    expect(readNavigation(null)).toEqual(INITIAL_NAVIGATION)
  })
})
