// The `<title>` / `<meta name="description">` of whatever route is showing, at runtime.
//
// Same problem and same shape as canonical.ts, and mounted in the same place — once, in AppRouter,
// beside useCanonical. vercel.json serves one shell for every path, so the tags baked into that
// file are true of the homepage and of nothing else. The build now writes a per-route file for the
// routes in ROUTE_META (scripts/prerender.tsx), which covers the crawler and the cold load; this
// hook covers the OTHER arrival, a visitor who clicked a link and whose document is whichever file
// they happened to land on first.
//
// FALLING BACK TO THE SERVED DOCUMENT'S OWN TAGS is the part that is easy to leave out and wrong
// to. Nothing else in the app sets a title, so a route with no entry of its own must be given the
// shell's back — otherwise a visitor who reads /pricing and then opens a shop is looking at a tab
// that still says "Pricing", and their history and any bookmark record it that way too.

import { useEffect } from 'react'
import { ROUTE_META, type RouteMeta } from './routeMeta'

/** The tags as the served document had them, captured before this hook first overwrites them. */
let shellMeta: RouteMeta | null = null

/**
 * A title a SCREEN set at runtime — a shop's storefront, the dashboard — for a route ROUTE_META
 * cannot know at build time. Module state rather than context because the two hooks below sit
 * at different depths of the tree and run in child-then-parent order: the screen's effect writes
 * this, then the router's effect (which fires after it on the same commit) reads it. Cleared by
 * the screen's own cleanup, which runs before the next route's effects.
 */
let dynamicMeta: RouteMeta | null = null

function captureShellMeta(): RouteMeta {
  shellMeta ??= { title: document.title, description: descriptionTag().content }
  return shellMeta
}

function apply(meta: RouteMeta): void {
  document.title = meta.title
  descriptionTag().content = meta.description
}

function descriptionTag(): HTMLMetaElement {
  let tag = document.head.querySelector<HTMLMetaElement>('meta[name="description"]')
  if (!tag) {
    tag = document.createElement('meta')
    tag.name = 'description'
    document.head.appendChild(tag)
  }
  return tag
}

/**
 * Keeps the document's title and description matching the route being shown.
 *
 * The fallback is the SERVED document's own tags, snapshotted on first run, not ROUTE_META['/'] —
 * because the file this tab was served may be `pricing.html`, where restoring the homepage's tags
 * would be a different wrong answer rather than the absence of one.
 */
export function useDocumentMeta(pathname: string): void {
  useEffect(() => {
    const shell = captureShellMeta()
    apply(ROUTE_META[pathname] ?? dynamicMeta ?? shell)
  }, [pathname])
}

/**
 * Titles the tab after something only the running screen knows — the shop's name on its
 * storefront, the shop and section on its dashboard. WCAG 2.4.2: every storefront and the whole
 * dashboard used to carry the marketing homepage's title, so a customer with three shops open
 * had three identical tabs, and a screen reader announced "Start Your Own Food Shop" on a page
 * for ordering a cake. `null` while the screen has nothing to say (the shop row still loading)
 * leaves whatever title is showing alone. The description stays the served document's: there is
 * no per-shop description to bake, and a wrong one is worse than a generic one.
 */
export function useDynamicDocumentTitle(title: string | null): void {
  useEffect(() => {
    if (!title) return
    dynamicMeta = { title, description: captureShellMeta().description }
    apply(dynamicMeta)
    return () => { dynamicMeta = null }
  }, [title])
}
