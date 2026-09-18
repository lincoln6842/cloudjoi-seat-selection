const formats = new Map<string, Intl.NumberFormat>()

/** Minor units -> "RM 150.00" (or "RM 150" when `compact`). */
export function formatMoney(minor: number, currency: string, compact = false): string {
  const key = `${currency}:${compact}`
  let format = formats.get(key)
  if (!format) {
    const digits = compact ? 0 : 2
    format = new Intl.NumberFormat('en-MY', {
      style: 'currency',
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
    formats.set(key, format)
  }
  return format.format(minor / 100)
}
