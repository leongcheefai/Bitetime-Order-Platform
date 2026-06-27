import { describe, it, expect } from 'vitest'
import { nextOrderNumber } from './orderNumber'

describe('nextOrderNumber', () => {
  it('starts at 50 when there is no prior counter', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: null, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0050')
    expect(r.counter).toEqual({ day: '260627', value: 50 })
  })
  it('increments within the same day', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: { day: '260627', value: 50 }, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0051')
    expect(r.counter).toEqual({ day: '260627', value: 51 })
  })
  it('resets to 50 on a new day', () => {
    const r = nextOrderNumber({ prefix: 'CC', counter: { day: '260626', value: 73 }, today: '260627' })
    expect(r.orderNumber).toBe('CC-260627-0050')
    expect(r.counter).toEqual({ day: '260627', value: 50 })
  })
})
