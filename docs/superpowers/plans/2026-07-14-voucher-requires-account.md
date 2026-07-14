# Voucher Requires Account Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A voucher's one-per-customer key comes from the verified JWT, never from the request body — closing a live hole where anyone can re-redeem a "one per customer" voucher indefinitely by varying a string.

**Architecture:** `voucherEntry` leaves the wire entirely. `app.ts` already verifies the JWT and passes `userId` on exactly this principle; it now also passes `userEmail`. A `voucherCode` with no verified email is refused (`voucher_requires_account`). The Storefront's voucher section offers sign-in when signed out.

**Tech Stack:** pnpm + Turborepo, TypeScript (strict), Hono, postgres.js, Supabase/Postgres, Vitest.

**Issue:** #72. **Spec:** `docs/superpowers/specs/2026-07-14-voucher-requires-account-design.md`.

## Global Constraints

- Run commands from the repo root; `--filter` targets one workspace.
- All workspaces TypeScript, `strict: true`, `noEmit: true`.
- **Backend uses `moduleResolution: NodeNext`** — relative imports keep `.js` specifiers that resolve to the `.ts` source. Leave them as `.js`. `@bitetime/shared` is imported via its **bare specifier**.
- **Frontend uses `moduleResolution: bundler`** — extensionless relative imports.
- `@bitetime/shared` ships **TypeScript source, no build step**. Adding a backend runtime dependency means adding its `--external:` esbuild flag. This plan adds none.
- **Never mock the database** in `tests/api` or `tests/rls`. They prove properties of real Postgres. `test:db` needs a running local Supabase (`supabase start` from `apps/backend`).
- **`db.ts` is RLS-exempt** — no policy runs on it. Every invariant on this path is a TypeScript one.
- **`OrderErrorCode` is a WIRE CONTRACT**, deliberately twinned in `apps/backend/src/orders.ts` and `apps/frontend/src/store.ts`. A code added in one must be added in the other **and** given a customer-facing `t(en, zh)` message, or the customer is told "something went wrong" for a refusal whose reason we know. A code deleted must be deleted from both.
- **Every user-facing string is `t(english, chinese)`.** There is no i18n library.
- **The dev server can serve stale backend code.** After backend edits, if you verify by hand, kill whatever holds `:8787` and restart — `pnpm dev` fails to bind with `EADDRINUSE` and silently keeps serving the old process.
- Commit after each task.

---

### Task 1: The backend keys the claim on the verified JWT

The whole security fix. The client stops speaking the key.

**Files:**
- Modify: `apps/backend/src/orders.ts`
- Modify: `apps/backend/src/app.ts` (the `POST /api/orders` route)
- Test: `apps/backend/tests/api/orders.test.ts`

**Interfaces:**
- Produces: `PlaceOrderInput` swaps `voucherEntry?: string | null` for `userEmail: string | null`. `OrderErrorCode` gains `'voucher_requires_account'` and **loses** `'voucher_entry_required'`.

- [ ] **Step 1: Write the failing tests**

