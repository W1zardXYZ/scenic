import { useId, useState } from 'react'
import { Pipette, type LucideIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldContent, FieldDescription, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Kbd } from '@/components/ui/kbd'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Toggle } from '@/components/ui/toggle'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** A tooltip around a single control, with an optional keyboard shortcut. */
export function Hint({ label, shortcut, side, children }: {
  label: string
  shortcut?: string
  side?: React.ComponentProps<typeof TooltipContent>['side']
  children: React.ReactElement
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}{shortcut && <Kbd>{shortcut}</Kbd>}</TooltipContent>
    </Tooltip>
  )
}

type IconButtonProps = Omit<React.ComponentProps<typeof Button>, 'size' | 'children' | 'asChild'> & {
  label: string
  icon: LucideIcon
  shortcut?: string
  side?: React.ComponentProps<typeof TooltipContent>['side']
  /** Renders a link instead of a button. */
  href?: string
}

export function IconButton({ label, icon: Icon, shortcut, side, href, variant = 'ghost', ...props }: IconButtonProps) {
  return (
    <Hint label={label} shortcut={shortcut} side={side}>
      <Button variant={variant} size="icon" aria-label={label} asChild={href !== undefined} {...props}>
        {href !== undefined ? <a href={href}><Icon /></a> : <Icon />}
      </Button>
    </Hint>
  )
}

export function IconToggle({ label, icon: Icon, className, ...props }: Omit<React.ComponentProps<typeof Toggle>, 'children'> & {
  label: string
  icon: LucideIcon
}) {
  return (
    <Hint label={label}>
      <Toggle aria-label={label} className={cn('p-0 on:bg-transparent on:text-primary', className)} {...props}>
        <Icon />
      </Toggle>
    </Hint>
  )
}

