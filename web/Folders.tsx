import { useEffect, useState } from 'react'
import { ChevronRight, ChevronsUpDown, CornerLeftUp, FolderPlus, Folder, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import type { FailedFile, ScanStatus } from '../shared/types.ts'
import { Hint, IconButton } from '@/components/controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { api } from './api.ts'

interface Listing {
  path: string
  parent: string | null
  dirs: string[]
}

function Picker({ listing, browse, onPick, onCancel }: {
  listing: Listing
  browse: (path: string) => void
  onPick: () => void
  onCancel: () => void
}) {
  const row = 'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-accent focus-visible:ring-3 focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-muted-foreground'
  return (
    <>
      <p className="text-sm break-all text-muted-foreground">{listing.path}</p>
      <ScrollArea className="-mx-3 h-72">
        <ul className="px-3">
          {listing.parent && (
            <li><button className={row} onClick={() => browse(listing.parent!)}><CornerLeftUp />Up one level</button></li>
          )}
          {listing.dirs.map((dir) => (
            <li key={dir}>
              <button className={row} onClick={() => browse(`${listing.path.replace(/\/$/, '')}/${dir}`)}>
                <Folder /><span className="min-w-0 flex-1 truncate">{dir}</span><ChevronRight />
              </button>
            </li>
          ))}
          {!listing.dirs.length && <li className="px-3 py-2 text-sm text-muted-foreground">No subfolders</li>}
        </ul>
      </ScrollArea>
      <DialogFooter>
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button onClick={onPick}>Use this folder</Button>
      </DialogFooter>
    </>
  )
}

export function Folders({ status, pick, onClose, onChanged }: {
  status: ScanStatus | null
  /** Open straight on the folder picker. */
  pick: boolean
  onClose: () => void
  onChanged: () => void
}) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [failed, setFailed] = useState<FailedFile[]>([])

  const fail = (e: Error) => void toast.error(e.message)
  const browse = (path?: string) => api.browse(path).then(setListing, fail)
  const act = (work: Promise<unknown>) => work.then(onChanged, fail)

  useEffect(() => {
    if (pick) void browse()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (status?.failed) void api.failed().then(setFailed)
  }, [status?.failed])

  const roots = status?.roots ?? []

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{listing ? 'Choose a folder' : 'Folders'}</DialogTitle>
          <DialogDescription className={listing ? 'sr-only' : undefined}>Read-only. Originals are never changed.</DialogDescription>
        </DialogHeader>

        {listing ? (
          <Picker
            listing={listing}
            browse={browse}
            onCancel={() => setListing(null)}
            onPick={() => {
              void act(api.addRoot(listing.path))
              setListing(null)
            }}
          />
        ) : (
          <>
            {roots.length > 0 ? (
              <ScrollArea className="-mx-3 max-h-64 min-h-0">
                <ul className="flex flex-col px-3">
                  {roots.map((root) => (
                    <li key={root.id} className="flex items-center gap-3 rounded-md py-1 pr-1 pl-3 hover:bg-accent/50">
                      <span className="min-w-0 flex-1 text-sm break-all">{root.path}</span>
                      {!root.online && <Badge variant="destructive">Offline</Badge>}
                      <IconButton label="Remove folder" icon={Trash2} onClick={() => act(api.removeRoot(root.id))} />
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            ) : (
              <p className="text-sm text-muted-foreground">No folders yet</p>
            )}

            {status?.running && (
              <div className="flex flex-col gap-2" role="status">
                <Progress aria-label="Indexing progress" value={status.total ? (status.done / status.total) * 100 : 4} />
                <p className="flex justify-between gap-4 text-xs text-muted-foreground">
                  <span className="truncate">{status.current || 'Looking for maps'}</span>
                  <span className="shrink-0 tabular-nums">{status.done} of {status.total}</span>
                </p>
              </div>
            )}

            {failed.length > 0 && (
              <Collapsible>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" className="-mx-3 w-[calc(100%+1.5rem)] justify-between font-normal text-muted-foreground">
                    {failed.length} {failed.length === 1 ? 'file' : 'files'} could not be read
                    <ChevronsUpDown data-icon="inline-end" />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <ul className="mt-2 flex max-h-48 flex-col gap-3 overflow-y-auto text-xs">
                    {failed.map((f) => (
                      <li key={f.rel} className="break-all">
                        <p>{f.rel}</p>
                        <p className="text-muted-foreground">{f.error}</p>
                      </li>
                    ))}
                  </ul>
                </CollapsibleContent>
              </Collapsible>
            )}

            <DialogFooter>
              <Hint label="Look for new maps">
                <Button variant="ghost" disabled={status?.running} onClick={() => act(api.scan())}>
                  <RefreshCw data-icon="inline-start" className={status?.running ? 'animate-spin' : undefined} />
                  {status?.running ? 'Scanning' : 'Rescan'}
                </Button>
              </Hint>
              <Button onClick={() => browse()}><FolderPlus data-icon="inline-start" />Add a folder</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
