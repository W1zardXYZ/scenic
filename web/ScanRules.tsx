import { useEffect, useId, useState } from 'react'
import { toast } from 'sonner'
import { DEFAULT_RULES, parseRuleText, RULE_LISTS, type ScanRules } from '../shared/rules.ts'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { api } from './api.ts'

const LISTS: { key: keyof ScanRules; label: string; hint: string }[] = [
  { key: 'skipFolders', label: 'Skip folders', hint: 'A folder whose whole name matches is not scanned. Use * for any text, e.g. * monster.' },
  { key: 'skipFiles', label: 'Skip files', hint: 'A file whose name contains one of these words is not scanned. Plurals match too.' },
  { key: 'include', label: 'Always include', hint: 'Words in a folder or file name that keep it even when a skip rule matches.' },
  { key: 'gridded', label: 'Words that mean gridded', hint: 'Added to the built-in ones such as "grid" and "gridded".' },
  { key: 'gridless', label: 'Words that mean gridless', hint: 'Added to "no grid", "gridless", "ng" and similar.' },
  { key: 'labelled', label: 'Words that mean labelled', hint: 'Added to "labelled", "keyed" and "numbered".' },
  { key: 'unlabelled', label: 'Words that mean unlabelled', hint: 'Added to "unlabelled", "no labels" and similar.' },
  { key: 'overlays', label: 'Overlay folders and files', hint: 'Pieces laid over a map, such as an opened roof. They join the scene of the map their name continues, whatever their size.' },
  { key: 'variants', label: 'Variant words', hint: 'Files whose names differ only by these group into one scene, like day and night.' },
]

type Draft = Record<keyof ScanRules, string>

const toDraft = (rules: ScanRules) => Object.fromEntries(RULE_LISTS.map((k) => [k, rules[k].join(', ')])) as Draft

function RuleField({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (v: string) => void }) {
  const id = useId()
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={2} spellCheck={false} />
      <FieldDescription className="text-xs">{hint}</FieldDescription>
    </Field>
  )
}

/** Edits the scan rules; saving rescans names only, so it takes seconds and never re-decodes maps. */
export function ScanRulesForm() {
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.rules().then((r) => setDraft(toDraft(r)), (e: Error) => toast.error(e.message))
  }, [])

  if (!draft) return <p className="text-sm text-muted-foreground">Loading scan rules…</p>

  const save = async () => {
    setBusy(true)
    try {
      const rules = Object.fromEntries(RULE_LISTS.map((k) => [k, parseRuleText(draft[k])])) as unknown as ScanRules
      setDraft(toDraft(await api.saveRules(rules)))
      toast.success('Scan rules saved. Rescanning the library.')
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={(e) => { e.preventDefault(); void save() }}>
      <p className="text-sm text-muted-foreground">Separate words with commas or new lines. Files a rule removes keep their edits, so undoing the rule brings them back as they were.</p>
      {LISTS.map(({ key, label, hint }) => (
        <RuleField key={key} label={label} hint={hint} value={draft[key]} onChange={(v) => setDraft({ ...draft, [key]: v })} />
      ))}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy}>Save and rescan</Button>
        <Button type="button" variant="ghost" disabled={busy} onClick={() => setDraft(toDraft(DEFAULT_RULES))}>Reset to defaults</Button>
      </div>
    </form>
  )
}
