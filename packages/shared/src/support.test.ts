import { describe, it, expect } from 'vitest'
import { validateSupportMessage, SUPPORT_MAX_LENGTH } from './support.js'

describe('validateSupportMessage', () => {
  it('trims and accepts ordinary text', () => {
    expect(validateSupportMessage('  my QR does not show  ')).toEqual({ ok: true, value: 'my QR does not show' })
  })

  it('keeps Markdown characters, emoji and Chinese exactly', () => {
    expect(validateSupportMessage('Joe *Star* _x_ 🍰 蛋糕')).toEqual({ ok: true, value: 'Joe *Star* _x_ 🍰 蛋糕' })
  })

  it('refuses empty and whitespace-only text', () => {
    expect(validateSupportMessage('   ')).toMatchObject({ ok: false, code: 'empty' })
    expect(validateSupportMessage('')).toMatchObject({ ok: false, code: 'empty' })
  })

  it('refuses a non-string body', () => {
    expect(validateSupportMessage(undefined)).toMatchObject({ ok: false, code: 'empty' })
    expect(validateSupportMessage(42)).toMatchObject({ ok: false, code: 'empty' })
  })

  it('accepts exactly the limit and refuses one more', () => {
    expect(validateSupportMessage('a'.repeat(SUPPORT_MAX_LENGTH))).toMatchObject({ ok: true })
    expect(validateSupportMessage('a'.repeat(SUPPORT_MAX_LENGTH + 1))).toMatchObject({ ok: false, code: 'too_long' })
  })
})
