import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  createDefaultRpcTransport,
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  isAddress,
  isSolanaError,
  type KeyPairSigner,
  lamports,
  pipe,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from '@solana/kit'
import { getTransferSolInstruction } from '@solana-program/system'
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token'
import type { SvmTarget } from './chains'
import { resolveToken, type TokenSymbol } from './tokens'

const TOKEN_2022_PROGRAM_ADDRESS = address(
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
)
const TOKEN_ACCOUNT_SIZE = 165n
// Base fee is 5000 lamports per signature; padded so a fee bump never fails a
// send that the balance check approved.
const FEE_BUFFER_LAMPORTS = 20_000n
const CONFIRM_TIMEOUT_MS = 60_000

const DEFAULT_RPC: Record<SvmTarget['cluster'], string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
}

const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const MAX_RETRIES = 5

// Public Solana RPCs rate-limit aggressively; retrying is safe for every call we
// make, including sendTransaction (same signed bytes, deduplicated by signature).
function createRetryingTransport(url: string) {
  const inner = createDefaultRpcTransport({ url })
  const transport: typeof inner = async (config) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await inner(config)
      } catch (err) {
        if (
          attempt >= MAX_RETRIES ||
          !isSolanaError(err, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) ||
          !RETRYABLE_STATUS.has(err.context.statusCode)
        ) {
          throw err
        }
        const retryAfter = Number(err.context.headers.get('retry-after'))
        await Bun.sleep(retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt)
      }
    }
  }
  return transport
}

function createRpc(url: string) {
  return createSolanaRpcFromTransport(createRetryingTransport(url))
}

type Rpc = ReturnType<typeof createRpc>

const rpcByChain = new Map<number, Rpc>()

function getRpc(target: SvmTarget): Rpc {
  let rpc = rpcByChain.get(target.chainId)
  if (!rpc) {
    rpc = createRpc(
      process.env[`RPC_URL_${target.chainId}`] ?? DEFAULT_RPC[target.cluster],
    )
    rpcByChain.set(target.chainId, rpc)
  }
  return rpc
}

// Mint owners and rent minimums don't change for the lifetime of the process.
const tokenProgramByMint = new Map<Address, Address>()
const rentBySize = new Map<bigint, bigint>()

async function getRentExempt(rpc: Rpc, size: bigint): Promise<bigint> {
  let rent = rentBySize.get(size)
  if (rent === undefined) {
    rent = await rpc.getMinimumBalanceForRentExemption(size).send()
    rentBySize.set(size, rent)
  }
  return rent
}

class TxUnconfirmedError extends Error {
  constructor(
    public readonly txHash: string,
    public readonly blockExplorerUrl: string,
    cause: unknown,
  ) {
    super(
      `Transaction ${txHash} was broadcast but its outcome is unknown: ${(cause as Error).message}`,
    )
  }
}

let signerPromise: Promise<KeyPairSigner> | undefined

// Accepts a base58 64-byte secret key (Phantom export) or the JSON byte array
// written by `solana-keygen`.
function getSolanaSigner(): Promise<KeyPairSigner> {
  if (!signerPromise) {
    const raw = process.env.SOLANA_FUNDING_PRIVATE_KEY?.trim()
    if (!raw) {
      return Promise.reject(new Error('SOLANA_FUNDING_PRIVATE_KEY is not set'))
    }
    const bytes = raw.startsWith('[')
      ? new Uint8Array(JSON.parse(raw) as number[])
      : new Uint8Array(getBase58Encoder().encode(raw))
    signerPromise = createKeyPairSignerFromBytes(bytes)
    signerPromise.catch(() => {
      signerPromise = undefined
    })
  }
  return signerPromise
}

function isSolanaAddress(value: string): boolean {
  return isAddress(value)
}

interface SplContext {
  mint: Address
  decimals: number
  tokenProgram: Address
  funderAta: Address
  recipientAta?: Address
}

async function getSplContext(
  rpc: Rpc,
  mint: Address,
  decimals: number,
  funder: Address,
  recipient?: Address,
): Promise<SplContext> {
  let tokenProgram = tokenProgramByMint.get(mint)
  if (!tokenProgram) {
    const mintInfo = await rpc
      .getAccountInfo(mint, { encoding: 'base64', commitment: 'confirmed' })
      .send()
    if (!mintInfo.value) throw new Error(`Mint ${mint} not found`)
    tokenProgram = mintInfo.value.owner
    tokenProgramByMint.set(mint, tokenProgram)
  }
  const [funderAta] = await findAssociatedTokenPda({
    owner: funder,
    mint,
    tokenProgram,
  })
  const recipientAta = recipient
    ? (
        await findAssociatedTokenPda({ owner: recipient, mint, tokenProgram })
      )[0]
    : undefined
  return { mint, decimals, tokenProgram, funderAta, recipientAta }
}

