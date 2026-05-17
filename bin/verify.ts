#!/usr/bin/env bun
import { authenticator } from 'otplib'

authenticator.options = { window: 1, step: 30, digits: 6 }

const code = process.argv[2]
const secret = process.env.FAUCET_TOTP_SECRET

if (!code) {
  console.error('Usage: bun run bin/verify.ts <6-digit-code>')
  process.exit(2)
}
if (!secret) {
  console.error('FAUCET_TOTP_SECRET is not set. Did you run `bun run setup`?')
  process.exit(2)
}

const ok = authenticator.check(code.replace(/\s+/g, ''), secret)
if (ok) {
  console.info('OK — code is valid')
  process.exit(0)
} else {
  console.info('FAIL — code is invalid or expired')
  process.exit(1)
}
