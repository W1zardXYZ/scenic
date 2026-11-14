import { useCallback, useSyncExternalStore } from 'react'

// Which settings sections are open, kept in this browser. Shared by every map, like a panel layout.
const KEY = 'scenic.sections'
const listeners = new Set<() => void>()
let open: Record<string, boolean> = (() => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {}
  }
})()

export function setSectionOpen(id: string, value: boolean) {
  open = { ...open, [id]: value }
  try {
    localStorage.setItem(KEY, JSON.stringify(open))
  } catch {
    // Storage may be refused; the layout still holds for this visit.
  }
  listeners.forEach((l) => l())
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

export function useSectionOpen(id: string, initially: boolean): [boolean, (value: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => open[id] ?? initially)
  return [value, useCallback((next: boolean) => setSectionOpen(id, next), [id])]
}
