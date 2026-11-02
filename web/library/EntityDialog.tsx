import { useRef, useState } from 'react'
import { ImagePlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { SwitchRow } from '@/components/controls'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { api, profileImage } from '../api.ts'
import { convertEntity, dissolveEntity, type Entity, linkProblem, saveEntity } from '../profiles.ts'
import { parentScope, scopeHash } from '../scope.ts'

const fieldId = (label: string) => `entity-${label.toLowerCase().replace(/\W+/g, '-')}`

function Text({ label, value, onChange, onBlur, placeholder, list, type, error }: {
  label: string
  value: string
  onChange: (v: string) => void
  onBlur?: () => void
  placeholder?: string
  list?: string[]
  type?: string
  error?: string
}) {
  const id = fieldId(label)
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        list={list && `${id}-list`}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
      {list && <datalist id={`${id}-list`}>{list.map((v) => <option key={v} value={v} />)}</datalist>}
    </Field>
  )
}

function ImagePick({ label, id, onPick, onClear }: { label: string; id: string; onPick: (file: File) => void; onClear: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-12 shrink-0 rounded-md bg-input bg-cover bg-center"
        style={id ? { backgroundImage: `url(${profileImage(id)})` } : undefined}
      />
      <span className="flex-1 text-sm">{label}</span>
      <input
        ref={input}
        type="file"
        accept="image/*"
        aria-label={`Upload ${label}`}
        className="sr-only"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) onPick(file)
          e.target.value = ''
        }}
      />
      <Button variant="secondary" size="sm" onClick={() => input.current?.click()}><ImagePlus data-icon="inline-start" />Upload</Button>
      {id && <Button variant="ghost" size="icon" aria-label={`Remove ${label}`} onClick={onClear}><Trash2 /></Button>}
    </div>
  )
}