/** A single choice from a few options, as a filled track. */
export function Segmented<T extends string>({ label, value, options, onChange, className }: {
  label: string
  value: T | ''
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  className?: string
}) {
  return (
    <ToggleGroup
      type="single"
      spacing={0.5}
      aria-label={label}
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      className={cn('w-full bg-input p-0.5', className)}
    >
      {options.map(([option, text]) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className="h-[calc(var(--control)-0.25rem)] min-w-0 flex-1 px-2 font-normal text-muted-foreground hover:bg-transparent on:bg-accent on:text-foreground"
        >
          {text}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

/** A titled block of controls inside a panel. */
export function PanelGroup({ title, aside, children }: { title?: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      {title && (
        <header className="flex items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{title}</h2>
          {aside}
        </header>
      )}
      {children}
    </section>
  )
}

const FIELD_LABEL = 'text-xs font-normal text-muted-foreground'

export function SwitchRow({ label, hint, icon: Icon, checked, onCheckedChange }: {
  label: string
  hint?: string
  icon?: LucideIcon
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}) {
  const id = useId()
  return (
    <Field orientation="horizontal" className="items-center justify-between gap-4">
      <FieldContent>
        <FieldLabel htmlFor={id} className="items-center font-normal [&>svg]:size-4 [&>svg]:text-muted-foreground">
          {Icon && <Icon />}{label}
        </FieldLabel>
        {hint && <FieldDescription className="text-xs">{hint}</FieldDescription>}
      </FieldContent>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </Field>
  )
}

export function NumberField({ label, value, onChange, step = 1, min, max, suffix, className }: {
  label: string
  value: number
  onChange: (value: number) => void
  step?: number
  min?: number
  max?: number
  suffix?: string
  className?: string
}) {
  const id = useId()
  const [draft, setDraft] = useState<string | null>(null)
  return (
    <Field className={cn('min-w-0 gap-1.5', className)}>
      <FieldLabel htmlFor={id} className={FIELD_LABEL}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          inputMode="decimal"
          step={step}
          min={min}
          max={max}
          value={draft ?? String(Number(value.toFixed(3)))}
          onChange={(e) => {
            setDraft(e.target.value)
            const n = Number(e.target.value)
            if (e.target.value !== '' && Number.isFinite(n) && (min === undefined || n >= min)) onChange(n)
          }}
          onBlur={() => setDraft(null)}
        />
        {suffix && <InputGroupAddon align="inline-end" className="font-normal">{suffix}</InputGroupAddon>}
      </InputGroup>
    </Field>
  )
}

const IN = 25.4

export function LengthField({ label, mm, onChange, units, min = 0 }: {
  label: string
  mm: number
  onChange: (mm: number) => void
  units: 'metric' | 'imperial'
  min?: number
}) {
  return units === 'metric'
    ? <NumberField label={label} value={mm} onChange={onChange} step={0.5} min={min} suffix="mm" />
    : <NumberField label={label} value={mm / IN} onChange={(v) => onChange(v * IN)} step={0.05} min={min / IN} suffix="in" />
}

export function SelectField<T extends string>({ label, value, options, onChange, className }: {
  label: string
  value: T
  options: readonly (readonly [T, string])[]
  onChange: (value: T) => void
  className?: string
}) {
  const id = useId()
  return (
    <Field className={cn('min-w-0 gap-1.5', className)}>
      <FieldLabel htmlFor={id} className={FIELD_LABEL}>{label}</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as T)}>
        <SelectTrigger id={id} className="w-full"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">
          <SelectGroup>
            {options.map(([option, text]) => <SelectItem key={option} value={option}>{text}</SelectItem>)}
          </SelectGroup>
        </SelectContent>
      </Select>
    </Field>
  )
}

export function SliderField({ label, value, display, onChange, min, max, step }: {
  label: string
  value: number
  display?: string
  onChange: (value: number) => void
  min: number
  max: number
  step: number
}) {
  return (
    <Field className="gap-2.5">
      <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{label}</span>
        <output className="tabular-nums">{display ?? value}</output>
      </div>
      <Slider aria-label={label} aria-valuetext={display} min={min} max={max} step={step} value={[value]} onValueChange={([next]) => onChange(next)} />
    </Field>
  )
}

const SWATCH = 'size-7 rounded-full ring-1 ring-foreground/15'

/** Round colour picks plus a custom well. */
export function ColorChoice({ label, value, options, onChange }: {
  label: string
  value: string
  options: readonly string[]
  onChange: (color: string) => void
}) {
  return (
    <div className="flex items-center gap-3">
      <ToggleGroup type="single" spacing={3} aria-label={label} value={value} onValueChange={(next) => next && onChange(next)}>
        {options.map((color) => (
          <ToggleGroupItem
            key={color}
            value={color}
            aria-label={color}
            style={{ backgroundColor: color }}
            className={cn(SWATCH, 'h-7 min-w-7 p-0 on:ring-2 on:ring-primary on:ring-offset-2 on:ring-offset-card')}
          />
        ))}
      </ToggleGroup>
      <ColorWell label={`Custom ${label.toLowerCase()}`} value={value} onChange={onChange} />
    </div>
  )
}

export function ColorWell({ label, value, onChange }: { label: string; value: string; onChange: (color: string) => void }) {
  return (
    <label className={cn(SWATCH, 'relative grid cursor-pointer place-items-center bg-input text-muted-foreground has-focus-visible:ring-3 has-focus-visible:ring-ring')} title={label}>
      <Pipette className="size-3.5" aria-hidden="true" />
      <input type="color" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="absolute inset-0 size-full cursor-pointer opacity-0" />
    </label>
  )
}

const GRADES: Record<string, React.ComponentProps<typeof Badge>['variant']> = {
  Excellent: 'success', Good: 'success', Fair: 'warning', Low: 'destructive',
}

export function GradeBadge({ grade }: { grade: string }) {
  return <Badge variant={GRADES[grade]}>{grade}</Badge>
}
