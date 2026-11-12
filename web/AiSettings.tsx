import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import type { AiSettings as Settings, AiStatus } from '../shared/types.ts'
import { SwitchRow } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { api } from './api.ts'

const PRESETS = [
  ['OpenRouter', 'https://openrouter.ai/api/v1'],
  ['LM Studio', 'http://your-mac.local:1234/v1'],
  ['Ollama', 'http://your-mac.local:11434/v1'],
] as const

type Model = Awaited<ReturnType<typeof api.aiModels>>[number]

const dollars = (n: number) => (n < 0.01 ? `under $0.01` : `$${n < 1 ? n.toFixed(2) : n.toFixed(n < 100 ? 2 : 0)}`)

function TextField({ label, hint, ...props }: { label: string; hint?: React.ReactNode } & React.ComponentProps<typeof Input>) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} spellCheck={false} autoComplete="off" {...props} />
      {hint && <FieldDescription className="text-xs">{hint}</FieldDescription>}
    </Field>
  )
}

/** The AI connection: where thumbnails go, with what key and model, and the run that describes scenes. */
export function AiSettingsForm({ onChanged }: { onChanged: () => void }) {
  const [saved, setSaved] = useState<Settings | null>(null)
  const [draft, setDraft] = useState({ baseUrl: '', model: '', apiKey: '' })
  const [status, setStatus] = useState<AiStatus | null>(null)
  const [models, setModels] = useState<Model[]>([])
  const [busy, setBusy] = useState(false)
  const listId = useId()
  const fail = (e: Error) => void toast.error(e.message)

  const refresh = () => api.aiStatus().then(setStatus, fail)

  useEffect(() => {
    api.ai().then((s) => {
      setSaved(s)
      setDraft({ baseUrl: s.baseUrl, model: s.model, apiKey: '' })
    }, fail)
    void refresh()
  }, [])

  // Follows a run while it lasts; new descriptions show up in the library as they arrive.
  useEffect(() => {
    if (!status?.running) return
    const timer = setInterval(() => {
      void refresh()
      onChanged()
    }, 2000)
    return () => clearInterval(timer)
  }, [status?.running])

  if (!saved) return <p className="text-sm text-muted-foreground">Loading…</p>

  const patch = async (change: Parameters<typeof api.saveAi>[0], message?: string) => {
    setBusy(true)
    try {
      setSaved(await api.saveAi(change))
      if (message) toast.success(message)
      await refresh()
    } catch (e) {
      fail(e as Error)
    } finally {
      setBusy(false)
    }
  }

  const save = () => patch({ baseUrl: draft.baseUrl, model: draft.model.trim(), ...(draft.apiKey ? { apiKey: draft.apiKey } : {}) }, 'AI connection saved')
    .then(() => setDraft((d) => ({ ...d, apiKey: '' })))

  const loadModels = () => {
    setBusy(true)
    api.aiModels(draft.baseUrl, draft.apiKey || undefined)
      .then((list) => {
        setModels(list)
        toast.success(list.length ? `${list.length} ${list.length === 1 ? 'model reads' : 'models read'} images` : 'No models that read images were found')
      }, fail)
      .finally(() => setBusy(false))
  }

  const dirty = draft.baseUrl !== saved.baseUrl || draft.model.trim() !== saved.model || !!draft.apiKey
  const picked = models.find((m) => m.id === draft.model.trim())
  const host = (() => {
    try {
      return new URL(saved.baseUrl).host
    } catch {
      return saved.baseUrl
    }
  })()
  const run = async (action: () => Promise<unknown>) => {
    await action().catch(fail)
    // A run starts in the background; the next status shows it.
    setTimeout(() => void refresh(), 300)
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted-foreground">
        Sends the cover thumbnail of each scene (640 px, nothing else) to a model that can read images, and stores one sentence and a few
        tags it suggests. Search finds scenes by them. They never change grouping or your own tags.
      </p>

      <SwitchRow
        label="Describe and tag scenes with AI"
        hint="Off until you turn it on; nothing is sent while it is off"
        checked={saved.enabled}
        onCheckedChange={(enabled) => void patch({ enabled })}
      />

      <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void save() }}>
        <div className="flex flex-col gap-2">
          <TextField
            label="Address"
            value={draft.baseUrl}
            onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
            placeholder="https://openrouter.ai/api/v1"
            hint="Any OpenAI-compatible API. For LM Studio or Ollama, let it listen on the network and use your Mac's name or address."
          />
          <div className="flex flex-wrap gap-1">
            {PRESETS.map(([name, url]) => (
              <Button key={name} type="button" variant="ghost" size="sm" onClick={() => setDraft({ ...draft, baseUrl: url })}>{name}</Button>
            ))}
          </div>
        </div>
        <TextField
          label="API key"
          type="password"
          value={draft.apiKey}
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
          placeholder={saved.hasKey ? 'Saved; type to replace it' : 'Not needed for a local server'}
          hint={saved.hasKey && <button type="button" className="underline underline-offset-2" onClick={() => void patch({ apiKey: null }, 'Key removed')}>Remove the saved key</button>}
        />
        <div className="flex flex-col gap-2">
          <TextField
            label="Model"
            value={draft.model}
            list={listId}
            onChange={(e) => setDraft({ ...draft, model: e.target.value })}
            placeholder="e.g. qwen/qwen2.5-vl-72b-instruct"
            hint={picked?.perScene != null ? `About ${dollars(picked.perScene)} per scene` : 'It must be able to read images.'}
          />
          <datalist id={listId}>{models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</datalist>
          <div><Button type="button" variant="ghost" size="sm" disabled={busy || !draft.baseUrl} onClick={loadModels}>List models</Button></div>
        </div>
        <div><Button type="submit" disabled={busy || !dirty}>Save connection</Button></div>
      </form>

      <SwitchRow
        label="Describe new scenes after each scan"
        hint="Without this, runs start only from the button below, after you have seen the cost"
        checked={saved.auto}
        onCheckedChange={(auto) => void patch({ auto })}
      />

      {status && (
        <section aria-label="Descriptions" className="flex flex-col gap-3 rounded-lg bg-card p-4">
          <p className="text-sm">
            {status.described} {status.described === 1 ? 'scene' : 'scenes'} described · {status.waiting} waiting
          </p>
          <p className="text-xs text-muted-foreground">
            {status.leavesNetwork
              ? `Thumbnails are sent to ${host}. ${status.estimate === null ? 'This provider publishes no prices for the model.' : `Describing the waiting scenes costs about ${dollars(status.estimate)}.`}`
              : `Thumbnails stay on your network, at ${host}. Free to run.`}
          </p>
          {status.running && (
            <div className="flex flex-col gap-1">
              <Progress value={status.total ? (status.done / status.total) * 100 : 0} aria-label="Describing scenes" />
              <p className="text-xs text-muted-foreground">{status.done} of {status.total}</p>
            </div>
          )}
          {status.failed > 0 && !status.running && (
            <p className="text-xs text-muted-foreground">
              The model gave no usable answer for {status.failed} {status.failed === 1 ? 'scene' : 'scenes'}. Each is tried again on the next run, three times at most; a model made for describing images does better.
            </p>
          )}
          {status.error && <p role="alert" className="text-xs text-destructive">{status.error}. The remaining scenes stay waiting.</p>}
          <div className="flex flex-wrap gap-2">
            {status.running
              ? <Button variant="secondary" onClick={() => void run(api.stopAi)}>Stop</Button>
              : (
                <Button disabled={!saved.enabled || !saved.model || dirty || !status.waiting} onClick={() => void run(api.runAi)}>
                  Describe {status.waiting} {status.waiting === 1 ? 'scene' : 'scenes'}
                </Button>
              )}
            {status.described > 0 && !status.running && (
              <Button variant="ghost" onClick={() => {
                if (window.confirm('Forget every description and suggested tag? The next run describes all scenes again.')) void run(api.clearAi).then(onChanged)
              }}>Forget all descriptions</Button>
            )}
          </div>
          {!saved.enabled && <p className="text-xs text-muted-foreground">Turn it on above to describe scenes.</p>}
        </section>
      )}
    </div>
  )
}
