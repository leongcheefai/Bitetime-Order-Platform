import { Link } from 'react-router-dom'
import { sampleShopScreenshotUrl, type CapturedSampleShop } from '../store'
import { useSession } from '../SessionContext'
import { ctaPrimary } from './ctaStyles'
import { cn } from '../lib/utils'
import { Carousel, CarouselContent, CarouselItem, CarouselPrevious, CarouselNext } from '../components/ui/carousel'

// Real shops (merchants.is_sample), each one a LINK into its live storefront at /s/:slug.
//
// This reverses the original rule. The landing page used to link one hardcoded shop
// (`/s/bitetime-co`) and customers placed real orders on it (fcd0a57), so the first carousel was
// built non-clickable "by construction". A visitor who cannot open a shop cannot see the thing
// being sold either, so the click is back — and the guard moved from the markup to the flag:
// `is_sample` now means "this shop accepts real public orders from strangers", and only a
// superadmin sets it, from /admin/merchants, where the toggle says so. Orders placed here are
// ordinary orders on an ordinary storefront. See the 2026-08-29 amendment in
// docs/superpowers/specs/2026-08-04-sample-shops-carousel-design.md.
//
// Built on shadcn's Carousel (embla-carousel-react) rather than a bare scroll-snap row: with more
// than 3-4 shops the row scrolled past the container edge with no affordance telling a visitor
// there was more to see. Prev/Next buttons only render past one shop — a single card has nothing
// to scroll to.
//
// ONE CARD KIND, and that is the fix for what visitors were complaining about. This used to fall
// back to an avatar-and-product-list card for a shop whose screenshot had not been captured yet,
// so a row could hold two screenshots and one list card — three shops rendered three different
// ways, which reads as a broken page rather than as a gallery. A shop without a screenshot is now
// filtered out upstream (useSampleShops) and simply is not in the row. The screenshot arrives
// within minutes of the superadmin flagging the shop: POST /api/admin/set-merchant-sample asks
// GitHub Actions to capture it there and then.
//
// Fixed aspect-[3/4], never h-full: with h-full the card took its height from the TALLEST card in
// the row, so where a 390x844 capture got cropped depended on which other shops happened to be
// flagged. Every card is the same shape now, cropped from the top.
//
// The call to action is a <span>, not a second <a> — the whole card is already the link, and an
// anchor inside an anchor is invalid markup that browsers un-nest at parse time.
export default function SampleShopsCarousel({ shops }: { shops: CapturedSampleShop[] }) {
  const { t } = useSession()

  return (
    <Carousel opts={{ align: 'start' }} className="max-w-[900px] mx-auto">
      <CarouselContent>
        {shops.map((shop) => (
          <CarouselItem key={shop.id} className="basis-1/3">
            <Link
              to={`/s/${shop.slug}`}
              className="group block overflow-hidden rounded-2xl border-[0.5px] border-border bg-card shadow-elev-3 no-underline [transition:transform_0.15s,border-color_0.15s] hover:-translate-y-0.5 hover:border-primary"
            >
              <img
                src={sampleShopScreenshotUrl(shop.screenshotPath)}
                alt={shop.name}
                loading="lazy"
                decoding="async"
                className="block w-full aspect-[3/4] object-cover object-top"
              />
              <div className="flex flex-col items-stretch gap-3 p-4">
                <span className="text-[15px] font-medium text-foreground truncate">{shop.name}</span>
                <span className={cn(ctaPrimary, 'text-center py-2.5 px-4 text-[14px]')}>
                  {t('Start ordering', '开始下单')}
                </span>
              </div>
            </Link>
          </CarouselItem>
        ))}
      </CarouselContent>
      {shops.length > 1 && (
        <>
          <CarouselPrevious />
          <CarouselNext />
        </>
      )}
    </Carousel>
  )
}
