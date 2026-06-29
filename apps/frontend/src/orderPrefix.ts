export function orderPrefix(slug: string) {
  const alnum = String(slug ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return alnum.length >= 2 ? alnum.slice(0, 2) : 'SH'
}
