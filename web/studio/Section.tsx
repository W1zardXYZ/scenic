import { ChevronRight, RotateCcw } from 'lucide-react'
import { IconButton } from '@/components/controls'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useSectionOpen } from './sections.ts'

/**
 * A settings section with a header that opens and closes it, and that remembers
 * which. `changed` marks a section that differs from its defaults, so a closed
 * one still tells; `onReset` brings it back to them.
 */
export function Section({ id, title, initiallyOpen = true, changed = false, onReset, aside, children }: {
  id: string
  title: string
  initiallyOpen?: boolean
  changed?: boolean
  onReset?: () => void
  aside?: React.ReactNode
  children: React.ReactNode
}) {
  const [open, setOpen] = useSectionOpen(id, initiallyOpen)
  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <section data-section={id} className="py-1">
        <header className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 flex-1 text-sm font-medium">
            <CollapsibleTrigger className="group/section -ml-2 flex w-full items-center gap-1.5 rounded-md py-2.5 pr-2 pl-2 text-left outline-none hover:bg-accent/50 focus-visible:ring-3 focus-visible:ring-ring/50">
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]/section:rotate-90" />
              <span className="truncate">{title}</span>
              {changed && (
                <>
                  <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-primary" />
                  <span className="sr-only">, changed</span>
                </>
              )}
            </CollapsibleTrigger>
          </h2>
          {aside}
          {changed && onReset && <IconButton label={`Reset ${title.toLowerCase()}`} icon={RotateCcw} onClick={onReset} className="shrink-0" />}
        </header>
        <CollapsibleContent>
          <div className="flex flex-col gap-3 pt-1 pb-4">{children}</div>
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}
