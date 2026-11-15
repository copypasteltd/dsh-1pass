/** Local-only TOTP input checks. Never includes input values in diagnostics. */
export type OtpInputIssue = 'invalid' | 'migration' | 'algorithm'
export function otpInputIssue(input: string): OtpInputIssue | undefined {
  if (typeof input !== 'string' || input.length > 8192) return 'invalid'
  const value = input.trim()
  if (!value) return undefined
  if (/^otpauth-migration:/i.test(value)) return 'migration'
  let secret = value
  if (/^otpauth:/i.test(value)) {
    if (!value.startsWith('otpauth://')) return 'invalid'
    let uri: URL
    try { uri = new URL(value); decodeURIComponent(uri.pathname) } catch { return 'invalid' }
    if (uri.protocol !== 'otpauth:' || uri.hostname !== 'totp' || uri.username || uri.password || uri.port || uri.hash) return 'invalid'
    for (const key of ['secret', 'algorithm', 'digits', 'period']) if (uri.searchParams.getAll(key).length > 1) return 'invalid'
    secret = uri.searchParams.get('secret') ?? ''
    if (!secret) return 'invalid'
    const algorithm = uri.searchParams.get('algorithm')
    if (algorithm !== null && algorithm.toUpperCase() !== 'SHA1') return 'algorithm'
    const digits = uri.searchParams.get('digits')
    if (digits !== null && (!/^\d+$/.test(digits) || Number(digits) < 6 || Number(digits) > 10)) return 'invalid'
    const period = uri.searchParams.get('period')
    if (period !== null && (!/^\d+$/.test(period) || !Number.isSafeInteger(Number(period)) || Number(period) < 5)) return 'invalid'
  } else if (/[:/?#]/.test(value)) return 'invalid'
  const normalized = secret.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  return normalized.length >= 8 && /^[A-Z2-7]+$/.test(normalized) ? undefined : 'invalid'
}
