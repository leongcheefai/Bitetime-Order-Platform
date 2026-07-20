// Merchant platform-feedback rules (#89). Shared because both sides enforce them: the
// dashboard form disables submit and shows a counter, the backend refuses. A merchant
// should be told their message is too long before they lose it to a 400.
//
// The database CHECK constraints in 20260720120000_merchant_feedback.sql are the final
// authority. These rules exist to keep the browser and the server from disagreeing about
// what the database will accept.

export const FEEDBACK_CATEGORIES = ['bug', 'feature', 'billing', 'other'] as const
export const FEEDBACK_STATUSES = ['open', 'resolved'] as const
export const FEEDBACK_MAX_LENGTH = 2000

export type FeedbackCategory = (typeof FEEDBACK_CATEGORIES)[number]
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number]

export interface FeedbackDraft {
  category: FeedbackCategory
  message: string
}

export type FeedbackValidation =
  | { ok: true; value: FeedbackDraft }
  | { ok: false; error: string }

export function isFeedbackCategory(value: unknown): value is FeedbackCategory {
  return typeof value === 'string' && (FEEDBACK_CATEGORIES as readonly string[]).includes(value)
}

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return typeof value === 'string' && (FEEDBACK_STATUSES as readonly string[]).includes(value)
}

/**
 * Validates a feedback submission and returns a clean draft.
 *
 * This is also the write allowlist. It BUILDS its result field by field rather than
 * spreading the body, so a caller cannot smuggle `status`, `merchant_id` or `user_id`
 * through it — the backend forces all three itself. Never bypass this and insert a raw body.
 */
export function validateFeedback(body: unknown): FeedbackValidation {
  const raw = (typeof body === 'object' && body !== null ? body : {}) as {
    category?: unknown
    message?: unknown
  }

  if (!isFeedbackCategory(raw.category)) {
    return { ok: false, error: 'Pick a feedback category' }
  }
  if (typeof raw.message !== 'string') {
    return { ok: false, error: 'Feedback message is required' }
  }

  const message = raw.message.trim()
  if (message.length === 0) {
    return { ok: false, error: 'Feedback message is required' }
  }
  if (message.length > FEEDBACK_MAX_LENGTH) {
    return { ok: false, error: `Feedback message must be ${FEEDBACK_MAX_LENGTH} characters or fewer` }
  }

  return { ok: true, value: { category: raw.category, message } }
}
