#!/usr/bin/env bun
import { authenticator } from 'otplib'
import qrcode from 'qrcode-terminal'

const ACCOUNT = process.argv[2] ?? 'default'
const ISSUER = 'Rhinestone Faucet'

const secret = authenticator.generateSecret()
const uri = authenticator.keyuri(ACCOUNT, ISSUER, secret)

console.info('')
console.info('=== Faucet TOTP setup ===')
console.info('')
console.info('1. Add this line to .env:')
console.info('')
console.info(`   FAUCET_TOTP_SECRET=${secret}`)
console.info('')
console.info('2. Add the verification code to Apple Passwords / 1Password:')
console.info('')
console.info(`   ${uri}`)
console.info('')
console.info('   Scan with phone or paste the URI into a new entry as the')
console.info('   "Verification Code" / "One-Time Password" field.')
console.info('')
console.info('3. Scan QR with iOS Camera, 1Password, or Apple Passwords:')
console.info('')
qrcode.generate(uri, { small: true }, (q) => {
  console.info(q)
})
console.info('')
console.info('Verify by running: bun run bin/verify.ts <6-digit-code>')
console.info('')
