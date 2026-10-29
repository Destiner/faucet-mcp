#!/usr/bin/env bun
// Generates the Solana funding key and stores it in .env without printing it.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase58Encoder,
} from '@solana/kit'

const ENV_PATH = join(import.meta.dir, '..', '.env')
const VAR = 'SOLANA_FUNDING_PRIVATE_KEY'

const env = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : ''
const existing = env.match(new RegExp(`^${VAR}=(.+)$`, 'm'))?.[1]?.trim()

if (existing) {
  const signer = await createKeyPairSignerFromBytes(
    new Uint8Array(getBase58Encoder().encode(existing)),
  )
  console.info(`${VAR} already set in .env. Address: ${signer.address}`)
  process.exit(0)
}

const { privateKey, publicKey } = (await crypto.subtle.generateKey(
  'Ed25519',
  true,
  ['sign', 'verify'],
)) as CryptoKeyPair
// PKCS#8 for Ed25519 ends with the 32-byte seed; Solana's secret key format is
// seed || public key.
const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', privateKey))
const pub = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey))
const secret = new Uint8Array(64)
secret.set(pkcs8.slice(-32), 0)
secret.set(pub, 32)

const signer = await createKeyPairSignerFromBytes(secret)
const prefix = env === '' || env.endsWith('\n') ? '' : '\n'
appendFileSync(
  ENV_PATH,
  `${prefix}${VAR}=${getBase58Decoder().decode(secret)}\n`,
  {
    mode: 0o600,
  },
)
console.info(`Wrote ${VAR} to .env. Address: ${signer.address}`)
