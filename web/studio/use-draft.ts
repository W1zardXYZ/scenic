import { startTransition, useEffect, useRef, useState } from 'react'

/**
 * A copy of a setting that follows the pointer at once, while the preview
 * catches up when the browser is free. Outside changes, such as undo, replace
 * the copy; the copy's own values coming back late do not.
 */
export function useDraft<T>(value: T, commit: (next: T) => void): [T, (next: T) => void] {
  const [draft, setDraft] = useState(value)
  const pending = useRef<T[]>([])
  useEffect(() => {
    const i = pending.current.indexOf(value)
    if (i >= 0) pending.current.splice(0, i + 1)
    else {
      pending.current = []
      setDraft(value)
    }
  }, [value])
  const apply = (next: T) => {
    pending.current.push(next)
    setDraft(next)
    startTransition(() => commit(next))
  }
  return [draft, apply]
}
