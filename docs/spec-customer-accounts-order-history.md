# Spec: customer accounts & per-shop order history

**Status:** locked. Every decision below was settled on [Map: customer accounts & per-shop order history](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/41) and its eight tickets. Nothing here is open for re-litigation during implementation; if something looks wrong, reopen the ticket that decided it — each is linked.

A customer can sign in with email + password. Signed in, their orders at a shop are recorded and readable. Not signed in, they meet one gate at checkout — *sign in / create account / continue as guest* — and the guest path warns, truthfully, that the order joins no history.

---

## 1. The identity model

| | |
|---|---|
| **Signed-in order** | `orders.user_id = auth.uid()`, stamped by the database. |
| **Guest order** | `orders.user_id IS NULL`. **Orphaned permanently.** |

**Guest orders are never claimed retroactively.** Not by WhatsApp match, not by email match, not ever. This is what makes the guest warning literally true, and it closes the account-takeover surface that matching on an unverified WhatsApp number would open — anyone who knew a customer's number could otherwise sign up and inherit their order history, addresses and totals.

A guest's only recourse is the order number, via the existing `TrackOrder` screen. That is exactly what the warning tells them.

**History is per-shop.** The Supabase session is platform-wide (sign in at Shop A and you are signed in at Shop B), but each shop's history shows only that shop's orders. A customer with a long history at one shop can legitimately see an empty state at another.

**On `/s/:slug`, every signed-in user is a customer** — whatever role they hold elsewhere. A shop owner buying lunch from another shop is a customer. A merchant ordering from their *own* storefront gets an order attributed to themselves; harmless, since they can already read it as the owner.

---

## 2. Database

*Decided in [Lock the orders RLS insert policy so user_id cannot be spoofed](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/43).*

```sql
-- ── Stamp the ordering user from the JWT ─────────────────────────────────────
-- The client never supplies user_id; anything it sends is discarded. Guests
-- (no JWT) get NULL. Spoofing another customer's history is impossible by
-- construction, not by policy.
create or replace function public.orders_set_user_id()
returns trigger
language plpgsql
as $$
begin
  new.user_id := auth.uid();
  return new;
end;
$$;

drop trigger if exists orders_set_user_id on public.orders;
create trigger orders_set_user_id
  before insert on public.orders
  for each row execute function public.orders_set_user_id();

-- ── Replace the blanket insert policy ────────────────────────────────────────
-- `orders_insert_any` was `with check (true)`. Guests still insert (checkout),
-- but only into an ACTIVE shop, and only as a brand-new order.
drop policy if exists orders_insert_any on public.orders;
create policy orders_insert_guest_or_customer on public.orders
  for insert with check (
    status = 'new'
    and exists (
      select 1 from public.merchants m
      where m.id = merchant_id and m.status = 'active'
    )
  );

-- ── Serves the history query ─────────────────────────────────────────────────
create index if not exists orders_user_merchant_created_idx
  on public.orders (user_id, merchant_id, created_at desc)
  where user_id is not null;

-- ── Profile prefill ──────────────────────────────────────────────────────────
-- profiles.delivery_address already exists (unused). WhatsApp does not.
alter table public.profiles add column if not exists whatsapp text;
```

**Reads need no change.** `orders_select_scoped` already permits `user_id = auth.uid()`, and for an anonymous client that comparison yields `NULL` — not true — so guests read nothing.

Three traps for whoever writes the migration:

- **The `EXISTS` works under RLS only because `merchants_select_public` is `using (true)`** (`20260627120100_multitenant_rls.sql:9-10`). If that policy is ever tightened, this check breaks silently and must move into a `SECURITY DEFINER` helper.
- **Ordering is safe.** Postgres applies a policy's `WITH CHECK` to the row *after* `BEFORE INSERT` triggers run, so the trigger and the policy do not fight.
- **The trigger is unconditional**, so a future **service-role** insert (RLS-exempt, but *not* trigger-exempt, and with no `auth.uid()`) would write `user_id` as null. Nothing inserts orders server-side today. If order intake ever moves to the backend, the trigger needs a carve-out.

**No backfill.** Existing orders keep `user_id` null.

---

## 3. Auth

*Decided in [Can a new customer sign up mid-checkout without losing the order?](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/46), [What is the customer password-reset flow?](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/47), and [How is Supabase email auth actually configured for this project?](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/42).*

