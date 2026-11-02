import { memo, useRef, useState } from 'react'
import { Heart, Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { thumb } from '../api.ts'
import type { GroupView } from '../filters.ts'
import { cn } from '@/lib/utils'

const OVERLAY = 'bg-background/80 text-foreground'

function Card({ view }: { view: GroupView }) {
  const { group, pick, facts, variants } = view
  const [scrub, setScrub] = useState<number | null>(null)
  const art = useRef<HTMLDivElement>(null)
  const shown = scrub === null ? pick : variants[scrub]
  const many = variants.length > 1

  const move = (x: number) => {
    const box = art.current!.getBoundingClientRect()
    setScrub(Math.min(variants.length - 1, Math.max(0, Math.floor(((x - box.left) / box.width) * variants.length))))
  }

  return (
    <a
      href={`#/map/${pick.id}`}
      aria-label={`${group.title}${variants.length > 1 ? `, ${variants.length} variants` : ''}, ${Math.round(facts.cols)} by ${Math.round(facts.rows)} squares`}
      className="group/card block min-w-0 rounded-lg outline-none [contain-intrinsic-size:auto_16rem] [content-visibility:auto] focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <div
        ref={art}
        style={{ backgroundColor: pick.color }}
        className="relative isolate aspect-4/3 overflow-hidden rounded-lg outline-1 -outline-offset-1 outline-white/10"
        onMouseMove={many ? (e) => move(e.clientX) : undefined}
        onMouseLeave={() => setScrub(null)}
      >
        <img
          src={thumb(shown, 'small')}
          alt=""
          loading="lazy"
          decoding="async"
          className="size-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.03]"
        />
        {pick.favorite && (
          <Heart className="absolute top-3 left-3 size-4 fill-primary text-primary" aria-label="Favourite" />
        )}
        {many && (
          <>
            {scrub === null ? (
              <Badge className={cn('absolute right-2 bottom-2 tabular-nums', OVERLAY)}>
                <Layers data-icon="inline-start" aria-hidden="true" />
                {variants.length}<span className="sr-only"> variants</span>
              </Badge>
            ) : (
              <Badge className={cn('absolute bottom-4 left-2 max-w-[calc(100%-1rem)]', OVERLAY)}>
                <span className="truncate">{shown.variant || 'Standard'}</span>
              </Badge>
            )}
            <span aria-hidden="true" className="absolute inset-x-2 bottom-2 flex gap-0.5 opacity-0 transition-opacity group-hover/card:opacity-100">
              {variants.map((v, i) => (
                <i key={v.id} className={cn('h-0.5 flex-1 rounded-full bg-white/40', i === scrub && 'bg-primary')} />
              ))}
            </span>
          </>
        )}
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <h2 className="truncate text-sm font-medium transition-colors group-hover/card:text-primary">{group.title}</h2>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {Math.round(facts.cols)} × {Math.round(facts.rows)}
        </span>
      </div>
    </a>
  )
}

// applyFilters builds fresh views on every keystroke; the card only depends on these.
export const MapCard = memo(Card, (a, b) =>
  a.view.pick === b.view.pick && a.view.group === b.view.group && a.view.facts === b.view.facts && a.view.variants.length === b.view.variants.length)
