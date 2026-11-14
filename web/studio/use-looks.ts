import { useCallback, useState } from 'react'
import { toast } from 'sonner'
import { type Look, sameLook } from '../../shared/look.ts'
import { announce } from '../announce.ts'
import { api, type SavedLook } from '../api.ts'

export interface Looks {
  looks: SavedLook[]
  defaultId: number | null
  /** The look the map's tones started from, if it still exists. */
  chosen: SavedLook | undefined
  /** The map's tones no longer match that look. */
  modified: boolean
  apply: (id: number) => void
  saveNew: (name: string) => Promise<void>
  update: () => Promise<void>
  rename: (name: string) => Promise<void>
  setDefault: (isDefault: boolean) => Promise<void>
  remove: () => Promise<void>
}

/**
 * Looks are copied into the map when applied; the map keeps the values, not a link,
 * so tweaking them here never changes the look. `lookId` only remembers where they came from.
 */
export function useLooks(
  initial: { looks: SavedLook[]; defaultId: number | null },
  current: Look,
  lookId: number | null,
  use: (look: Look, id: number | null) => void,
): Looks {
  const [{ looks, defaultId }, setState] = useState(initial)
  const chosen = looks.find((l) => l.id === lookId)
  const refresh = useCallback(() => api.looks().then(setState), [])
  /** For actions with no dialog to show a refusal in. */
  const attempt = async (work: () => Promise<string>) => {
    try {
      toast.success(await work())
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  return {
    looks,
    defaultId,
    chosen,
    modified: !!chosen && !sameLook(chosen.look, current),
    apply: (id) => {
      const look = looks.find((l) => l.id === id)
      if (!look) return
      use(look.look, id)
      announce(`${look.name} applied`)
    },
    saveNew: async (name) => {
      const { id } = await api.createLook(name, current)
      await refresh()
      use(current, id)
      toast.success(`Saved the look “${name}”`)
    },
    update: () => attempt(async () => {
      await api.updateLook(chosen!.id, { look: current })
      await refresh()
      return `Updated “${chosen!.name}”. Maps that used it keep their own copy`
    }),
    rename: async (name) => {
      if (!chosen) return
      await api.updateLook(chosen.id, { name })
      await refresh()
    },
    setDefault: (isDefault) => attempt(async () => {
      await api.updateLook(chosen!.id, { isDefault })
      await refresh()
      return isDefault ? `New maps will start with “${chosen!.name}”` : 'New maps start without a look'
    }),
    remove: async () => {
      if (!chosen) return
      await api.deleteLook(chosen.id)
      await refresh()
      use(current, null)
      toast.success(`Deleted “${chosen.name}”`)
    },
  }
}
