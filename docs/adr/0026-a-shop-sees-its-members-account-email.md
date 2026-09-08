# 26. A shop sees its members' account email

Date: 2026-09-05
Status: Accepted. Narrows the *no account email* boundary of
[ADR 0007](0007-shop-customers-are-keyed-by-phone.md) and CONTEXT.md → *Shop customer*.

## Context

The Members list (#269) shows the shop customers who hold a platform account. Every account is
an email and a password, so every member has an email, and the list said so with a tooltip
("gets order confirmation emails") while showing the address to nobody.

That was the boundary ADR 0007 drew: a WhatsApp number was volunteered to receive one order,
an account email was volunteered to the platform, and a shop was to see shop-scoped facts and
nothing from the global profile. The line was drawn before there was a Members list. Once a
shop can ask "who holds an account with me?", the answer with the email hidden is a list of
people the shop can reach only on WhatsApp — which is the channel the guest list already has,
so membership buys the shop nothing it can act on.

## Decision

**A member's account email is shown to the shop: on the Members list, and on that customer's
drawer, as a mailto.** Nowhere else.

- The wire carries `email` on every shop customer row, null for a guest. The Members list draws
  the column; the All list does not, because a column that is a dash for most rows repeats the
  account mark and costs every row the width.
- The value is the email behind the customer's **most recent signed-in order**, read by a
  `left join auth.users` in the grouping query. A guest order placed later never blanks it — the
  aggregate is filtered to signed-in orders, and the fold keeps its own recency for the email.
  An account change therefore follows the same rule a name change does.
- The address is **read, never stored** on the shop's side: it is derived on every list read
  from `orders.user_id`, which intake fills only from a verified JWT. Nothing copies it into
  `shop_customers`, so a customer who deletes their account is gone from the list on the next
  read.
- Still shop-scoped: the join runs under the same `merchant_id` predicate as every other read
  here, so a shop learns the emails of people who ordered from **it**, and cannot learn that a
  diner also orders elsewhere.

What stays out: the saved delivery address, the display name on the profile, and everything
else on the global profile. The boundary moved by one field, for one list, and this record is
what says so.

## Considered

- **Keep the boundary; show the account mark more clearly.** Rejected by the owner on
  2026-09-05: a members list the shop cannot write to is not a members list.
- **Show the email on the All list as well.** Rejected: a dash on most rows says only what the
  account mark already says.
- **Search by email.** Not in scope; the search stays name-or-WhatsApp and can grow later.
