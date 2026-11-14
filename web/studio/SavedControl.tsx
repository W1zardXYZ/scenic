import { useState } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { IconButton } from '@/components/controls'
import { PromptDialog } from './PromptDialog.tsx'
import type { Saves } from './use-saves.ts'

const when = (time: number) => new Date(time).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

type Asking = { kind: 'save'; name: string } | { kind: 'delete'; name: string } | null

/** Copies of this map's print settings, kept by name. Your changes are also kept as you make them, without a copy. */
export function SavedControl({ saves }: { saves: Saves }) {
  const [asking, setAsking] = useState<Asking>(null)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        Your changes to this map are kept as you make them, so it opens as you left it. Save a copy to come back to one particular setup, for example the one you printed.
      </p>
      <Button variant="secondary" onClick={() => setAsking({ kind: 'save', name: `Print ${saves.copies.length + 1}` })}><Plus data-icon="inline-start" />Save a copy…</Button>
      {saves.copies.length > 0 && (
        <ul aria-label="Saved copies" className="flex flex-col divide-y rounded-md border">
          {saves.copies.map((copy) => (
            <li key={copy.name} className="flex items-center gap-1 py-1 pr-1 pl-3">
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-medium">{copy.name}</span>
                <span className="text-muted-foreground"> · {when(copy.saved)}</span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => saves.open(copy.name)}>Load</Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <IconButton label={`Actions for ${copy.name}`} icon={MoreHorizontal} />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-auto min-w-56">
                  <DropdownMenuItem onSelect={() => saves.open(copy.name, true)}>Load and create the export</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setAsking({ kind: 'save', name: copy.name })}>Replace with the current settings…</DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onSelect={() => setAsking({ kind: 'delete', name: copy.name })}>Delete…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}
      {asking?.kind === 'save' && (
        <PromptDialog
          title="Save a copy"
          description="Saving under a name already used replaces that copy."
          label="Name"
          initial={asking.name}
          confirm="Save"
          onConfirm={saves.save}
          onClose={() => setAsking(null)}
        />
      )}
      {asking?.kind === 'delete' && (
        <PromptDialog title={`Delete “${asking.name}”?`} confirm="Delete" destructive onConfirm={() => saves.remove(asking.name)} onClose={() => setAsking(null)} />
      )}
    </div>
  )
}
