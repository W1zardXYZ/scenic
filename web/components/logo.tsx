import { cn } from '@/lib/utils'

export function Logo({ className }: { className?: string }) {
  return (
    <a href="#/" aria-label="Scenic library" className={cn('flex shrink-0 items-center gap-3 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring', className)}>
      <svg viewBox="0 0 32 32" aria-hidden="true" className="size-7">
        <rect width="32" height="32" rx="7" className="fill-primary" />
        <path d="M4 24 13 10l6 9 3-4 6 9z" className="fill-primary-foreground" />
      </svg>
      <span className="hidden text-sm font-medium tracking-[0.3em] uppercase sm:block">Scenic</span>
    </a>
  )
}