Email + password. Reuses the existing `signInWithPassword` / `signUp` (`store.ts:11-36`). No magic link, no OTP.

### 3.1 Sign-up — a backend endpoint, `POST /api/customer/signup`

**The project-wide email-confirmation setting stays ON.** Do not turn it off. It is shared with merchants, and a merchant account controls a shop and its Stripe billing — letting anyone register one against an address they don't own, and then mailing billing to an unverified address, is far worse than an unverified *customer* account.

Instead, customers are **created pre-confirmed, server-side**:

```ts
admin.auth.admin.createUser({ email, password, email_confirm: true })
```

The client then calls `signInWithPassword` and has a session **in the same tab, cart intact**. Nothing leaves checkout. The service-role `admin` client already exists (`apps/backend/src/supabase.ts:6`).

The endpoint also **writes the `profiles` row** with the service role, making signup atomic. The client's existing `ensureGlobalProfile` on `SIGNED_IN` (`store.ts:289-313`) stays as an idempotent safety net.

- **Password rule: minimum 8 characters**, no composition requirements. (Supabase's floor is 6.)
- **Duplicate email is stated plainly:** *"You already have an account — sign in."* The panel flips to sign-in with the email prefilled. This makes the endpoint an email-enumeration oracle. **Accepted knowingly** — for a food-ordering app the leak is low-harm, and the alternative strands a returning customer mid-checkout with no session and no actionable error.
- **Rate limit: an in-memory sliding window, per IP and per email.** Going around Supabase's `signUp` also goes around *its* rate limits, so we owe a replacement. This works because the backend is a long-lived Node process (`node dist/server.js` + `@hono/node-server`), not a serverless function. **Two caveats belong in a comment at the call site:** it resets on redeploy (harmless), and it **silently stops protecting anything if the backend is ever scaled past one instance** (not harmless). If it is ever actually abused, escalate to Turnstile/hCaptcha — deliberately not now, because a captcha widget in the checkout path costs orders.
- **CORS is not the guard.** `/api/*` is already restricted to `env.frontendUrl` (`index.ts:16`), but that only constrains browsers; any server can POST here. The rate limit is the control.
- **No role escalation:** `createUser` mints a plain auth user, `app_role` untouched, so `SessionContext` derives `customer`. The endpoint cannot manufacture a merchant or superadmin.

### 3.2 Sign-in

Plain `signInWithPassword` from the shared auth panel. No route (see §4).

### 3.3 Password reset — Supabase's own flow

`supabase.auth.resetPasswordForEmail(email, { redirectTo })`. Supabase owns the recovery token, its lifetime, and the link.

Deliberately **not** a backend endpoint like signup, because going through Supabase buys two things for free:

- **Rate limiting** — Supabase's own limits apply.
- **Non-enumeration** — `resetPasswordForEmail` succeeds whether or not the address exists. Show the neutral *"If that email has an account, we've sent a link."* Note the asymmetry with signup, which *does* disclose: **do not "fix" reset to match it.** The leak already exists; there is no reason to add a second.

Bilingual copy goes into the **single Supabase email template** (both EN and ZH in one body). The app's `t(en, zh)` cannot reach Supabase's templates under any design.

**Landing route: `/reset-password?shop=<slug>`** — top-level, **outside `StorefrontShell`**.

Not nested under `/s/:slug`, because `StorefrontShell` gates on merchant status (`AppRouter.tsx:56-66`): a suspended shop would swallow the page, and **a shop's status must never lock a customer out of their own account**. A top-level route also needs exactly one static allow-list entry rather than an `/s/*` wildcard.

Flow: `detectSessionInUrl` exchanges the token → new-password form → `supabase.auth.updateUser({ password })` → redirect. The route is **role-blind**: `?shop=<slug>` bounces to `/s/:slug`; no shop param bounces to `/merchant`. Only the *customer* entry point is built here (a "Forgot password" link in the auth panel), but merchants have no reset path today either, and this route doesn't care who you are — so adding one later is a one-line link, no new infrastructure.

**The cart does not survive a reset.** The customer left the tab for their inbox and the cart is ephemeral `useState`. They return signed in, on the storefront, with an empty cart. Inherent; accepted.

---

## 4. Routes & surfaces

*Decided in [Where do customer login and signup live in the route tree?](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/44).*

| Surface | Shape |
|---|---|
| Sign in / create account | **Modal / in-page step. No route.** |
| Order history | **`/s/:slug/orders`** — nested in `StorefrontShell`, beside `track`. |
| Password reset landing | **`/reset-password?shop=<slug>`** — top-level. |

**Auth is a modal because email+password has no redirect round-trip.** `Storefront` never unmounts, so **the cart survives by construction** — no lifting state, no storage, no restore logic. This matters: `Storefront` is a single page with no steps, holding the entire order in plain `useState` with nothing persisted (`Storefront.tsx:44-59`), so any navigation away destroys it. A route-based login would have forced cart persistence as a prerequisite.

**The interstitial is therefore a new step inside `Storefront`'s own state** — and it is the first step boundary that page has ever had. One has to be introduced.

**Signed-out history is not a redirect.** `/s/:slug/orders` renders the *same shared auth panel*, framed differently. **The auth panel is one component with two hosts** — the checkout interstitial and the signed-out history route. Build it that way from the start.

Explicitly **not** `RequireRole`: it bounces unauthorized users to `/merchant/login` — merchant framing, merchant bundle. Wrong destination for a hungry customer.

**Customer auth cannot reuse the merchant screens.** `SignupScreen` is code-split precisely because it drags in the heavy `pinyin-pro` dictionary for slug transliteration (`AppRouter.tsx:11-16`), deliberately kept out of the customer bundle. The customer components must not import it.

**Entry point:** a link in the storefront header, **always visible**. For a guest it is a second, gentler route into an account — unlike the interstitial, which only fires at checkout.

---

## 5. The checkout interstitial

*Decided in [Prototype the checkout interstitial](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/48) — variant D. Prototype: branch `prototype/checkout-gate-48`.*

A **full step that replaces the checkout form**, after the cart and fulfilment choice, before the details form. Not an overlay, not an inline panel.

Top to bottom:

1. **Headline** — "Sign in to keep your order history", with the payoff beneath it. The invitation leads with what the customer *gets*.
2. **Sign in** — primary button.
3. **Create account** — secondary button.
4. Hairline rule.
5. **"Continue as guest →"** — a small text link.
6. **The warning, immediately beneath it, always visible.**

**Guest is one tap.** No second confirmation, no acknowledgement checkbox — the consequence is already on screen when they tap. A confirm step would only be honest if the warning were hidden, and it isn't.

**The warning is muted, not alarming.** A bordered danger box *inverted the hierarchy* — it out-shouted the headline and made the guest path the loudest thing on a page whose purpose is to offer an account. Same words, small muted type, lead clause bolded.

### Copy (final)

**Guest warning**
- EN — **Guest orders can't be traced back.** This order won't be saved to any account. You'll get an order number — keep it. It's the only way to look this order up again.
- ZH — **访客订单无法追溯。** 此订单不会保存到任何账户。你会收到一个订单号，请务必保存——这是日后查询此订单的唯一方式。

**Sign-in invitation**
- EN — Sign in to keep your order history / Your orders at this shop are saved to your account, and your name and address fill in automatically next time.
- ZH — 登录以保存订单记录 / 你在本店的订单会保存到账户中，姓名和地址下次会自动填写。

The warning is deliberately **concrete rather than frightening**, and deliberately **true**: it does not claim the order is unfindable. `TrackOrder` still resolves a single order by number. The order number really is the recourse, and really is the only one.

### When the gate fires

| State | Behaviour |
|---|---|
| **Signed in** | The gate **never renders**. Details prefill; a *"Signed in as <email>"* strip sits above the form. |
| **First-time guest** | The gate fires. |
| **Returning guest** | The gate is **skipped** — the choice is remembered in `localStorage`, **keyed by slug** (per browser, per shop). A quiet strip remains above the details form: *"Ordering as a guest." / **Sign in***. Present, not nagging — the path stays recoverable without a repeat interstitial. |

A choice made at Shop A must **not** silence the gate at Shop B.

---

## 6. Order history

*Decided in [Prototype the per-shop order history screen](https://github.com/leongcheefai/Bitetime-Order-Platform/issues/45) — variant A. Prototype: branch `prototype/order-history-45`.*

**Compact rows.** Order number + date on the left; **status badge + total** on the right. Tapping expands **in place**: items, voucher line, fulfilment mode, courier/AWB.

It wins because **status stays legible**. A month-grouped variant looked better but collapsed status to a coloured dot, and *"where's my order?"* is the single most common reason this screen is opened.

Reuse the existing `StatusBadge` (`orderStatus.tsx`) and `courierName` / `trackingUrl` (`couriers.ts`).

### History absorbs tracking

The expanded row shows **courier and AWB inline**, linking straight out to the courier's own tracking page. It does **not** hand off to `TrackOrder`. Sending a signed-in customer — already looking at the order — to a screen where they'd re-type its number is absurd.

Consequently **`TrackOrder` becomes the guest-only path**, which is precisely what the guest warning promises. The two screens now have one job each and stop overlapping. The storefront header's "Track an order" link stays — it is the guest's entry point.

When an order has **no AWB yet** (pickup, or not yet shipped), the **status badge is the tracking**.

### The rest of the screen

- **Sign-out lives here**, in the *"Signed in as <email>"* strip. This is the only signed-in customer surface in the app.
- **The cap is stated, not silent:** the last **20** orders, with the line *"Showing your last 20 orders at this shop." / "显示你在本店最近的 20 笔订单。"* A silently truncated list reads as "this is everything" when it isn't.
- **Empty state** (signed in, never ordered *here*): *"You haven't ordered from this shop yet." / "你还没有在本店下过单。"* with a link to the menu. Reachable by a customer with a full history at another shop — history is per-shop, the account is not.
- **Signed out** renders the shared auth panel in place: *"Sign in to see your orders at this shop"*, with the honest sub-line *"Only orders placed while signed in appear here."*

---

## 7. Profile prefill

`profiles` gains a `whatsapp` column (§2). On checkout, a signed-in customer's order **writes both**:

- `profiles.whatsapp` — the number just used.
- `profiles.delivery_address` — the address just used, on delivery orders. (The column exists today but **nothing reads or writes it**.)

Both are then **prefilled** on the next order, at any shop. **Saved silently — no "save this address?" checkbox.** It is the customer's own address, the most recent one is almost always the right default, and this is exactly what the interstitial promises.

**The WhatsApp field stays required and editable.** The merchant needs a number to fulfil every order; prefill is a convenience, not a substitute. The customer types it once, ever.

---

## 8. Deployment prerequisites — the feature ships broken without these

Neither is application code.

1. **Enable Supabase custom SMTP against Resend, with a verified sending domain.** Password reset is undeliverable otherwise, and reset — unlike email confirmation — **cannot be worked around**; it is the only way back into an account. `onboarding@resend.dev` is test-only (`apps/backend/.env.example:29-30`). Resend is already wired in the backend for its own transactional mail (`apps/backend/src/email.ts`), but that does **not** carry Supabase auth email.
2. **Verify the production redirect allow-list** contains the `/reset-password` URL — production *and* local. Locally only `http://localhost:5173` is permitted (`config.toml:39-40`).

And one standing warning: **the project-wide email-confirmation setting must stay ON.** Anyone who "simplifies" the signup endpoint away by flipping that toggle silently removes email verification from every shop owner and their billing.

---

## 9. Out of scope

Ruled out deliberately. Each would be its own effort.

- **Reorder from history** — cart hydration against deleted, repriced, or promo-expired products is its own problem.
- **A customer profile page** — checkout already maintains the saved name, address and number.
- **Merchant-side account-vs-guest indicator** — no merchant dashboard change in this effort.
- **Cross-merchant / platform-wide order history** — history is per-shop.
- **Retroactive guest-order claim** — by WhatsApp or email. Unverified identity is account takeover.
- **Cart persistence across a page refresh** — a real, pre-existing bug (`Storefront` holds the order in ephemeral `useState`), but the modal-not-route decision means this effort no longer needs it fixed.
- **Server-side order intake** — order totals are computed in the browser and intake is unrate-limited. Pre-existing; needs intake to move behind the backend. This spec tightens everything SQL alone can reach and worsens nothing.
- **The merchant-signup email defect** — same root configuration, but merchant-side, and a live production issue rather than a step on this route.
