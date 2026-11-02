import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert } from 'lucide-react'
import type { Library as LibraryData, ScanStatus } from '../shared/types.ts'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ANNOUNCER_ID, announce } from './announce.ts'
import { api } from './api.ts'
import { buildIndex, DEFAULT_PREFS, NO_FILTERS, pageSpec, type Prefs } from './filters.ts'
import { Folders } from './Folders.tsx'
import { Library, LibrarySkeleton } from './Library.tsx'
import { Directory } from './library/Directory.tsx'
import { directory } from './profiles.ts'
import { routeScope, sceneScope, type Scope, scopeHash, scopeTitle } from './scope.ts'

// Only the library is needed to open the app; the rest loads the first time it is used.
const MapView = lazy(() => import('./MapView.tsx').then((m) => ({ default: m.MapView })))
const PrintStudio = lazy(() => import('./PrintStudio.tsx').then((m) => ({ default: m.PrintStudio })))
const Organize = lazy(() => import('./Organize.tsx').then((m) => ({ default: m.Organize })))
const Settings = lazy(() => import('./Settings.tsx').then((m) => ({ default: m.Settings })))

const PREFS_KEY = 'scenic.prefs'

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') }
  } catch {
    return DEFAULT_PREFS
  }
}

function useRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part)
    } catch {
      return part
    }
  })
  const [route, setRoute] = useState(read)
  useEffect(() => {
    const update = () => setRoute(read())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  return route
}

export function App() {
  const route = useRoute()
  const [library, setLibrary] = useState<LibraryData | null>(null)
  const [status, setStatus] = useState<ScanStatus | null>(null)
  const [error, setError] = useState('')
  const [folders, setFolders] = useState<'list' | 'pick' | null>(null)
  const [prefs, setPrefsState] = useState(loadPrefs)
  // Held here so filters survive drilling down, opening a map and printing.
  const [filters, setFilters] = useState(NO_FILTERS)
  const lastScope = useRef<Scope | null>(null)

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((current) => {
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
      } catch {
        // Private windows may refuse storage; the setting still applies for this visit.
      }
      return next
    })
  }, [])

  const refresh = useCallback(() => {
    api.library().then(
      (data) => {
        setLibrary(data)
        setError('')
      },
      (e: Error) => setError(e.message),
    )
  }, [])

  useEffect(refresh, [refresh])

  // Folder changes start or end a scan, so the status poll restarts rather than waiting out its timer.
  const pollNow = useRef(() => {})
  const foldersChanged = useCallback(() => {
    refresh()
    pollNow.current()
  }, [refresh])

  useEffect(() => {
    let stopped = false
    let timer: ReturnType<typeof setTimeout>
    let last = ''
    let scanning = false
    const poll = async () => {
      try {
        const next = await api.status()
        if (stopped) return
        setStatus(next)
        if (next.running !== scanning) {
          scanning = next.running
          announce(next.running ? 'Indexing started' : `Indexing finished, ${next.indexed} maps`)
        }
        const fingerprint = `${next.indexed}-${next.running}`
        if (fingerprint !== last) {
          if (last) refresh()
          last = fingerprint
        }
        timer = setTimeout(poll, next.running ? 1500 : 15000)
      } catch {
        if (!stopped) timer = setTimeout(poll, 5000)
      }
    }
    pollNow.current = () => {
      clearTimeout(timer)
      void poll()
    }
    void poll()
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [refresh])

  const spec = useMemo(() => pageSpec(prefs), [prefs])
  const index = useMemo(() => (library ? buildIndex(library, spec) : null), [library, spec])

  const [view, id] = route
  const map = id && index ? index.byId.get(Number(id)) : undefined

  // A map opens over the level it was reached from; a shared link opens over its own project.
  const group = map && library?.groups.find((g) => g.id === map.groupId)
  const scope = routeScope(route) ?? lastScope.current ?? (group ? sceneScope(group) : {})
  lastScope.current = scope

  const pageTitle = view === 'print' && group ? `Print ${group.title}`
    : view === 'map' && group ? [group.title, map?.variant].filter(Boolean).join(', ')
      : view === 'settings' ? `Settings, ${id === 'projects' ? 'Projects' : 'Creators'}`
        : view === 'organize' ? 'Organise'
          : view === 'creators' ? 'Creators'
            : view === 'projects' ? 'Projects'
              : scopeTitle(scope)
  const routeKey = route.join('/')
  const firstRoute = useRef(true)

  useEffect(() => {
    document.title = pageTitle ? `${pageTitle} · Scenic` : 'Scenic'
  }, [pageTitle])

  // A hash change repaints the page without the browser moving focus. Map view and the print canvas handle their own.
  useEffect(() => {
    if (firstRoute.current) {
      firstRoute.current = false
      return
    }
    if (route[0] === 'map' || route[0] === 'print') return
    // A page opened for the first time replaces the old one a moment later, taking focus with it,
    // so keep checking until focus has landed somewhere that stays.
    let tries = 30
    const timer = setInterval(() => {
      const lost = document.activeElement === document.body
      const heading = document.querySelector<HTMLElement>('h1')
      if (lost && heading) {
        heading.tabIndex = -1
        heading.focus({ preventScroll: true })
      }
      if (--tries === 0) clearInterval(timer)
    }, 50)
    document.querySelector<HTMLElement>(':focus')?.blur()
    return () => clearInterval(timer)
  }, [routeKey]) // eslint-disable-line react-hooks/exhaustive-deps

  let page: React.ReactNode
  if (!library || !index) {
    page = error ? (
      <Empty className="min-h-dvh" role="alert">
        <EmptyHeader>
          <EmptyMedia variant="icon"><CircleAlert /></EmptyMedia>
          <EmptyTitle className="text-xl">Scenic could not load your library</EmptyTitle>
          <EmptyDescription>{error}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    ) : <LibrarySkeleton />
  } else if (view === 'creators' || view === 'projects') {
    page = view === 'creators'
      ? <Directory title="Creators" entities={directory(library, index).creators} />
      : <Directory title="Projects" entities={directory(library, index).projects} />
  } else if (view === 'organize') {
    page = <Organize library={library} index={index} onChanged={refresh} />
  } else if (view === 'settings') {
    page = (
      <>
        <Settings library={library} index={index} tab={id === 'projects' ? 'projects' : 'creators'} prefs={prefs} setPrefs={setPrefs} onFolders={() => setFolders('list')} onChanged={refresh} />
        {folders && <Folders status={status} pick={folders === 'pick'} onClose={() => setFolders(null)} onChanged={foldersChanged} />}
      </>
    )
  } else if (view === 'print' && map) {
    page = <PrintStudio key={map.id} map={map} library={library} index={index} prefs={prefs} setPrefs={setPrefs} onChanged={refresh} />
  } else {
    page = (
      <>
        <Library library={library} index={index} scope={scope} filters={filters} setFilters={setFilters} prefs={prefs} setPrefs={setPrefs} status={status} onFolders={setFolders} onChanged={refresh} />
        {view === 'map' && map && <MapView key={map.groupId} map={map} library={library} index={index} prefs={prefs} backHash={scopeHash(scope)} onChanged={refresh} />}
        {folders && <Folders status={status} pick={folders === 'pick'} onClose={() => setFolders(null)} onChanged={foldersChanged} />}
      </>
    )
  }

  return (
    <TooltipProvider>
      <button
        type="button"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-popover focus:px-3 focus:py-2 focus:text-sm focus:shadow-lg"
        onClick={() => {
          const main = document.querySelector('main')
          if (!main) return
          main.tabIndex = -1
          main.focus()
        }}
      >
        Skip to content
      </button>
      <Suspense fallback={<LibrarySkeleton />}>{page}</Suspense>
      <Toaster position="top-center" />
      <p id={ANNOUNCER_ID} className="sr-only" aria-live="polite" />
    </TooltipProvider>
  )
}
