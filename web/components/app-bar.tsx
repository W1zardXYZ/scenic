import { cn } from '@/lib/utils'

/** The one top bar: fixed height, shared gutters. Library and print studio both sit on it. */
export function AppBar({ className, ...props }: React.ComponentProps<'header'>) {
  return <header className={cn('flex h-(--bar) shrink-0 items-center gap-3 px-(--gutter)', className)} {...props} />
}
