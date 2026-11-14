import { useState } from 'react'
import { MoreHorizontal, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { IconButton } from '@/components/controls'
import { PromptDialog } from './PromptDialog.tsx'
import type { Looks } from './use-looks.ts'

type Asking = 'new' | 'rename' | 'delete' | null

/** Looks: tone settings kept by name, to put on any map. Applying one copies its values into this map. */
export function LooksControl({ looks }: { looks: Looks }) {
  const { chosen, modified, defaultId } = looks
  const [asking, setAsking] = useState<Asking>(null)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        {looks.looks.length > 0 ? (
          <Select value={chosen ? String(chosen.id) : ''} onValueChange={(id) => looks.apply(Number(id))}>
            <SelectTrigger aria-label="Look" className="min-w-0 flex-1"><SelectValue placeholder="Choose a look" /></SelectTrigger>
            <SelectContent position="popper" align="start">
              <SelectGroup>
                {looks.looks.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}{l.id === defaultId ? ' · default' : ''}</SelectItem>)}
              </SelectGroup>
            </SelectContent>
          </Select>
        ) : (
          <p className="flex-1 text-sm text-muted-foreground">No looks yet.</p>
        )}
        {chosen && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton label={`Actions for ${chosen.name}`} icon={MoreHorizontal} className="shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-56">
              {modified && <DropdownMenuItem onSelect={() => looks.apply(chosen.id)}>Revert to the saved look</DropdownMenuItem>}
              {modified && <DropdownMenuItem onSelect={() => void looks.update()}>Update with the current look</DropdownMenuItem>}
              {modified && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setAsking('rename')}>Rename…</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void looks.setDefault(chosen.id !== defaultId)}>
                {chosen.id === defaultId ? 'Stop starting new maps with it' : 'Start new maps with it'}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={() => setAsking('delete')}>Delete…</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {chosen && (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {modified ? `Changed since “${chosen.name}” was applied. The look itself is unchanged.` : `Matches “${chosen.name}”.`}
        </p>
      )}
      <Button variant="secondary" onClick={() => setAsking('new')}><Plus data-icon="inline-start" />Save this look…</Button>
      <p className="text-xs text-muted-foreground">
        Ink, levels, curve, tone ranges, colour selections and the edge fade. Colour selections match the picked colours on any map, so they only change maps that have those colours.
      </p>

      {asking === 'new' && (
        <PromptDialog title="Save this look" description="Its values can be applied to any map." label="Name" confirm="Save" onConfirm={looks.saveNew} onClose={() => setAsking(null)} />
      )}
      {asking === 'rename' && chosen && (
        <PromptDialog title="Rename look" label="Name" initial={chosen.name} confirm="Rename" onConfirm={looks.rename} onClose={() => setAsking(null)} />
      )}
      {asking === 'delete' && chosen && (
        <PromptDialog
          title={`Delete “${chosen.name}”?`}
          description="Maps it was applied to keep their values."
          confirm="Delete"
          destructive
          onConfirm={looks.remove}
          onClose={() => setAsking(null)}
        />
      )}
    </div>
  )
}
