import { useState } from 'react'
import { toast } from 'sonner'
import { announce } from '../announce.ts'
import { api, type SavedCopy } from '../api.ts'
import { readSnapshot, type Snapshot } from './snapshot.ts'

export interface Saves {
  copies: SavedCopy[]
  /** Saves the current settings under a name, replacing a copy that has it. */
  save: (name: string) => Promise<void>
  remove: (name: string) => Promise<void>
  /** Puts a copy's settings on the map; with `create`, then starts the export. */
  open: (name: string, create?: boolean) => void
}

/** Named copies of a map's print settings. The working settings are kept on their own, as you go. */
export function useSaves(mapId: number, initial: SavedCopy[], current: Snapshot, defaults: Snapshot, load: (s: Snapshot, create: boolean) => void): Saves {
  const [copies, setCopies] = useState(initial)
  const refresh = () => api.printState(mapId).then((s) => setCopies(s.saves))
  return {
    copies,
    save: async (name) => {
      await api.savePrintState(mapId, current, name)
      await refresh()
      toast.success(`Saved “${name}”`)
    },
    remove: async (name) => {
      await api.deletePrintCopy(mapId, name)
      await refresh()
    },
    open: (name, create = false) => {
      const copy = copies.find((c) => c.name === name)
      if (!copy) return
      load(readSnapshot(copy.settings, defaults), create)
      announce(`${name} loaded`)
    },
  }
}
