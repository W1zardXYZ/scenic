import { useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { toast } from 'sonner'
import type { Library, MapEdit, MapGroup, MapRecord, VariantKind } from '../shared/types.ts'
import { NumberField, SelectField, SwitchRow } from '@/components/controls'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api } from './api.ts'

const KINDS = [['level', 'Level'], ['lighting', 'Lighting'], ['weather', 'Weather'], ['labels', 'Labels'], ['other', 'Other']] as const
const STAY = 'stay'
const NEW_SCENE = 'new'

function TextField({ label, value, onChange, list, placeholder, error }: {
  label: string
  value: string
  onChange: (value: string) => void
  list?: string[]
  placeholder?: string
  error?: string
}) {
  const id = `edit-${label.toLowerCase().replace(/\W+/g, '-')}`
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        list={list && `${id}-list`}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      {list && <datalist id={`${id}-list`}>{list.map((v) => <option key={v} value={v} />)}</datalist>}
    </Field>
  )
}

export function EditDialog({ map, group, library, onClose, onChanged }: {
  map: MapRecord
  group: MapGroup
  library: Library
  onClose: () => void
  onChanged: () => void
}) {
  const unique = (values: string[]) => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b))
  const creators = useMemo(() => unique(library.groups.map((g) => g.creator)), [library])
  const projects = useMemo(() => unique(library.groups.map((g) => g.pack)), [library])
  const allTags = useMemo(() => unique(library.maps.flatMap((m) => m.biomes)), [library])
  const others = useMemo(() => library.groups.filter((g) => g.id !== group.id).sort((a, b) => a.title.localeCompare(b.title)), [library, group])

  const members = library.maps.filter((m) => m.groupId === group.id)
  const siblings = members.filter((m) => m.variant === map.variant)
  const edited = members.some((m) => m.edited)

  const [title, setTitle] = useState(group.title)
  const [creator, setCreator] = useState(group.creator)
  const [pack, setPack] = useState(group.pack)
  const [wholeProject, setWholeProject] = useState(false)
  const [tags, setTags] = useState(map.biomes)
  const [tagDraft, setTagDraft] = useState('')
  const [variant, setVariant] = useState(map.variant)
  const [kind, setKind] = useState<VariantKind>(map.variantKind)
  const [height, setHeight] = useState(0)
  const [move, setMove] = useState(STAY)
  const [newScene, setNewScene] = useState('')
  const [moveAll, setMoveAll] = useState(false)
  const [busy, setBusy] = useState(false)

  const addTag = () => {
    const tag = tagDraft.trim().replace(/,$/, '')
    if (tag && !tags.includes(tag)) setTags([...tags, tag])
    setTagDraft('')
  }

  const save = async () => {
    if (!title.trim()) return document.getElementById('edit-scene-name')?.focus()
    setBusy(true)
    try {
      const sceneIds = members.map((m) => m.id)
      const variantIds = siblings.map((m) => m.id)
      const placeChanged = creator !== group.creator || pack !== group.pack
      const projectIds = library.groups.filter((g) => g.creator === group.creator && g.pack === group.pack).flatMap((g) => g.mapIds)

      const patch: MapEdit = {}
      if (title.trim() !== group.title) patch.scene = title.trim()
      if (tags.join() !== map.biomes.join()) patch.tags = tags
      if (Object.keys(patch).length) await api.edit(sceneIds, patch)
      if (placeChanged) await api.edit(wholeProject ? projectIds : sceneIds, { creator: creator.trim(), pack: pack.trim() })

      const variantPatch: MapEdit = {}
      if (variant !== map.variant) variantPatch.variant = variant.trim()
      if (kind !== map.variantKind) variantPatch.kind = kind
      if (kind === 'level' && height !== 0) variantPatch.order = height
      if (Object.keys(variantPatch).length) await api.edit(variantIds, variantPatch)

      const moving = moveAll ? sceneIds : variantIds
      if (move === NEW_SCENE && newScene.trim()) {
        await api.edit(moving, { scene: newScene.trim() })
      } else if (move !== STAY && move !== NEW_SCENE) {
        const target = library.groups.find((g) => g.id === Number(move))!
        await api.edit(target.mapIds, { scene: target.title })
        await api.edit(moving, { scene: target.title, creator: target.creator, pack: target.pack })
      }
      onChanged()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    try {
      await api.edit(members.map((m) => m.id), { scene: null, variant: null, kind: null, order: null, creator: null, pack: null, tags: null })
      onChanged()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined} className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>Edit {group.title}</DialogTitle></DialogHeader>
        <div className="flex flex-col gap-7">
          <section className="flex flex-col gap-3">
            <TextField label="Scene name" value={title} onChange={setTitle} error={title.trim() ? '' : 'Enter a scene name'} />
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Creator" value={creator} onChange={setCreator} list={creators} />
              <TextField label="Project" value={pack} onChange={setPack} list={projects} />
            </div>
            {(creator !== group.creator || pack !== group.pack) && group.pack && (
              <SwitchRow label="Apply to every scene in this project" checked={wholeProject} onCheckedChange={setWholeProject} />
            )}
            <div className="flex flex-col gap-2">
              <TextField
                label="Tags"
                value={tagDraft}
                list={allTags.filter((t) => !tags.includes(t))}
                placeholder="Type a tag and press Add"
                onChange={(next) => (next.endsWith(',') ? (setTagDraft(next), setTimeout(addTag)) : setTagDraft(next))}
              />
              <div className="flex flex-wrap items-center gap-1.5">
                {tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="gap-1 pr-1">
                    {tag}
                    <button type="button" aria-label={`Remove ${tag}`} onClick={() => setTags(tags.filter((t) => t !== tag))}><X className="size-3" /></button>
                  </Badge>
                ))}
                {tagDraft.trim() && <Button variant="ghost" size="sm" onClick={addTag}>Add “{tagDraft.trim()}”</Button>}
              </div>
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">This variant</h3>
            <div className="grid grid-cols-2 gap-3">
              <TextField label="Name" value={variant} onChange={setVariant} placeholder="Standard" />
              <SelectField label="Type" value={kind} options={KINDS} onChange={(next) => setKind(next as VariantKind)} />
            </div>
            {kind === 'level' && <NumberField label="Height (0 is ground, −1 cellar, 1 upper)" value={height} step={1} onChange={setHeight} />}
            <SelectField
              label="Belongs to scene"
              value={move}
              options={[[STAY, group.title], [NEW_SCENE, 'New scene…'], ...others.map((g) => [String(g.id), g.title] as const)]}
              onChange={setMove}
            />
            {move === NEW_SCENE && <TextField label="New scene name" value={newScene} onChange={setNewScene} />}
            {move !== STAY && members.length > siblings.length && (
              <SwitchRow label="Move the whole scene" hint="Merges all its variants" checked={moveAll} onCheckedChange={setMoveAll} />
            )}
          </section>
        </div>
        <DialogFooter className="items-center sm:justify-between">
          {edited ? <Button variant="ghost" disabled={busy} onClick={reset}>Restore detected values</Button> : <span />}
          <div className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button disabled={busy} onClick={save}>Save</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
