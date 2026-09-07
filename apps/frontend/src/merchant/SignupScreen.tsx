import { useState, useEffect, useRef } from 'react'
import { useSearchParams, useParams, Link } from 'react-router-dom'
import { signUp, signIn, createMerchant, checkReferralCode } from '../store'
import { pixelTrack } from '../pixels/track'
// TinyOrder's OWN ids, deliberately — a shop signing up is our conversion, never a merchant's.
import { platformPixelIds } from '../pixels/ids'
import { trackEvent, toBilling } from '../analytics/events'
import type { SignupFailure } from '../analytics/events'
import { SignupError } from '../signupError'
import { toSlugBase } from '../slug'
import { normalizeReferralCode, referralCodeFromInput } from '../referralCode'
import { MIN_PASSWORD_LENGTH } from '@bitetime/shared'
import { useSession } from '../SessionContext'
import { usePlatformPricing } from '../usePlatformPricing'
import { formatMoney, CURRENCIES, CURRENCY_CODES, DEFAULT_CURRENCY, currencyDef } from '../currency'
import type { CurrencyCode } from '../currency'
import BusinessNaturePicker from '../components/BusinessNaturePicker'
import { PasswordInput } from '../components/PasswordInput'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger } from '../components/ui/select'
import Wordmark from '../components/Wordmark'

const CYCLES = ['monthly', 'yearly']

/**
 * The first of `candidates` that is one of `allowed`, else `fallback`.
 *
 * Several candidates, in order, because the cycle reaches this screen more than one way. The path
 * segment (`/merchant/signup/yearly`) is what the pricing card links to — a query string is what a
 * link auditor and a human both read as an unfriendly URL. The query string (`?billing=yearly`) is
 * what Stripe's `cancel_url` sends back.
 *
 * BOTH path segments are offered as candidates, and that is deliberate rather than sloppy: the URL
 * used to carry the plan first (`/merchant/signup/pro/yearly`), and those links are still in
 * inboxes and in Stripe's own history. Reading whichever segment happens to be a cycle keeps them
 * landing on a working form instead of a route that matches nothing and renders a blank page.
 */
function pick(allowed: string[], candidates: (string | null | undefined)[], fallback: string) {
  return candidates.find(c => c != null && allowed.includes(c)) ?? fallback
}