async function getTokenBalance(rpc: Rpc, ata: Address): Promise<bigint> {
  const info = await rpc
    .getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' })
    .send()
  if (!info.value) return 0n
  const res = await rpc
    .getTokenAccountBalance(ata, { commitment: 'confirmed' })
    .send()
  return BigInt(res.value.amount)
}

async function getSolBalance(rpc: Rpc, owner: Address): Promise<bigint> {
  const res = await rpc.getBalance(owner, { commitment: 'confirmed' }).send()
  return res.value
}

async function getFunderAddress(): Promise<Address> {
  return (await getSolanaSigner()).address
}

async function getFunderBalance(
  target: SvmTarget,
  token: TokenSymbol,
): Promise<{ balance: bigint; decimals: number }> {
  const rpc = getRpc(target)
  const funder = await getFunderAddress()
  const resolved = resolveToken(token, target)
  if (resolved.kind === 'native') {
    return {
      balance: await getSolBalance(rpc, funder),
      decimals: resolved.decimals,
    }
  }
  if (resolved.kind !== 'spl') throw new Error('ERC20 token on Solana')
  const ctx = await getSplContext(rpc, resolved.mint, resolved.decimals, funder)
  return {
    balance: await getTokenBalance(rpc, ctx.funderAta),
    decimals: resolved.decimals,
  }
}

type PreflightIssue =
  | {
      kind: 'insufficient'
      token: TokenSymbol
      balance: bigint
      needed: bigint
      decimals: number
    }
  | { kind: 'invalid_recipient'; problem: string; hint: string }

// Everything the funder must hold for the send to land: the amount, fees, and
// rent for a recipient token account the faucet has to create.
async function preflight(
  target: SvmTarget,
  token: TokenSymbol,
  recipient: Address,
  amountRaw: bigint,
): Promise<PreflightIssue | null> {
  const rpc = getRpc(target)
  const funder = await getFunderAddress()
  const resolved = resolveToken(token, target)
  const [solBalance, recipientInfo, rentBase] = await Promise.all([
    getSolBalance(rpc, funder),
    rpc
      .getAccountInfo(recipient, {
        encoding: 'base64',
        commitment: 'confirmed',
      })
      .send(),
    getRentExempt(rpc, 0n),
  ])
  const recipientOwner = recipientInfo.value?.owner
  if (
    recipientOwner === TOKEN_PROGRAM_ADDRESS ||
    recipientOwner === TOKEN_2022_PROGRAM_ADDRESS
  ) {
    return {
      kind: 'invalid_recipient',
      problem: 'recipient is a token account, not a wallet',
      hint: 'Pass the wallet (owner) address; the faucet derives the associated token account itself.',
    }
  }

  // The funder must stay rent-exempt after paying, or the runtime rejects the tx.
  let solNeeded = FEE_BUFFER_LAMPORTS + rentBase

  if (resolved.kind === 'native') {
    if (!recipientInfo.value && amountRaw < rentBase) {
      return {
        kind: 'invalid_recipient',
        problem: `recipient account does not exist and ${amountRaw} lamports is below the rent-exempt minimum (${rentBase})`,
        hint: `Send at least ${Number(rentBase) / 1e9} SOL to a fresh wallet.`,
      }
    }
    solNeeded += amountRaw
    if (solBalance < solNeeded) {
      return {
        kind: 'insufficient',
        token: 'SOL',
        balance: solBalance,
        needed: solNeeded,
        decimals: resolved.decimals,
      }
    }
    return null
  }

  if (resolved.kind !== 'spl') throw new Error('ERC20 token on Solana')
  const ctx = await getSplContext(
    rpc,
    resolved.mint,
    resolved.decimals,
    funder,
    recipient,
  )
  const [tokenBalance, recipientAtaInfo] = await Promise.all([
    getTokenBalance(rpc, ctx.funderAta),
    rpc
      .getAccountInfo(ctx.recipientAta!, {
        encoding: 'base64',
        commitment: 'confirmed',
      })
      .send(),
  ])
  if (tokenBalance < amountRaw) {
    return {
      kind: 'insufficient',
      token,
      balance: tokenBalance,
      needed: amountRaw,
      decimals: resolved.decimals,
    }
  }
  if (!recipientAtaInfo.value) {
    solNeeded += await getRentExempt(rpc, TOKEN_ACCOUNT_SIZE)
  }
  if (solBalance < solNeeded) {
    return {
      kind: 'insufficient',
      token: 'SOL',
      balance: solBalance,
      needed: solNeeded,
      decimals: 9,
    }
  }
  return null
}

