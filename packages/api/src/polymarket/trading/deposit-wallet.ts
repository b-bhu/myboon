import {
  concatHex,
  encodeAbiParameters,
  getCreate2Address,
  keccak256,
  padHex,
  toHex,
  type Address,
  type Hex,
} from 'viem'
import { DEPOSIT_WALLET_BEACON, DEPOSIT_WALLET_FACTORY } from './contracts.js'

// Solady's ERC1967 beacon-proxy creation bytecode. These values and their
// ordering mirror Polymarket's deriveBeaconDepositWalletAddress implementation.
const ERC1967_BEACON_CONST1 =
  '0xb3582b35133d50545afa5036515af43d6000803e604d573d6000fd5b3d6000f3' as Hex
const ERC1967_BEACON_CONST2 =
  '0x1b60e01b36527fa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6c' as Hex
const ERC1967_BEACON_CONST3 =
  '0x60195155f3363d3d373d3d363d602036600436635c60da' as Hex
const ERC1967_BEACON_PREFIX = 0x6100523d8160233d3973n

/** Derive the current type-3 Deposit Wallet for an authenticated signer. */
export function deriveBeaconDepositWalletAddress(signer: string): Address {
  const walletId = padHex(signer as Address, { size: 32 })
  const args = encodeAbiParameters(
    [{ type: 'address' }, { type: 'bytes32' }],
    [DEPOSIT_WALLET_FACTORY, walletId],
  )
  const argsByteLength = BigInt((args.length - 2) / 2)
  const prefix = toHex(
    ERC1967_BEACON_PREFIX + (argsByteLength << 56n),
    { size: 10 },
  )
  const bytecodeHash = keccak256(concatHex([
    prefix,
    DEPOSIT_WALLET_BEACON,
    ERC1967_BEACON_CONST3,
    ERC1967_BEACON_CONST2,
    ERC1967_BEACON_CONST1,
    args,
  ]))

  return getCreate2Address({
    from: DEPOSIT_WALLET_FACTORY,
    salt: keccak256(args),
    bytecodeHash,
  })
}

export function isDeployedContractCode(code: string | null | undefined): boolean {
  return !!code && !/^0x0*$/iu.test(code)
}
