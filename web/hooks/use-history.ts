import { useCallback, useEffect, useRef, useState } from 'react'

const QUIET_MS = 350
const LIMIT = 100

const same = <T extends object>(a: T, b: T) => (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key])

/**
 * Undo over a flat object of state. Changes settle into one step: a drag or
 * slider counts once, however many values it passed through.
 */
export function useHistory<T extends object>(state: T, restore: (state: T) => void) {
  const [, redraw] = useState(0)
  const past = useRef<T[]>([])
  const future = useRef<T[]>([])
  const settled = useRef(state)
  const latest = useRef(state)
  const pressed = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  latest.current = state

  const settle = useCallback(() => {
    clearTimeout(timer.current)
    if (same(latest.current, settled.current)) return
    past.current = [...past.current, settled.current].slice(-LIMIT)
    future.current = []
    settled.current = latest.current
    redraw((n) => n + 1)
  }, [])

  useEffect(() => {
    if (same(state, settled.current)) return
    clearTimeout(timer.current)
    if (!pressed.current) timer.current = setTimeout(settle, QUIET_MS)
  })

  useEffect(() => {
    const down = () => {
      pressed.current = true
    }
    const up = () => {
      pressed.current = false
      clearTimeout(timer.current)
      timer.current = setTimeout(settle, QUIET_MS)
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('pointerup', up, true)
    window.addEventListener('pointercancel', up, true)
    return () => {
      clearTimeout(timer.current)
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('pointerup', up, true)
      window.removeEventListener('pointercancel', up, true)
    }
  }, [settle])

  const step = useCallback((from: React.RefObject<T[]>, to: React.RefObject<T[]>) => {
    settle()
    const next = from.current.at(-1)
    if (!next) return false
    from.current = from.current.slice(0, -1)
    to.current = [...to.current, settled.current]
    settled.current = next
    restore(next)
    redraw((n) => n + 1)
    return true
  }, [restore, settle])

  return {
    undo: useCallback(() => step(past, future), [step]),
    redo: useCallback(() => step(future, past), [step]),
    canUndo: past.current.length > 0 || !same(state, settled.current),
    canRedo: future.current.length > 0,
  }
}
