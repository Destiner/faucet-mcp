import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChainClass } from './chains'
import type { TokenPool, TokenSymbol } from './tokens'

interface SendRecord {
  ts: number
  chainId: number
  chainClass: ChainClass
  token: TokenSymbol
  pool: TokenPool
  amount: number
  recipient: string
  txHash: string
}

interface ConsumedOtp {
  code: string
  ts: number
}

interface StateShape {
  sends: SendRecord[]
  consumedOtps: ConsumedOtp[]
}

const DAY_MS = 24 * 60 * 60 * 1000
const OTP_REPLAY_TTL_MS = 90 * 1000

function getStatePath(): string {
  return (
    process.env.FAUCET_STATE_FILE ?? join(homedir(), '.faucet', 'state.json')
  )
}

function readState(): StateShape {
  const path = getStatePath()
  if (!existsSync(path)) {
    return { sends: [], consumedOtps: [] }
  }
  try {
    const raw = readFileSync(path, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StateShape>
    return {
      sends: parsed.sends ?? [],
      consumedOtps: parsed.consumedOtps ?? [],
    }
  } catch {
    return { sends: [], consumedOtps: [] }
  }
}

function writeState(state: StateShape): void {
  const path = getStatePath()
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  renameSync(tmp, path)
}

function prune(state: StateShape, now: number): StateShape {
  return {
    sends: state.sends.filter((s) => now - s.ts < DAY_MS),
    consumedOtps: state.consumedOtps.filter(
      (o) => now - o.ts < OTP_REPLAY_TTL_MS,
    ),
  }
}

function loadPrunedState(now: number = Date.now()): StateShape {
  return prune(readState(), now)
}

function sumWindow(
  state: StateShape,
  chainClass: ChainClass,
  pool: TokenPool,
  now: number = Date.now(),
): number {
  return state.sends
    .filter(
      (s) =>
        s.chainClass === chainClass && s.pool === pool && now - s.ts < DAY_MS,
    )
    .reduce((acc, s) => acc + s.amount, 0)
}

function recordSend(record: SendRecord): void {
  const now = Date.now()
  const pruned = prune(readState(), now)
  pruned.sends.push(record)
  writeState(pruned)
}

function recordOtpUse(code: string): void {
  const now = Date.now()
  const pruned = prune(readState(), now)
  pruned.consumedOtps.push({ code, ts: now })
  writeState(pruned)
}

function isOtpConsumed(code: string, now: number = Date.now()): boolean {
  const pruned = prune(readState(), now)
  return pruned.consumedOtps.some((o) => o.code === code)
}

export type { SendRecord, StateShape }
export {
  getStatePath,
  isOtpConsumed,
  loadPrunedState,
  recordOtpUse,
  recordSend,
  sumWindow,
}
