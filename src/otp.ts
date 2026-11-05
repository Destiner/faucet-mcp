import { createGuardrails, verifySync } from 'otplib'
import { isOtpConsumed, recordOtpUse } from './state'

function matchesOtp(token: string, secret: string): boolean {
  return verifySync({
    token,
    secret,
    epochTolerance: 30,
    period: 30,
    digits: 6,
    // v12 setup generated 10-byte secrets; keep existing authenticators valid.
    guardrails: createGuardrails({ MIN_SECRET_BYTES: 10 }),
  }).valid
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
  if (!matchesOtp(normalized, secret)) {
    return { ok: false, reason: 'invalid' }
  }
  recordOtpUse(normalized)
  return { ok: true }
}

export type { OtpVerifyResult }
export { matchesOtp, verifyOtp }
