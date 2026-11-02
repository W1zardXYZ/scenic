import { memo } from 'react'
import { Compass } from 'lucide-react'
import { colorFade, type Entity, inkOn } from '../profiles.ts'
import { cn } from '@/lib/utils'

const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

export function Avatar({ entity, className }: { entity: Entity; className?: string }) {
  return (
    <span
      className={cn('flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-black/30 font-medium text-white ring-2 ring-white/25', className)}
      aria-hidden="true"
    >
      {entity.avatar ? <img src={entity.avatar} alt="" className="size-full object-cover" /> : initials(entity.name)}
    </span>
  )
}

/** The picture shows at full strength up top and melts into the entity's colour by 65% of the height. */
function CardArt({ entity }: { entity: Entity }) {
  return (
    <>
      {entity.banner && (
        <img
          src={entity.banner}
          alt=""
          loading="lazy"
          decoding="async"
          className="absolute inset-0 -z-10 size-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.03]"
        />
      )}
      <span className="absolute inset-0 -z-10" style={{ background: colorFade(entity.color) }} />
    </>
  )
}

const CARD = 'group/card relative isolate flex aspect-16/9 min-w-0 items-end gap-2 overflow-hidden rounded-lg p-3 outline-none focus-visible:ring-3 focus-visible:ring-ring'

export const CreatorCard = memo(function CreatorCard({ entity, href }: { entity: Entity; href: string }) {
  return (
    <a href={href} style={{ backgroundColor: entity.color, color: inkOn(entity.color) }} className={CARD}>
      <CardArt entity={entity} />
      <Avatar entity={entity} className="size-9 text-xs" />
      <span className="min-w-0 truncate text-sm font-medium">{entity.name}</span>
    </a>
  )
})

export const ProjectBanner = memo(function ProjectBanner({ entity, href }: { entity: Entity; href: string }) {
  return (
    <a href={href} style={{ backgroundColor: entity.color, color: inkOn(entity.color) }} className={CARD}>
      <CardArt entity={entity} />
      {entity.adventure && <Compass aria-label="Adventure" className="size-4 shrink-0" />}
      <span className="min-w-0 truncate text-sm font-medium">{entity.name}</span>
    </a>
  )
})
