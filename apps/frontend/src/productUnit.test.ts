import { describe, it, expect } from 'vitest'
import { coerceQuantity, formatUnit } from './productUnit'

describe('coerceQuantity', () => {
  it('passes through a positive whole number', () => {
    expect(coerceQuantity(100)).toBe(100)
  })
  it('passes through a positive decimal', () => {
    expect(coerceQuantity(1.5)).toBe(1.5)
  })
  it('parses a numeric string', () => {
    expect(coerceQuantity('250')).toBe(250)
  })
  it('falls back to 1 for blank, zero, negative, and non-numeric', () => {
    expect(coerceQuantity('')).toBe(1)
    expect(coerceQuantity(0)).toBe(1)
    expect(coerceQuantity(-5)).toBe(1)
    expect(coerceQuantity('abc')).toBe(1)
    expect(coerceQuantity(NaN)).toBe(1)
    expect(coerceQuantity(null)).toBe(1)
    expect(coerceQuantity(undefined)).toBe(1)
  })
})

describe('formatUnit', () => {
  it('joins quantity and unit with a single space', () => {
    expect(formatUnit(100, 'g')).toBe('100 g')
    expect(formatUnit(1, 'pcs')).toBe('1 pcs')
    expect(formatUnit(1.5, 'kg')).toBe('1.5 kg')
  })
  it('treats a missing quantity as 1', () => {
    expect(formatUnit(undefined, 'pcs')).toBe('1 pcs')
    expect(formatUnit(0, 'g')).toBe('1 g')
  })
})