export default function SignupScreen() {
  const { t, lang, refreshMerchant } = useSession()
  const { pricing } = usePlatformPricing()
  const [params] = useSearchParams()
  const path = useParams()

  const billing = pick(CYCLES, [path.a, path.b, params.get('billing')], 'monthly')
  const canceled = params.get('canceled') === '1'

  const [name, setName] = useState('')
  // No default (#161): pre-selecting an industry would collect a guess from every merchant who
  // never opened the dropdown, on the one field that exists to be counted. Submit stays disabled
  // until they pick.
  const [businessNature, setBusinessNature] = useState('')
  // Chosen once, here, and never editable again (Shop Settings only displays it) — so unlike
  // businessNature this one DOES default, to MYR: it isn't a field the platform needs an honest
  // "never chose" signal on, just a sane starting price unit most shops won't touch.
  const [currency, setCurrency] = useState<CurrencyCode>(DEFAULT_CURRENCY)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  // The referral code, now a FIELD rather than only the `?ref=` a referrer's link carries (#265).
  // A merchant who was told a code by mouth, or who opened the signup page themselves, had no way
  // to enter one at all — and the backend drops a code it dislikes in silence, so a typo used to
  // look exactly like a referral that worked.
  const [refCode, setRefCode] = useState(() => referralCodeFromInput(params.get('ref') ?? ''))
  // The answer for ONE code, held with the code it answers. Keeping the code alongside the verdict
  // is what makes 'checking' a derived state rather than a second setState: a result for anything
  // but the code in the box is a stale answer and reads as still checking. `valid: null` is the
  // check we could not make at all.
  const [refResult, setRefResult] = useState<{ code: string; valid: boolean | null } | null>(null)
  const referredByCode = normalizeReferralCode(refCode)

  // Ask the backend whether the code names a shop, one keystroke's pause after the merchant stops
  // typing. Only a well-formed code is worth a request, and the effect keys on the NORMALIZED
  // code, so re-typing the same code in another case asks nothing.
  useEffect(() => {
    if (!referredByCode) return
    let active = true
    const timer = setTimeout(async () => {
      const r = await checkReferralCode(referredByCode)
      if (!active) return
      // A check we could not make must never stop a shop from opening: the code is sent either
      // way and the worst case is the silence we already had. Only a definite "no shop uses this"
      // holds the submit button.
      setRefResult({ code: referredByCode, valid: r.ok ? r.data.valid : null })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [referredByCode])

  const refStatus: 'idle' | 'checking' | 'valid' | 'unknown' | 'unverified' =
    !referredByCode ? 'idle'
      : refResult?.code !== referredByCode ? 'checking'
        : refResult.valid === null ? 'unverified'
          : refResult.valid ? 'valid' : 'unknown'

  // Fires once. A ref rather than state because nothing renders from it, and a re-render per
  // keystroke to record a fact that never changes again is a re-render for nothing.
  const started = useRef(false)
  function onFirstTouch() {
    if (started.current) return
    started.current = true
    trackEvent('signup_started')
  }

  const [slugPreview, setSlugPreview] = useState('shop-…')
  useEffect(() => {
    let active = true
    toSlugBase(name).then(base => { if (active) setSlugPreview(base || 'shop-…') })
    return () => { active = false }
  }, [name])

  /**
   * The line under the referral field: what it says, and what colour it says it in.
   *
   * Only a settled verdict is coloured. 'Code found' is green and 'no shop uses this' is red,
   * because those are answers. The format hint stays grey — a merchant seven characters into an
   * eight-character code has made no mistake yet, and a field that turns red at the first
   * keystroke tells everyone off for typing. A check we could not make is grey for the same
   * reason: it is our failure, not theirs, and it does not stop them.
   */
  const refNote: { text: string; tone: string } =
    refCode.trim() === ''
      ? { text: t('Someone invited you? Enter their code.', '有人邀请你？请输入其推荐码。'), tone: 'text-muted-foreground' }
      : !referredByCode
        ? { text: t('A referral code is 8 characters, 0–9 and A–F.', '推荐码为 8 位字符，只含 0–9 与 A–F。'), tone: 'text-muted-foreground' }
        : refStatus === 'checking'
          ? { text: t('Checking…', '检查中…'), tone: 'text-muted-foreground' }
          : refStatus === 'valid'
            ? { text: t('Code found.', '推荐码有效。'), tone: 'text-success-fg' }
            : refStatus === 'unknown'
              // Not "no shop uses this code" any more: the endpoint also refuses a code whose
              // owner cannot earn the reward today (a trial, a failed payment, a subscription
              // winding down), and saying the code does not exist would be untrue. It stays one
              // message for both cases on purpose — which of the two it is, is the referrer's
              // business, and a message that distinguished them would report a stranger's
              // billing state to anyone holding 8 hex characters.
              ? { text: t('This code cannot be used. Ask the person who invited you.',
                          '此推荐码无法使用，请向邀请你的人确认。'), tone: 'text-danger-fg' }
              : { text: t('We could not check this code. You can continue.',
                          '暂时无法验证此推荐码，你可以继续。'), tone: 'text-muted-foreground' }

  // A typed code the form cannot vouch for holds the button. Deliberately not a silent drop:
  // the merchant is one keystroke from a code that works, and after signup there is no screen
  // that lets them fix it.
  const refBlocks = refCode.trim() !== '' && (!referredByCode || refStatus === 'checking' || refStatus === 'unknown')

  const cycleName = billing === 'yearly' ? t('Yearly', '按年') : t('Monthly', '按月')
  const planPrices = pricing.prices.pro
  const perMoAmount = billing === 'yearly' ? planPrices.yearly / 12 : planPrices.monthly

  /**
   * What a failed signup says, and it is deliberately NOT shared with the customer panel's
   * version of this map (store/AuthPanel.tsx). The codes are one union because they come off
   * one endpoint shape; the WORDS are not, because a merchant and a customer are being told
   * about different things — a shop that was not opened against an account that was not made —
   * and the merchant screen has a "log in" link at the bottom to point a returning owner at.
   */
  function failureText(reason: SignupFailure): string {
    switch (reason) {
      case 'duplicate_email':
        return t('That email already has an account. Log in instead — your shop is waiting.',
                 '该邮箱已注册。请直接登录，你的店铺仍在。')
      case 'weak_password':
        return t(`Use at least ${MIN_PASSWORD_LENGTH} characters for your password.`,
                 `密码至少需要 ${MIN_PASSWORD_LENGTH} 个字符。`)
      case 'invalid_email':
        return t('That email address does not look right.', '邮箱地址格式不正确。')
      case 'rate_limited':
        return t('Too many attempts. Please try again in a few minutes.', '尝试次数过多，请几分钟后再试。')
      case 'network':
        return t('Could not reach the server. Please try again.', '无法连接服务器，请重试。')
      case 'signin_failed':
        return t('Your account was created, but we could not sign you in. Please log in below.',
                 '账号已创建，但自动登录失败。请在下方登录。')
      default:
        return t('Could not create your shop. Please try again.', '创建店铺失败，请重试。')
    }
  }

  /** Show the merchant what happened AND report it, so the funnel names its own gaps. */
  function fail(reason: SignupFailure, message?: string) {
    trackEvent('signup_failed', { reason })
    setMsg(message || failureText(reason))
    setBusy(false)
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true); setMsg('')
    // Before the network call, deliberately: this counts a merchant who FILLED THE FORM IN.
    // Fired on success instead, it would be a second name for `merchant_signup` and could never
    // measure the gap it exists to measure.
    trackEvent('signup_submitted', { billing: toBilling(billing) })
    try {
      // The backend creates the account pre-confirmed, so the sign-in below succeeds and the
      // shop is created in this same submit. The shop details still ride along on the auth
      // user's metadata as the fallback for a browser that dies between the two calls.
      await signUp(name, email, password, { name, businessNature, currency, billing: billing as 'monthly' | 'yearly', ref: referredByCode ?? undefined })
      try {
        await signIn(email, password)
      } catch {
        // The account EXISTS from here on, so this is not a wrong password and must not be
        // dressed up as one. Rare now that there is no confirmation gate in front of it —
        // which is exactly why it is worth reporting when it happens.
        fail('signin_failed'); return
      }
      const created = await createMerchant({ name, billing, referredByCode: referredByCode ?? undefined, businessNature, currency })
      // An account with no shop. FinishSignupScreen picks this up from the parked metadata on
      // the next visit, so the merchant is not stranded — but the funnel has to see it, or the
      // drop looks like an abandoned form.
      if (!created.ok) { fail('shop_create_failed', created.error.message); return }
      // The one conversion the marketing pixels report, and it has to be here rather than on the
      // page the merchant lands on: /merchant is outside the marketing scope. The shop exists at
      // this line. A no-op unless the visitor accepted the pixels — see pixels/track.ts.
      pixelTrack(platformPixelIds(), 'CompleteRegistration')
      // The same moment, reported to our own analytics — which, unlike the pixels above, reports
      // whether or not the visitor accepted advertising cookies. See analytics/events.ts.
      trackEvent('merchant_signup', { billing: toBilling(billing) })
      // `trial` is the BACKEND's own answer, not a guess from the status: POST /api/merchants
      // returns `{ …, trial: false }` when Stripe refused and the shop stayed `pending`, and
      // `{ …, status: 'active', trial }` when it provisioned the cardless trial. A pending shop
      // started no trial, and reporting one would make the funnel's own retry step invisible.
      if (created.data?.trial === true) trackEvent('trial_started')
      await refreshMerchant()
      // Cardless trial, and there is no other door (#222). The backend provisioned the trial and
      // activated the shop during createMerchant, so this lands on the dashboard. If Stripe
      // refused, the shop is still there at `pending` and MerchantHome shows the retry screen.
      // `replace`, not `assign`: the shop now exists, so Back must not return to a signup form
      // that would try to create it a second time.
      window.location.replace('/merchant')
    } catch (err: unknown) {
      // `signUp` throws SignupError and nothing else on a refusal, so the code carries the
      // reason all the way from the endpoint. Anything else reaching here is a bug, and
      // 'server' is the honest name for a failure we cannot describe.
      fail(err instanceof SignupError ? err.code : 'server')
    }
  }

  return (
    <div role="main" className="w-[420px] max-w-full pt-6">
      <div className="text-center mb-6">
        <h1><Wordmark className="h-8 mx-auto" /></h1>
        <p className="font-heading text-[13px] italic text-muted-foreground mt-[5px]">{t('Merchant Portal', '商家入口')}</p>
      </div>
      <Card className="px-8 pt-7 pb-6 gap-0">
        <h2 className="font-heading text-[20px] font-medium text-primary mb-1">{t('Start your shop', '开店')}</h2>
        <p className="text-[13px] text-muted-foreground mb-5">{t('Create your merchant account to get started.', '创建商家账号以开始使用。')}</p>

        {/* Plan banner: oxblood-tint bg, rose-border, md radius */}
        <div className="flex items-baseline flex-wrap gap-2 px-[13px] py-[10px] mb-[14px] bg-brand-100 border border-border rounded-md">
          <span className="font-semibold text-primary text-[14px]">{cycleName}</span>
          <span className="font-heading text-foreground text-[15px]">{formatMoney(perMoAmount, pricing.currency)}{t('/mo', '/月')}</span>
          {pricing.estimate && perMoAmount > 0 && (
            <span className="text-muted-foreground text-[13px]">≈ {formatMoney(perMoAmount * pricing.estimate.rate, pricing.estimate.currency)}{t('/mo', '/月')}</span>
          )}
          {/* Unconditional now: every shop starts on the trial, so there is no second case for
              this badge to be wrong about. */}
          <Badge variant="default" className="ml-auto py-[2px] tracking-[0.03em]">
            {t('7-day free trial — no card required', '7 天免费试用，无需信用卡')}
          </Badge>
        </div>

        {canceled && (
          <div className="text-[13px] text-ink-700 bg-brand-100 border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {t('Checkout was canceled. Complete your details to try again.',
               '结账已取消。完善信息后可再次尝试。')}
          </div>
        )}
        {msg && (
          <div className="text-[13px] text-ink-700 bg-brand-100 border border-border rounded-sm px-[13px] py-[10px] mb-[10px] leading-[1.5]">
            {msg}
          </div>
        )}
        {/* onFocus, not onChange: it fires on the first field a merchant lands in, whether or
            not they ever type. Focus bubbles in React, so one handler on the form covers every
            input without threading a prop through each. */}
        <form onSubmit={onSubmit} onFocus={onFirstTouch}>
          <div className="flex flex-col gap-2.5 mb-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-1">{t('Shop name', '店铺名称')}</Label>
              <Input id="signup-1" value={name} onChange={e => setName(e.target.value)} required placeholder={t('e.g. Sunny Bakes', '如：阳光烘焙')} />
              {/* Folded into a plain caption under the field it describes, rather than its own
                  boxed row — same information, one line instead of a whole extra block. */}
              <p className="text-[12px] text-muted-foreground font-mono tracking-[0.3px] leading-[1.4]">
                /s/{slugPreview}
              </p>
            </div>
            {/* Business nature and currency are both chosen once here and never editable again
                (Shop Settings only displays either) — paired in one row with one shared caption
                below, rather than each carrying its own full-height block. */}
            <div className="flex gap-2.5">
              <div className="flex-1 min-w-0">
                <BusinessNaturePicker id="signup-nature" value={businessNature} onChange={setBusinessNature} />
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <Label htmlFor="signup-currency">{t('Base currency', '基础货币')}</Label>
                <Select value={currency} onValueChange={(v) => setCurrency((v as CurrencyCode) ?? currency)}>
                  <SelectTrigger id="signup-currency" className="w-full" aria-label={t('Base currency', '基础货币')}>
                    <span className="truncate">
                      {currencyDef(currency).code} — {currencyDef(currency).symbol}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCY_CODES.map(code => (
                      <SelectItem key={code} value={code}>
                        {CURRENCIES[code].code} — {CURRENCIES[code].symbol} · {CURRENCIES[code].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-[12px] text-muted-foreground leading-[1.4] -mt-1">
              {t("Can't be changed after signup.", '设置后无法更改。')}
            </p>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-2">{t('Email', '邮箱')}</Label>
              <Input id="signup-2" type="email" value={email} onChange={e => setEmail(e.target.value)} required />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-3">{t('Password', '密码')}</Label>
              <PasswordInput id="signup-3" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} required minLength={MIN_PASSWORD_LENGTH} />
            </div>
            {/* Last, and marked optional: most merchants have no code, and a field that looks
                required in the middle of the form would ask every one of them for something they
                cannot answer. `referralCodeFromInput` accepts the invite LINK too, because that is
                what a referrer actually pastes into a chat. */}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="signup-ref">{t('Referral code (optional)', '推荐码（可选）')}</Label>
              <Input
                id="signup-ref"
                value={refCode}
                onChange={e => setRefCode(referralCodeFromInput(e.target.value))}
                placeholder={t('e.g. 4F2A9C1B', '如 4F2A9C1B')}
                autoComplete="off"
                spellCheck={false}
                className="font-mono tracking-[0.5px]"
                aria-describedby="signup-ref-note"
              />
              {/* One line, always present, so the field never jumps as the answer arrives. */}
              <p id="signup-ref-note" aria-live="polite" className={`text-[12px] leading-[1.4] ${refNote.tone}`}>
                {refNote.text}
              </p>
            </div>
          </div>
          {/* A Radix select carries no native `required`, so the button is the gate — and the same
              gate holds a referral code the merchant is still getting wrong. A code that is
              malformed, still being checked, or known to name no shop stops the submit; an EMPTY
              field and a code we could not check both pass, because neither is a mistake we can
              prove. */}
          <Button type="submit" variant="default" size="md" className="py-3" disabled={busy || !businessNature || refBlocks}>
            {busy ? t('Creating…', '创建中…') : t('Start free trial', '开始免费试用')}
          </Button>
          {/* Sits under the button, not above it: the merchant reads it at the moment the act
              happens. The screen said nothing about terms before, so nothing recorded that a
              merchant had agreed to anything at all. */}
          {/* One translation unit with the links interpolated into it, NOT a sentence assembled
              from translated fragments: ' and ' and '.' as their own units bake English word
              order and spacing into strings a translator cannot reorder, and Chinese wants
              neither the spaces nor the full stop. */}
          <p className="text-[14px] leading-[1.6] text-muted-foreground text-center mt-3">
            {(() => {
              const terms = (
                <Link key="terms" to="/terms" className="text-primary underline underline-offset-2">
                  {t('Terms of Service', '服务条款')}
                </Link>
              )
              const privacy = (
                <Link key="privacy" to="/privacy" className="text-primary underline underline-offset-2">
                  {t('Privacy Policy', '隐私政策')}
                </Link>
              )
              return lang === 'zh'
                ? <>创建店铺即表示你同意我们的{terms}与{privacy}。</>
                : <>By creating a shop you agree to our {terms} and {privacy}.</>
            })()}
          </p>
        </form>
        <p className="text-[13px] text-muted-foreground text-center mt-4">
          <Link to="/merchant/login" className="text-primary cursor-pointer underline">{t('Already have a shop? Log in', '已有店铺？登录')}</Link>
        </p>
      </Card>
    </div>
  )
}
