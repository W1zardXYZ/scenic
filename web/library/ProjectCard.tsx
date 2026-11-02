import { memo } from 'react'
import { thumb } from '../api.ts'
import type { GroupView } from '../filters.ts'
import { cn } from '@/lib/utils'

/** The tile layouts for 2, 3 and 4 covers; the first cover leads when there are three. */
const COLLAGE: Record<number, string> = { 2: 'grid-cols-2', 3: 'grid-cols-2 grid-rows-2', 4: 'grid-cols-2 grid-rows-2' }

export const ProjectCard = memo(function ProjectCard({ title, creator, href, scenes }: {
  title: string
  creator: string
  href: string
  scenes: GroupView[]
}) {
  const covers = scenes.slice(0, 4)
  return (
    <a
      href={href}
      className="group/card block min-w-0 rounded-lg outline-none [contain-intrinsic-size:auto_16rem] [content-visibility:auto] focus-visible:ring-3 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-background"
    >
      <div className={cn('grid aspect-4/3 gap-0.5 overflow-hidden rounded-lg', COLLAGE[covers.length])}>
        {covers.map(({ pick }, i) => (
          <div key={pick.id} style={{ backgroundColor: pick.color }} className={cn('min-h-0 min-w-0 overflow-hidden', covers.length === 3 && i === 0 && 'row-span-2')}>
            <img
              src={thumb(pick, 'small')}
              alt=""
              loading="lazy"
              decoding="async"
              className="size-full object-cover transition-transform duration-300 ease-out group-hover/card:scale-[1.03]"
            />
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-baseline justify-between gap-3">
        <h2 className="truncate text-sm font-medium transition-colors group-hover/card:text-primary">{title}</h2>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{scenes.length} scenes</span>
      </div>
      {creator && <p className="truncate text-xs text-muted-foreground">{creator}</p>}
    </a>
  )
})
