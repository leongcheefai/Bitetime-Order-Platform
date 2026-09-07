// The shell both legal documents render in: nav, title, date, prose, footer. Content lives in
// documents.ts, so a wording change never touches this file and a layout change never touches
// the wording.
import { useEffect } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { useSession } from '../SessionContext'
import Wordmark from '../components/Wordmark'
import type { LegalDocument } from './documents'
import { REFUNDS_ANCHOR } from './anchors'
import { draftCaveats } from './draftNotice'
import { splitOnEmails } from './linkify'

export default function LegalPage({ doc }: { doc: LegalDocument }) {
  const { t } = useSession()
  const { pathname, hash } = useLocation()
  const caveats = draftCaveats()

  // Where this page starts, which is NOT a detail the browser gets right on its own.
  //
  // With a fragment: land on that section. The footer links the refund policy directly, and
  // React Router renders only after the browser has already tried and failed to resolve the
  // fragment against a page that did not exist yet, so the scroll has to be redone here.
  //
  // WITHOUT one: go to the top. A single-page app does not reset the scroll on navigation, and
  // every link into these documents lives in a FOOTER — so the reader is by definition scrolled
  // to the bottom of wherever they came from, and arrives halfway down the terms with no idea
  // they are in the middle of a document.
  //
  // `instant` throughout, NOT `auto`. `auto` does not mean "immediately", it means "defer to the
  // CSS", and `index.css` sets `html { scroll-behavior: smooth }`. That made this silently
  // dependent on a smooth animation, which never completes in a backgrounded tab and would make
  // a reader following a link watch the whole document fly past instead of simply being there.
  // Keyed on the LOCATION, not on the document: following "Refunds" from the Terms page itself
  // changes only the fragment, so `doc` stays the same object and an effect watching it would
  // never re-run — the link would do nothing at all from the one page it is most likely to be
  // clicked on.
  useEffect(() => {
    const id = hash.slice(1)
    const target = id ? document.getElementById(id) : null
    if (target) target.scrollIntoView({ behavior: 'instant', block: 'start' })
    else window.scrollTo({ top: 0, behavior: 'instant' })
  }, [pathname, hash])

  return (
    <div className="mm-land flex flex-col min-h-dvh bg-background text-foreground font-sans">
      <nav className="flex items-center justify-between px-8 py-5 border-b border-border max-[600px]:px-5 max-[600px]:py-4">
        <Link to="/" aria-label={t('TinyOrder home', 'TinyOrder 首页')}>
          <Wordmark className="h-7 max-[600px]:h-6" />
        </Link>
        <Link to="/" className="text-[13px] text-muted-foreground hover:text-primary underline underline-offset-4">
          {t('Back to home', '返回首页')}
        </Link>
      </nav>

      {/* Measure, not width: at the 16px body floor this holds running copy near the 65–75ch
          DESIGN.md asks for. A wider column would be a longer line, not a better page. */}
      <main className="flex-1 w-full max-w-[620px] mx-auto px-8 py-12 max-[600px]:px-5 max-[600px]:py-8">
        <h1 className="font-heading text-[26px] leading-tight text-primary mb-1.5 max-[600px]:text-[22px]">
          {doc.title}
        </h1>
        <p className="text-[13px] text-muted-foreground mb-10">
          {t('Last updated', '最后更新')} {doc.lastUpdated}
        </p>

        {/* The page should look unfinished while it IS unfinished — but it must say WHY, and the
            reasons are independent. Listing them separately is what stops this notice drifting
            out of step with the document: it once told the reader to look for square brackets
            that, once the unregistered wording landed, appeared nowhere on the page. Each caveat
            disappears on its own when the thing it describes is actually done. */}
        {caveats.length > 0 && (
          <div
            role="note"
            className="mb-10 rounded-xl border-[0.5px] border-dashed border-border bg-brand-100 px-4 py-3 text-sm leading-[1.6] text-muted-foreground"
          >
            <p>
              <strong className="text-primary">{t('Draft.', '草稿。')}</strong>{' '}
              {t('This document is not final:', '本文件尚未定稿：')}
            </p>
            <ul className="mt-1.5 list-disc pl-5">
              {caveats.map(c => <li key={c.id}>{t(c.en, c.zh)}</li>)}
            </ul>
          </div>
        )}

        {doc.sections.map(section => (
          <section key={section.id} id={section.id} className="mb-8 scroll-mt-24">
            <h2 className="font-heading text-[18px] text-foreground mb-2.5">{section.heading}</h2>
            {section.body.map((para, i) => (
              // Keyed by index: paragraphs are a fixed ordered list with no identity of their
              // own, and nothing reorders them. Same for the runs within one — they are a
              // rendering of that paragraph's own text, not items with lives of their own.
              <p key={i} className="text-sm leading-[1.7] text-muted-foreground mb-2.5 last:mb-0">
                {splitOnEmails(para).map((run, j) =>
                  run.type === 'email' ? (
                    <a
                      key={j}
                      href={`mailto:${run.value}`}
                      className="text-primary underline underline-offset-2 break-words"
                    >
                      {run.value}
                    </a>
                  ) : (
                    <span key={j}>{run.value}</span>
                  ),
                )}
              </p>
            ))}
          </section>
        ))}
      </main>

      <footer className="mt-auto px-8 py-6 border-t border-border flex items-center justify-center gap-3 text-[13px] text-muted-foreground">
        <Wordmark className="h-[18px]" />
        {/* Decorative separator: aria-hidden so a screen reader is not read a bullet between two
            links, and NOT set in clay-border — DESIGN.md keeps that colour for strokes because it
            fails AA on cream at 1.98:1. */}
        <span aria-hidden="true">·</span>
        {/* The same three as the marketing footer, and for the same reason: a reader who landed
            on the Privacy Policy must be able to reach the refund policy without going back to
            the home page to find the link. */}
        <Link to="/terms" className="hover:text-primary underline underline-offset-4">
          {t('Terms', '服务条款')}
        </Link>
        <Link to={`/terms#${REFUNDS_ANCHOR}`} className="hover:text-primary underline underline-offset-4">
          {t('Refunds', '退款政策')}
        </Link>
        <Link to="/privacy" className="hover:text-primary underline underline-offset-4">
          {t('Privacy', '隐私政策')}
        </Link>
      </footer>
    </div>
  )
}
