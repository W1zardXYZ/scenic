import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** Asks for a name, or only for a yes when `label` is left out. A refusal from `onConfirm` is shown and keeps the dialog open. */
export function PromptDialog({ title, description, label, initial = '', confirm, destructive, onConfirm, onClose }: {
  title: string
  description?: string
  label?: string
  initial?: string
  confirm: string
  destructive?: boolean
  onConfirm: (value: string) => Promise<void>
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (busy || (label && !value.trim())) return
    setBusy(true)
    try {
      await onConfirm(value.trim())
      onClose()
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-sm" showCloseButton={false}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className={description ? undefined : 'sr-only'}>{description ?? title}</DialogDescription>
          </DialogHeader>
          {label && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="prompt-name" className="text-xs font-normal text-muted-foreground">{label}</Label>
              <Input id="prompt-name" autoFocus value={value} maxLength={60} aria-invalid={!!error} aria-describedby={error ? 'prompt-error' : undefined} onChange={(e) => { setValue(e.target.value); setError('') }} />
            </div>
          )}
          {error && <p id="prompt-error" role="alert" className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant={destructive ? 'destructive' : 'default'} aria-disabled={busy}>{confirm}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
