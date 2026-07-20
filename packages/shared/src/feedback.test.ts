import { describe, it, expect } from 'vitest'
import { validateFeedback, isFeedbackStatus, FEEDBACK_MAX_LENGTH } from './feedback.js'

describe('validateFeedback', () => {
  it('accepts a known category and a trimmed message', () => {
    const result = validateFeedback({ category: 'bug', message: '  the order list is empty  ' })
    expect(result).toEqual({ ok: true, value: { category: 'bug', message: 'the order list is empty' } })
  })

  it('rejects an unknown category', () => {
    const result = validateFeedback({ category: 'complaint', message: 'hello' })
    expect(result.ok).toBe(false)
  })

  it('rejects a missing category', () => {
    expect(validateFeedback({ message: 'hello' }).ok).toBe(false)
  })

  it('rejects a non-string message', () => {
    expect(validateFeedback({ category: 'other', message: 42 }).ok).toBe(false)
  })

  it('rejects a whitespace-only message', () => {
    expect(validateFeedback({ category: 'other', message: '   \n  ' }).ok).toBe(false)
  })

  it(`rejects a message longer than ${FEEDBACK_MAX_LENGTH} characters`, () => {
    const tooLong = 'x'.repeat(FEEDBACK_MAX_LENGTH + 1)
    expect(validateFeedback({ category: 'other', message: tooLong }).ok).toBe(false)
  })

  it('accepts a message of exactly the maximum length', () => {
    const atLimit = 'x'.repeat(FEEDBACK_MAX_LENGTH)
    expect(validateFeedback({ category: 'other', message: atLimit }).ok).toBe(true)
  })

  it('drops any extra keys — it builds its result rather than spreading the body', () => {
    const result = validateFeedback({
      category: 'billing', message: 'charged twice',
      status: 'resolved', merchant_id: 'someone-elses-shop', user_id: 'someone-else',
    })
    expect(result).toEqual({ ok: true, value: { category: 'billing', message: 'charged twice' } })
  })

  it('rejects a null or non-object body without throwing', () => {
    expect(validateFeedback(null).ok).toBe(false)
    expect(validateFeedback('nope').ok).toBe(false)
    expect(validateFeedback(undefined).ok).toBe(false)
  })
})

describe('isFeedbackStatus', () => {
  it('accepts the two real statuses', () => {
    expect(isFeedbackStatus('open')).toBe(true)
    expect(isFeedbackStatus('resolved')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isFeedbackStatus('closed')).toBe(false)
    expect(isFeedbackStatus(undefined)).toBe(false)
    expect(isFeedbackStatus(1)).toBe(false)
  })
})
