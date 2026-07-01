import { describe, it, expect } from 'vitest'
import { detectRegion, REGION_CURRENCY, isValidRegion } from '../../src/region.js'

const noHeaders = () => undefined

describe('detectRegion', () => {
  it('defaults to US when no country is given', () => {
    expect(detectRegion({ getHeader: noHeaders })).toBe('US')
  })

  it('maps a MY country header to the MY region', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'MY' : undefined)
    expect(detectRegion({ getHeader })).toBe('MY')
  })

  it('maps any non-MY country to the US default region', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'SG' : undefined)
    expect(detectRegion({ getHeader })).toBe('US')
  })

  it('lets an explicit country override the header', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'US' : undefined)
    expect(detectRegion({ explicitCountry: 'MY', getHeader })).toBe('MY')
  })

  it('is case-insensitive and trims the country', () => {
    expect(detectRegion({ explicitCountry: ' my ', getHeader: noHeaders })).toBe('MY')
  })

  it('prefers cf-ipcountry over later headers', () => {
    const getHeader = (n: string) =>
      n === 'cf-ipcountry' ? 'MY' : n === 'x-country-code' ? 'US' : undefined
    expect(detectRegion({ getHeader })).toBe('MY')
  })

  it('falls through to x-country-code when earlier headers are absent', () => {
    const getHeader = (n: string) => (n === 'x-country-code' ? 'MY' : undefined)
    expect(detectRegion({ getHeader })).toBe('MY')
  })
})

describe('REGION_CURRENCY', () => {
  it('maps each region to its ISO currency code', () => {
    expect(REGION_CURRENCY).toEqual({ US: 'USD', MY: 'MYR' })
  })
})

describe('isValidRegion', () => {
  it('accepts known regions and rejects the rest', () => {
    expect(isValidRegion('US')).toBe(true)
    expect(isValidRegion('MY')).toBe(true)
    expect(isValidRegion('XX')).toBe(false)
    expect(isValidRegion('')).toBe(false)
  })
})
