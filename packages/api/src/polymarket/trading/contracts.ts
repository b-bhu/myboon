import { providers } from 'ethers'

export const CLOB_HOST = process.env.CLOB_HOST || 'https://clob.polymarket.com'
export const RELAYER_URL = 'https://relayer-v2.polymarket.com'
export const CHAIN_ID = 137
export const POLYGON_RPC = process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'
export const polygonProvider = new providers.JsonRpcProvider(POLYGON_RPC)

export const BUILDER_CODE = '0xda0aa9e10ba50d0077e25e94cf9e4d9ef749821528acf6fc758df962d67b63ed'

export const CONTRACTS = {
  PUSD: '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB',
  USDC_E: '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174',
  COLLATERAL_ONRAMP: '0x93070a847efEf7F70739046A929D47a521F5B8ee',
  COLLATERAL_OFFRAMP: '0x2957922Eb93258b93368531d39fAcCA3B4dC5854',
  CTF_COLLATERAL_ADAPTER: '0xAdA100Db00Ca00073811820692005400218FcE1f',
  NEG_RISK_CTF_COLLATERAL_ADAPTER: '0xadA2005600Dec949baf300f4C6120000bDB6eAab',
  CTF_EXCHANGE_V2: '0xE111180000d2663C0091e4f400237545B87B996B',
  NEG_RISK_CTF_EXCHANGE_V2: '0xe2222d279d744050d28e00520010520000310F59',
  COMBO_EXCHANGE_V3: '0xe3333700cA9d93003F00f0F71f8515005F6c00Aa',
  NEG_RISK_ADAPTER: '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296',
  CTF: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045',
} as const

export const DEPOSIT_WALLET_FACTORY = '0x00000000000Fb5C9ADea0298D729A0CB3823Cc07'
export const DEPOSIT_WALLET_BEACON = '0x7A18EDfe055488A3128f01F563e5B479D92ffc3a'
export const DEPOSIT_WALLET_BATCH_DEADLINE_SECONDS = 60 * 60
export const AUTH_PROOF_MAX_AGE_MS = 5 * 60 * 1000

export const ERC20_APPROVE_ABI = [{
  name: 'approve', type: 'function',
  inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
  outputs: [{ type: 'bool' }],
}] as const

export const ERC1155_SET_APPROVAL_ABI = [{
  name: 'setApprovalForAll', type: 'function',
  inputs: [{ name: 'operator', type: 'address' }, { name: 'approved', type: 'bool' }],
  outputs: [],
}] as const

export const ERC1155_BALANCE_OF_ABI = [{
  name: 'balanceOf', type: 'function',
  inputs: [{ name: 'account', type: 'address' }, { name: 'id', type: 'uint256' }],
  outputs: [{ type: 'uint256' }],
}] as const

export const CTF_PAYOUT_DENOMINATOR_ABI = [{
  name: 'payoutDenominator', type: 'function',
  inputs: [{ name: 'conditionId', type: 'bytes32' }],
  outputs: [{ type: 'uint256' }],
}] as const

export const CTF_GET_COLLECTION_ID_ABI = [{
  name: 'getCollectionId', type: 'function',
  inputs: [
    { name: 'parentCollectionId', type: 'bytes32' },
    { name: 'conditionId', type: 'bytes32' },
    { name: 'indexSet', type: 'uint256' },
  ],
  outputs: [{ type: 'bytes32' }],
}] as const

export const CTF_GET_POSITION_ID_ABI = [{
  name: 'getPositionId', type: 'function',
  inputs: [
    { name: 'collateralToken', type: 'address' },
    { name: 'collectionId', type: 'bytes32' },
  ],
  outputs: [{ type: 'uint256' }],
}] as const

export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as const

export function roundDown(value: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.floor((value + Number.EPSILON) * factor) / factor
}