interface SolanaSendResult {
  txHash: string
  blockExplorerUrl: string
  ataCreated?: boolean
}

async function sendToken(
  target: SvmTarget,
  token: TokenSymbol,
  recipient: Address,
  amountRaw: bigint,
): Promise<SolanaSendResult> {
  const rpc = getRpc(target)
  const signer = await getSolanaSigner()
  const resolved = resolveToken(token, target)

  const instructions: Instruction[] = []
  let ataCreated: boolean | undefined
  if (resolved.kind === 'native') {
    instructions.push(
      getTransferSolInstruction({
        source: signer,
        destination: recipient,
        amount: lamports(amountRaw),
      }),
    )
  } else if (resolved.kind === 'spl') {
    const ctx = await getSplContext(
      rpc,
      resolved.mint,
      resolved.decimals,
      signer.address,
      recipient,
    )
    const ata = ctx.recipientAta!
    const ataInfo = await rpc
      .getAccountInfo(ata, { encoding: 'base64', commitment: 'confirmed' })
      .send()
    ataCreated = !ataInfo.value
    if (ataCreated) {
      // Idempotent, so a concurrent creation between check and send is harmless.
      instructions.push(
        getCreateAssociatedTokenIdempotentInstruction({
          payer: signer,
          ata,
          owner: recipient,
          mint: ctx.mint,
          tokenProgram: ctx.tokenProgram,
        }),
      )
    }
    instructions.push(
      getTransferCheckedInstruction(
        {
          source: ctx.funderAta,
          mint: ctx.mint,
          destination: ata,
          authority: signer,
          amount: amountRaw,
          decimals: ctx.decimals,
        },
        { programAddress: ctx.tokenProgram },
      ),
    )
  } else {
    throw new Error('ERC20 token on Solana')
  }

  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: 'confirmed' })
    .send()
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  )
  const signed = await signTransactionMessageWithSigners(message)
  const signature = getSignatureFromTransaction(signed)
  const cluster = target.cluster === 'devnet' ? '?cluster=devnet' : ''
  const blockExplorerUrl = `https://explorer.solana.com/tx/${signature}${cluster}`

  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send()
  try {
    await waitForConfirmation(rpc, signature, blockhash.lastValidBlockHeight)
  } catch (err) {
    if (err instanceof TxDefinitelyFailedError) throw err
    throw new TxUnconfirmedError(signature, blockExplorerUrl, err)
  }

  return {
    txHash: signature,
    blockExplorerUrl,
    ...(ataCreated !== undefined ? { ataCreated } : {}),
  }
}

// Thrown only when the chain says the tx failed or can no longer land.
class TxDefinitelyFailedError extends Error {}

const POLL_INTERVAL_MS = 2000
const BLOCK_HEIGHT_CHECK_EVERY = 5

// Polling instead of a websocket subscription keeps a single HTTP RPC URL
// sufficient for overrides.
async function waitForConfirmation(
  rpc: Rpc,
  signature: ReturnType<typeof getSignatureFromTransaction>,
  lastValidBlockHeight: bigint,
): Promise<void> {
  const deadline = Date.now() + CONFIRM_TIMEOUT_MS
  for (let i = 1; Date.now() < deadline; i++) {
    await Bun.sleep(POLL_INTERVAL_MS)
    const { value } = await rpc.getSignatureStatuses([signature]).send()
    const status = value[0]
    if (status?.err) {
      throw new TxDefinitelyFailedError(
        `Transaction ${signature} failed: ${JSON.stringify(status.err, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`,
      )
    }
    if (
      status?.confirmationStatus === 'confirmed' ||
      status?.confirmationStatus === 'finalized'
    ) {
      return
    }
    if (i % BLOCK_HEIGHT_CHECK_EVERY === 0) {
      const height = await rpc
        .getBlockHeight({ commitment: 'confirmed' })
        .send()
      if (height > lastValidBlockHeight) {
        throw new TxDefinitelyFailedError(
          `Transaction ${signature} expired before confirmation`,
        )
      }
    }
  }
  throw new Error(`Transaction ${signature} not confirmed within 60s`)
}

export type { PreflightIssue, SolanaSendResult }
export {
  getFunderAddress,
  getFunderBalance,
  isSolanaAddress,
  preflight,
  sendToken,
  TxUnconfirmedError,
}
