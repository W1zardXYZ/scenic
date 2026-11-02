export const ANNOUNCER_ID = 'announcer'

/** Says something to screen readers through the one live region in `App`. */
export function announce(text: string) {
  const region = document.getElementById(ANNOUNCER_ID)
  if (!region) return
  // Clearing first makes a repeated message speak again.
  region.textContent = ''
  setTimeout(() => (region.textContent = text), 50)
}