In `apps/backend/tests/api/orders.test.ts`. The suite already has `customerToken` (a signed-in customer's access token) and `post(payload, token?)` — use them.

```ts
describe('a voucher claim is keyed to a verified account', () => {
  it('refuses a voucher from a guest, and writes nothing', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const res = await post(body(shop, productId, { voucherCode: 'SAVE5', quotedTotal: 21 }))
    expect(res.status).toBe(409)
    expect(await errorOf(res)).toBe('voucher_requires_account')
    expect(await ordersOf(shop)).toHaveLength(0)
    // Refused BEFORE the claim: the voucher must not be burnt by an order that never existed.
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual([])
  })

  it('keys used_by on the token email, not on anything the body said', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const res = await post(
      // The body still tries to name its own key. It must be IGNORED, not honoured — the
      // direct analogue of the suite's "never persists a status the client asked for".
      body(shop, productId, { voucherCode: 'SAVE5', voucherEntry: 'someone@else.com', quotedTotal: 21 }),
      customerToken,
    )
    expect(res.status).toBe(200)

    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ord-customer@test.dev'])
  })

  it('cannot be redeemed twice by the same account — the hole itself', async () => {
    await seedVoucher(shop, 'SAVE5', null)

    const first = await post(body(shop, productId, { voucherCode: 'SAVE5', quotedTotal: 21 }), customerToken)
    expect(first.status).toBe(200)

    // Before the fix this succeeded by simply varying `voucherEntry`. Now the body carries no
    // key at all, so the attack cannot even be EXPRESSED — which is the point.
    const second = await post(body(shop, productId, { voucherCode: 'SAVE5', quotedTotal: 21 }), customerToken)
    expect(second.status).toBe(409)
    expect(await errorOf(second)).toBe('voucher_already_used')

    expect(await ordersOf(shop)).toHaveLength(1)
    expect((await voucherOf(shop, 'SAVE5'))!.used_by).toEqual(['ord-customer@test.dev'])
  })
})
```

Any pre-existing test in this file that passes `voucherEntry` must be rewritten to sign in with `customerToken` instead — **that is a shape change, not a weakening**: those tests assert the claim, the rollback and the concurrency behaviour, and every one of those assertions stays exactly as it is. A voucher case that ran as a guest now runs as a signed-in customer, because that is what a voucher case now *is*. Do not delete one.

- [ ] **Step 2: Run them and watch them fail**

```bash
pnpm --filter @bitetime/backend test:db -- orders
```

Expected: FAIL. (A local Supabase must be running: `cd apps/backend && supabase start`.)

- [ ] **Step 3: Rewrite the claim in `orders.ts`**

`OrderErrorCode` — add one, delete one:

```ts
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_requires_account'
  | 'price_changed'
  | 'product_unavailable'
  | 'delivery_state_required'
```

`PlaceOrderInput` — `voucherEntry` out, `userEmail` in, documented like its sibling:

```ts
  /** From the verified JWT, or null for a guest. NEVER from the request body — see below. */
  userId: string | null
  /**
   * From the verified JWT, or null for a guest. NEVER from the request body.
   *
   * This is the voucher's ONE-PER-CUSTOMER KEY. It used to be `voucherEntry`, a string the
   * BODY supplied — so the same person re-redeemed a one-per-customer voucher forever by
   * varying it (`a@b.com`, `a+1@b.com`, `x`), and a voucher with a null `max_uses` was an
   * unlimited discount for one person. A key the client can name is not a key.
   */
  userEmail: string | null
```

In `placeOrder`, the claim call becomes:

```ts
    const voucher = input.voucherCode
      ? await claimVoucher(tx, input.merchantId, input.voucherCode, input.userEmail)
      : null
```

And `claimVoucher` takes the verified email, refusing an unkeyable claim outright:

```ts
/**
 * Claim one redemption of a voucher, under a row lock, keyed to a VERIFIED account.
 *
 * `for update` is not optional and is the reason this needs a real driver: without it, two
 * concurrent checkouts both read a fifty-use voucher at forty-nine uses and both write fifty
 * — and a cap that only holds when nobody is racing it is not a cap. The lock is held until
 * the surrounding transaction ends, so the loser reads the winner's write, not the stale row.
 *
 * The key comes from the JWT and from nowhere else. A voucher therefore REQUIRES AN ACCOUNT:
 * a guest has no verified identity, so their claim cannot be keyed to anything they cannot
 * also change, and an unkeyable claim is refused rather than keyed on something spoofable.
 * That is a deliberate product decision (#72) and it costs us a first-time customer holding a
 * promo code, who now meets a sign-in prompt. It is what makes the cap real.
 */
async function claimVoucher(
  tx: postgres.TransactionSql,
  merchantId: string,
  code: string,
  userEmail: string | null,
): Promise<PricedVoucher> {
  const entry = (userEmail ?? '').trim().toLowerCase()
  // A guest, or an account with no email address (phone-only auth). Either way the claim
  // cannot be keyed. Refused, never keyed on '' — every anonymous redemption would otherwise
  // collapse onto the same key, which once made a fifty-use voucher count as one.
  if (!entry) throw new OrderError('voucher_requires_account')

  // … the rest of the function is UNCHANGED: the `for update` select, voucher_not_found,
  // voucher_already_used, voucher_fully_used, the used_by append, and the voucherFromRow return.
}
```

- [ ] **Step 4: Stop reading the key from the body in `app.ts`**

In the `POST /api/orders` route, delete the `voucherEntry` line from the `placeOrder` call and add `userEmail`, drawn from the same verified `user` that already supplies `userId`:

```ts
    const result = await placeOrder({
      merchantId: b.merchantId,
      userId: user?.id ?? null,
      // The voucher's one-per-customer key. From the token, exactly like `userId`, and for
      // exactly the same reason: a body-supplied key is one the customer can simply change.
      userEmail: user?.email ?? null,
      customerName: b.customerName,
      customerWa: b.customerWa,
      mode,
      address: b.address ?? null,
      cart: b.cart,
      quotedTotal,
      voucherCode: typeof b.voucherCode === 'string' ? b.voucherCode : null,
    })
```

`b.voucherEntry` must appear **nowhere** in the file. Grep to be sure.

- [ ] **Step 5: Run the tests and watch them pass**

```bash
pnpm --filter @bitetime/backend test:db -- orders
pnpm --filter @bitetime/backend test:db
```

Expected: PASS, including every pre-existing rollback, concurrency, attribution and intake-gate assertion. `pnpm typecheck` will still fail in `apps/frontend` — `store.ts` still sends `voucherEntry` and still twins the deleted code. That is expected; Task 2 closes it.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "fix(orders): key a voucher claim to the verified account, not to the body

voucherEntry was the one-per-customer key AND a field the client supplied, so the
same person re-redeemed a one-per-customer voucher forever by varying it — and a
voucher with a null max_uses was an unlimited discount for one person. The key now
comes from the JWT, exactly like user_id and for the same reason.

A voucher therefore requires an account: a guest has no verified identity, so their
claim is refused rather than keyed on something they can change (#72)."
```

---

### Task 2: The storefront offers sign-in instead of a voucher field

**Files:**
- Modify: `apps/frontend/src/store.ts` (`OrderErrorCode`, `placeOrder`)
- Modify: `apps/frontend/src/store/Storefront.tsx`

**Interfaces:**
- Consumes: the wire from Task 1 — the body no longer carries `voucherEntry`; the codes gain `voucher_requires_account` and lose `voucher_entry_required`.

- [ ] **Step 1: Re-twin the codes in `store.ts`**

Add `voucher_requires_account`, delete `voucher_entry_required`:

```ts
export type OrderErrorCode =
  | 'merchant_not_found'
  | 'merchant_inactive'
  | 'voucher_not_found'
  | 'voucher_already_used'
  | 'voucher_fully_used'
  | 'voucher_requires_account'
  | 'price_changed'
  | 'product_unavailable'
  | 'delivery_state_required'
```

- [ ] **Step 2: Stop sending the key**

In `store.ts`'s `placeOrder`, remove `voucherEntry` from both the parameter object type and the `JSON.stringify` body. The backend ignores it now; sending it would be a lie about who decides.

- [ ] **Step 3: Key the browser's pre-flight on the account**

In `Storefront.tsx`, the local key must be the same thing the server will use, or the pre-flight passes and the submit refuses:

```ts
  // The voucher's one-per-customer key — the account email, and nothing else. It must match
  // what the SERVER keys on (the JWT's email), or this pre-flight green-lights a claim the
  // server then refuses. A voucher requires an account: there is no guest key (#72).
  const voucherEntry = (account?.email ?? '').trim().toLowerCase()
```

Delete `applyVoucher`'s "Enter your WhatsApp number before applying a voucher" branch — the WhatsApp number is no longer the key, and a signed-out customer cannot reach the Apply button at all after Step 4.

- [ ] **Step 4: The voucher section asks a signed-out customer to sign in**

In the VOUCHER section of the JSX, render the sign-in prompt in place of the input + Apply button when there is no `account`. `setSignInOpen` and `SignInDialog` already exist in this file and are already wired (the header and the guest strip both use them).

```tsx
            {!account ? (
              // A voucher is keyed to a verified account, so a guest cannot carry one (#72).
              // This is an OFFER, not a gate: the checkout path itself is untouched and guest
              // checkout is still one tap. You just cannot bring a discount through it.
              <button
                type="button"
                onClick={() => setSignInOpen(true)}
                className="text-[13px] underline underline-offset-4 text-rose-muted hover:text-rose-deep"
              >
                {t('Sign in to use a voucher', '登录后可使用优惠券')}
              </button>
            ) : (
              /* … the existing voucher input + Apply button, unchanged … */
            )}
```

Match the surrounding markup's classes rather than copying these verbatim if they do not fit — the repo's storefront has its own idiom, and this must not look bolted on.

- [ ] **Step 5: Give the new refusal a message**

`VOUCHER_REFUSALS` in `Storefront.tsx` — delete the `voucher_entry_required` entry, add:

```ts
  voucher_requires_account: (t: (en: string, zh: string) => string) =>
    t('Please sign in to use a voucher, then place the order again.', '使用优惠券需先登录，登录后请重新下单。'),
```

It fires when a session expires between applying a voucher and placing the order. Every entry in this map means the order was rolled back and NOTHING was written, so the message must end by asking for the order again — that is the map's stated contract.

- [ ] **Step 6: Verify**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all pass. Note `pnpm test` covers `store.test.ts`, which calls `placeOrder` directly — update its call sites' shape if it passes `voucherEntry`, without weakening any assertion.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(storefront): a voucher asks you to sign in

The one-per-customer key is now the verified account email, so a guest has no key
and cannot claim a voucher. The voucher section offers sign-in instead of a code
field; the checkout path is untouched and guest checkout is still one tap. You just
cannot bring a discount through it (#72)."
```

---

### Task 3: Run the app, and say so in the docs

**Files:**
- Modify: `CONTEXT.md` (the **Voucher** section)

- [ ] **Step 1: Drive it**

With local Supabase up and `pnpm dev` running (**kill whatever holds `:8787` first** — a stale backend silently serves old code and you will verify nothing):

1. **Signed out**, open a storefront. The voucher section offers "Sign in to use a voucher" — no code field. The rest of the checkout is unchanged and a guest order still places.
2. **Signed in**, apply a real voucher and place the order. Assert in SQL that the claim was keyed on the account email, not the WhatsApp number:
   `select used_by from vouchers where merchant_id = '…' and code = '…';`
3. **The hole, by hand.** With the customer's token, `curl` the same voucher a second time — and try to launder it by sending `voucherEntry: "someone@else.com"` in the body. Expect `voucher_already_used` both times, and `used_by` unchanged at one entry.

- [ ] **Step 2: Update CONTEXT.md**

Rewrite the **Voucher** section:

```markdown
## Voucher

A per-merchant promotion code. `percent` (subtotal×value/100) or fixed (`min(value, total)`).
Validation rules live in `voucherError`; the discount math lives in `priceOrder`; the claim
lives in `claimVoucher`, under a row lock, inside the order transaction.

**A voucher requires an account.** The one-per-customer key is the **verified JWT's email** and
nothing else — a guest has no verified identity, so their claim cannot be keyed to anything they
cannot also change, and an unkeyable claim is refused (`voucher_requires_account`) rather than
keyed on something spoofable. The key used to be `voucherEntry`, a string the **request body**
supplied: the same person re-redeemed a one-per-customer voucher forever by varying it, and a
voucher with a null `max_uses` was an unlimited discount for one person (#72). A key the client
can name is not a key — the same rule that already governs `user_id`.

The cost is deliberate: a first-time customer holding a promo code now meets a sign-in prompt.
Guest checkout stays first-class and one tap; it just cannot carry a discount.

`used_by` still holds WhatsApp numbers from historical guest redemptions. They are a key that can
no longer be produced, and they simply never match again. Not cleaned up — rewriting them would
mean guessing which number belonged to which account.
```

- [ ] **Step 3: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test
pnpm --filter @bitetime/backend test:db
```

Expected: all pass. Do not claim a suite passes you have not watched pass.

- [ ] **Step 4: Commit and open the PR**

Reference #72.
