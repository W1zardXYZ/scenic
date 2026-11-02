import { useRef } from 'react'

/** A dialog opened from a menu outlives the menu item, so the menu's button stands in for it. */
function currentOpener() {
  const active = document.activeElement as HTMLElement | null
  const menu = active?.closest('[role=menu]')
  return menu ? document.getElementById(menu.getAttribute('aria-labelledby') ?? '') : active
}

type FocusHandler = (event: Event) => void

/** Radix only returns focus to its own trigger; this returns it to whatever had focus when the dialog opened. */
export function useReturnFocus(onOpen?: FocusHandler, onClose?: FocusHandler) {
  const opener = useRef<HTMLElement | null>(null)
  return {
    onOpenAutoFocus: (event: Event) => {
      opener.current = currentOpener()
      onOpen?.(event)
    },
    onCloseAutoFocus: (event: Event) => {
      onClose?.(event)
      const element = opener.current
      if (event.defaultPrevented || !element?.isConnected || element === document.body) return
      event.preventDefault()
      element.focus()
    },
  }
}
