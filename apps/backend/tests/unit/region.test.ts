import { describe, it, expect } from 'vitest'
import { detectCountry } from '../../src/region.js'

const noHeaders = () => undefined

describe('detectCountry', () => {
  it('returns empty string when nothing is given', () => {
    expect(detectCountry({ getHeader: noHeaders })).toBe('')
  })

  it('reads the cf-ipcountry header', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'MY' : undefined)
    expect(detectCountry({ getHeader })).toBe('MY')
  })

  it('lets an explicit country override the header', () => {
    const getHeader = (n: string) => (n === 'cf-ipcountry' ? 'US' : undefined)
    expect(detectCountry({ explicitCountry: 'SG', getHeader })).toBe('SG')
  })

  it('uppercases and trims', () => {
    expect(detectCountry({ explicitCountry: ' sg ', getHeader: noHeaders })).toBe('SG')
  })

  it('prefers cf-ipcountry over later headers', () => {
    const getHeader = (n: string) =>
      n === 'cf-ipcountry' ? 'MY' : n === 'x-country-code' ? 'US' : undefined
    expect(detectCountry({ getHeader })).toBe('MY')
  })

  it('falls through to x-country-code when earlier headers are absent', () => {
    const getHeader = (n: string) => (n === 'x-country-code' ? 'ID' : undefined)
    expect(detectCountry({ getHeader })).toBe('ID')
  })
})
