import { Fragment } from 'react'
import {
  Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbSeparator,
} from '@/components/ui/breadcrumb'
import { SEPARATOR } from '../../shared/tree.ts'
import { scopeHash, type Scope } from '../scope.ts'

/** Library › Creator › Project, optionally ending at a scene. The current page's own title follows it. */
export function Trail({ scope, scene, className }: { scope: Scope; scene?: { title: string; href: string }; className?: string }) {
  const crumbs = [{ label: 'Library', href: '#/' }]
  if (scope.creator) crumbs.push({ label: scope.creator, href: scopeHash({ creator: scope.creator }) })
  if (scope.project) {
    const parts = scope.project.split(SEPARATOR)
    parts.forEach((label, i) => crumbs.push({ label, href: scopeHash({ creator: scope.creator, project: parts.slice(0, i + 1).join(SEPARATOR) }) }))
  }
  if (scene) crumbs.push({ label: scene.title, href: scene.href })
  return (
    <Breadcrumb className={className}>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => (
          <Fragment key={crumb.href}>
            {i > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem className="min-w-0">
              <BreadcrumbLink href={crumb.href} className="block max-w-48 min-w-6 truncate leading-6">{crumb.label}</BreadcrumbLink>
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  )
}