export function EntityDialog({ entity, creators, onClose, onChanged }: {
  entity: Entity
  creators: string[]
  onClose: () => void
  onChanged: () => void
}) {
  const { profile, kind } = entity
  const [name, setName] = useState(entity.name)
  const [creator, setCreator] = useState(entity.creator)
  const [site, setSite] = useState(profile.site ?? '')
  const [patreon, setPatreon] = useState(profile.patreon ?? '')
  const [avatar, setAvatar] = useState({ id: profile.avatar ?? '', color: profile.avatarColor ?? '' })
  const [banner, setBanner] = useState({ id: profile.banner ?? '', color: profile.bannerColor ?? '' })
  const [color, setColor] = useState(profile.color ?? '')
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState<'convert' | 'dissolve' | null>(null)
  const [adventure, setAdventure] = useState(entity.adventure)
  const [touched, setTouched] = useState<ReadonlySet<string>>(() => new Set())

  const problems: Record<string, string> = {
    Name: name.trim() ? '' : 'Enter a name',
    ...(kind === 'creator' && { Website: linkProblem(site), Patreon: linkProblem(patreon) }),
  }
  const problem = (field: string) => (touched.has(field) ? problems[field] : '')
  const touch = (field: string) => () => setTouched((t) => new Set(t).add(field))

  const upload = (apply: (image: { id: string; color: string }) => void) => (file: File) => {
    setBusy(true)
    api.uploadImage(file).then(apply, (e: Error) => void toast.error(e.message)).finally(() => setBusy(false))
  }

  const save = async () => {
    const first = Object.keys(problems).find((field) => problems[field])
    if (first) {
      setTouched(new Set(Object.keys(problems)))
      document.getElementById(fieldId(first))?.focus()
      return
    }
    setBusy(true)
    try {
      const after = await saveEntity(entity, name, creator, {
        site: site.trim(), patreon: patreon.trim(), color, type: adventure ? 'adventure' : '',
        avatar: avatar.id, avatarColor: avatar.color, banner: banner.id, bannerColor: banner.color,
      })
      // The page being viewed may have just changed its address.
      const before = kind === 'creator' ? { creator: entity.name } : { creator: entity.creator, project: entity.path }
      if (window.location.hash === scopeHash(before)) window.location.hash = scopeHash(after)
      onChanged()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const convert = async () => {
    setBusy(true)
    try {
      const here = window.location.hash === scopeHash({ creator: entity.creator, project: entity.path })
      await (confirming === 'dissolve' ? dissolveEntity(entity) : convertEntity(entity))
      if (kind === 'project' && here) {
        window.location.hash = confirming === 'dissolve' ? scopeHash(parentScope({ creator: entity.creator, project: entity.path })) : scopeHash({ creator: entity.name })
      }
      onChanged()
      onClose()
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  const person = kind === 'creator' && !entity.collection
  const subProjects = new Set(entity.scenes.map((g) => g.pack.split('/')[0]).filter(Boolean)).size
  const target = kind === 'project' || entity.collection ? 'creator' : 'project'
  const warning = person
    ? `${entity.name} leaves the Creators row and shows under Projects.${subProjects ? ` Its ${subProjects} projects become sub-projects.` : ''} Its links and images stay.`
    : entity.collection
      ? `${entity.name} moves back to the Creators row and its sub-projects become normal projects.`
      : `${entity.scenes.length} ${entity.scenes.length === 1 ? 'scene' : 'scenes'} move directly under a new creator called ${entity.name}${entity.creator ? `, leaving ${entity.creator}` : ''}.`

  const message = confirming === 'dissolve'
    ? `The ${entity.name} level is removed and everything in it moves up one level. Its name, banner and colour are lost.`
    : `${warning} You can change it back here.`

  const merging = kind === 'creator' && name.trim() !== entity.name && creators.includes(name.trim())
  const auto = banner.color || avatar.color || entity.cover?.color || '#3a3632'

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit {entity.name}</DialogTitle>
          <DialogDescription>{entity.scenes.length} {entity.scenes.length === 1 ? 'scene' : 'scenes'}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Text label="Name" value={name} onChange={setName} onBlur={touch('Name')} error={problem('Name')} />
          {merging && <p className="text-xs text-muted-foreground">This merges into the existing {name.trim()}.</p>}
          {kind === 'project' && <Text label="Creator" value={creator} onChange={setCreator} list={creators} />}
          {kind === 'creator' && (
            <>
              <Text label="Website" type="url" value={site} onChange={setSite} onBlur={touch('Website')} error={problem('Website')} placeholder="https://" />
              <Text label="Patreon" type="url" value={patreon} onChange={setPatreon} onBlur={touch('Patreon')} error={problem('Patreon')} placeholder="https://patreon.com/" />
              <ImagePick
                label="Profile picture"
                id={avatar.id}
                onPick={upload(setAvatar)}
                onClear={() => setAvatar({ id: '', color: '' })}
              />
            </>
          )}
          {(kind === 'project' || entity.collection) && (
            <SwitchRow label="This is an adventure" hint="Groups the maps of one adventure, shown first under Projects" checked={adventure} onCheckedChange={setAdventure} />
          )}
          <ImagePick label="Banner" id={banner.id} onPick={upload(setBanner)} onClear={() => setBanner({ id: '', color: '' })} />
          <div className="flex items-center gap-3">
            <span className="flex-1 text-sm">Colour</span>
            <input
              type="color"
              aria-label="Box colour"
              value={color || auto}
              onChange={(e) => setColor(e.target.value)}
              className="size-8 cursor-pointer rounded-md bg-transparent"
            />
            <Button variant="ghost" size="sm" disabled={!color} onClick={() => setColor('')}>{color ? 'Use automatic' : 'Automatic'}</Button>
          </div>
        </div>
        {confirming ? (
          <div role="alert" className="flex flex-col gap-3 rounded-md bg-muted p-3 text-sm">
            <p>{message}</p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirming(null)}>Keep as is</Button>
              <Button variant="destructive" size="sm" disabled={busy} onClick={convert}>{confirming === 'dissolve' ? 'Remove level' : `Make it a ${target}`}</Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap gap-1">
            <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirming('convert')}>Make this a {target}…</Button>
            {kind === 'project' && <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={() => setConfirming('dissolve')}>Remove this level…</Button>}
          </div>
        )}
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
