import { authenticator } from 'otplib'
import { isOtpConsumed, recordOtpUse } from './state'

authenticator.options = {
  window: 1, // allow ±30s drift
  step: 30,
  digits: 6,
}

type OtpVerifyResult =
  | { ok: true }
  | {
      ok: false
      reason: 'missing_secret' | 'invalid' | 'replayed' | 'malformed'
    }

function verifyOtp(code: string | undefined): OtpVerifyResult {
  if (!code) {
    return { ok: false, reason: 'invalid' }
  }
  const normalized = code.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(normalized)) {
    return { ok: false, reason: 'malformed' }
  }
  const secret = process.env.FAUCET_TOTP_SECRET
  if (!secret) {
    return { ok: false, reason: 'missing_secret' }
  }
  if (isOtpConsumed(normalized)) {
    return { ok: false, reason: 'replayed' }
  }
  if (!authenticator.check(normalized, secret)) {
    return { ok: false, reason: 'invalid' }
  }
  recordOtpUse(normalized)
  return { ok: true }
}

export type { OtpVerifyResult }
export { verifyOtp }
