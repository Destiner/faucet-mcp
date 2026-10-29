import type { Address as SolanaAddress } from '@solana/kit'
import { type Address, formatUnits, isAddress } from 'viem'
import type { Target } from './chains'
import * as evm from './evm'
import * as svm from './solana'
import type { TokenSymbol } from './tokens'

type PreflightIssue = svm.PreflightIssue

interface SendResult {
  txHash: string
  blockExplorerUrl?: string
  wrapTxHash?: string
  ataCreated?: boolean
}

const RECIPIENT_FORMAT: Record<
  Target['vm'],
  { problem: string; hint: string }
> = {
  evm: {
    problem: 'not a valid 0x address',
    hint: 'pass a 20-byte hex address like 0xCb1f054bCfc93c6eFAC556020D3822E425D37404',
  },
  svm: {
    problem: 'not a valid Solana address',
    hint: 'pass a base58 public key like 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  },
}

function isValidRecipient(target: Target, recipient: string): boolean {
  return target.vm === 'evm'
    ? isAddress(recipient)
    : svm.isSolanaAddress(recipient)
}

async function getFunderAddress(vm: Target['vm']): Promise<string | null> {
  try {
    return vm === 'evm'
      ? evm.getFundingAccount().address
      : await svm.getFunderAddress()
  } catch {
    return null
  }
}

async function getFunderBalance(
  target: Target,
  token: TokenSymbol,
): Promise<string> {
  const { balance, decimals } =
    target.vm === 'evm'
      ? await evm.getFunderBalance(target, token, 0n)
      : await svm.getFunderBalance(target, token)
  return formatUnits(balance, decimals)
}

async function preflight(
  target: Target,
  token: TokenSymbol,
  recipient: string,
  amountRaw: bigint,
): Promise<PreflightIssue | null> {
  if (target.vm === 'svm') {
    return svm.preflight(target, token, recipient as SolanaAddress, amountRaw)
  }
  const check = await evm.getFunderBalance(target, token, amountRaw)
  if (check.sufficient) return null
  return {
    kind: 'insufficient',
    token,
    balance: check.balance,
    needed: amountRaw,
    decimals: check.decimals,
  }
}

function sendToken(
  target: Target,
  token: TokenSymbol,
  recipient: string,
  amountRaw: bigint,
): Promise<SendResult> {
  return target.vm === 'evm'
    ? evm.sendToken(target, token, recipient as Address, amountRaw)
    : svm.sendToken(target, token, recipient as SolanaAddress, amountRaw)
}

const { TxUnconfirmedError } = svm

export type { PreflightIssue, SendResult }
export {
  getFunderAddress,
  getFunderBalance,
  isValidRecipient,
  preflight,
  RECIPIENT_FORMAT,
  sendToken,
  TxUnconfirmedError,
}
