import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isIP } from 'node:net'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface DeepResearchEgressPolicyInspection {
  containmentUnitIdentified: boolean | null
  outboundDefaultDeny: boolean | null
  allowedCidrsExact: boolean | null
  domainResolutionBinding: boolean | null
  errors: readonly string[]
}

export interface DeepResearchEgressPolicyInspectionPort {
  inspect(input: {
    unitName: string
    approvedDomains: readonly string[]
    allowedCidrs: readonly string[]
  }): Promise<DeepResearchEgressPolicyInspection>
}

export interface DeepResearchEgressPolicyVerificationReport {
  schemaVersion: 'myboon.deep_egress_policy_verification.v1'
  verifiedAt: string
  readOnly: true
  policySha256: string
  unitIdentitySha256: string
  approvedDomainCount: number
  allowedCidrCount: number
  complete: boolean
  passed: boolean
  checks: {
    containmentUnitIdentified: boolean | null
    outboundDefaultDeny: boolean | null
    allowedCidrsExact: boolean | null
    domainResolutionBinding: boolean | null
  }
  errors: string[]
}

export interface DeepResearchEgressPolicyVerificationCommand {
  unitName: string
  approvedDomains: string[]
  allowedCidrs: string[]
}

export function parseDeepResearchEgressPolicyVerificationArgs(
  argv: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): DeepResearchEgressPolicyVerificationCommand {
  let unitName: string | undefined
  const approvedDomains: string[] = []
  const allowedCidrs: string[] = []
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]?.trim()
    if (!flag || !['--unit', '--approved-domain', '--allowed-cidr'].includes(flag) || !value) {
      throw new Error(egressUsage())
    }
    if (flag === '--unit') {
      if (unitName) throw new Error('Duplicate --unit flag')
      unitName = value
    } else if (flag === '--approved-domain') approvedDomains.push(value)
    else allowedCidrs.push(value)
  }
  if (!unitName) throw new Error(egressUsage())
  const domains = approvedDomains.length > 0 ? approvedDomains : csv(processEnv(env, 'FEED_V3_DEEP_RESEARCH_APPROVED_DOMAINS'))
  const cidrs = allowedCidrs.length > 0 ? allowedCidrs : csv(processEnv(env, 'FEED_V3_DEEP_RESEARCH_EGRESS_ALLOWED_CIDRS'))
  if (domains.length > 128 || cidrs.length > 512) throw new Error('Deep egress policy input is unbounded')
  return {
    unitName: validateUnitName(unitName),
    approvedDomains: [...new Set(domains.map(validateDomain))].sort(),
    allowedCidrs: [...new Set(cidrs.map(validateCidr))].sort(),
  }
}

/**
 * Evaluates observations supplied by a read-only OS adapter. Null means the OS
 * evidence could not prove the claim; it is never promoted to a guessed pass.
 */
export async function verifyDeepResearchEgressPolicy(input: {
  unitName: string
  approvedDomains: readonly string[]
  allowedCidrs: readonly string[]
  inspector: DeepResearchEgressPolicyInspectionPort
  now?: () => Date
}): Promise<DeepResearchEgressPolicyVerificationReport> {
  validateUnitName(input.unitName)
  const approvedDomains = [...new Set(input.approvedDomains.map(validateDomain))].sort()
  const allowedCidrs = [...new Set(input.allowedCidrs.map(validateCidr))].sort()
  let inspection: DeepResearchEgressPolicyInspection
  try {
    inspection = await input.inspector.inspect({ unitName: input.unitName, approvedDomains, allowedCidrs })
  } catch {
    inspection = {
      containmentUnitIdentified: null, outboundDefaultDeny: null,
      allowedCidrsExact: null, domainResolutionBinding: null,
      errors: ['os_egress_inspection_failed'],
    }
  }
  const checks = {
    containmentUnitIdentified: observation(inspection.containmentUnitIdentified),
    outboundDefaultDeny: observation(inspection.outboundDefaultDeny),
    allowedCidrsExact: observation(inspection.allowedCidrsExact),
    domainResolutionBinding: observation(inspection.domainResolutionBinding),
  }
  const complete = Object.values(checks).every((value) => value !== null)
  const errors = [...new Set([
    ...inspection.errors.map(redactedErrorCode),
    ...(complete ? [] : ['os_egress_evidence_incomplete']),
    ...(checks.containmentUnitIdentified === false ? ['containment_unit_not_identified'] : []),
    ...(checks.outboundDefaultDeny === false ? ['outbound_default_deny_not_verified'] : []),
    ...(checks.allowedCidrsExact === false ? ['allowed_cidrs_do_not_match'] : []),
    ...(checks.domainResolutionBinding === false ? ['domain_resolution_binding_not_verified'] : []),
  ])]
  return {
    schemaVersion: 'myboon.deep_egress_policy_verification.v1',
    verifiedAt: (input.now?.() ?? new Date()).toISOString(),
    readOnly: true,
    policySha256: sha256(stableJson({ approvedDomains, allowedCidrs })),
    unitIdentitySha256: sha256(input.unitName),
    approvedDomainCount: approvedDomains.length,
    allowedCidrCount: allowedCidrs.length,
    complete,
    passed: complete && Object.values(checks).every((value) => value === true),
    checks,
    errors,
  }
}

/** Read-only systemd property adapter. It never starts, stops, or changes a unit. */
export class NodeSystemdEgressPolicyInspector implements DeepResearchEgressPolicyInspectionPort {
  constructor(
    private readonly execFileImpl: typeof execFileAsync = execFileAsync,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async inspect(input: {
    unitName: string
    approvedDomains: readonly string[]
    allowedCidrs: readonly string[]
  }): Promise<DeepResearchEgressPolicyInspection> {
    if (this.platform !== 'linux') return unknownInspection('unsupported_platform')
    let properties: Map<string, string>
    try {
      const { stdout } = await this.execFileImpl('systemctl', [
        'show', input.unitName,
        '--property=LoadState,ControlGroup,IPAddressDeny,IPAddressAllow',
        '--no-pager',
      ], { maxBuffer: 64_000 })
      properties = new Map(stdout.split('\n').flatMap((line) => {
        const separator = line.indexOf('=')
        return separator < 1 ? [] : [[line.slice(0, separator), line.slice(separator + 1)] as [string, string]]
      }))
    } catch { return unknownInspection('systemd_egress_properties_unavailable') }
    const loaded = properties.get('LoadState')
    const controlGroup = properties.get('ControlGroup')
    const deny = words(properties.get('IPAddressDeny'))
    const allow = words(properties.get('IPAddressAllow')).sort()
    const expected = [...input.allowedCidrs].sort()
    const errors: string[] = []
    const domainResolutionBinding = input.approvedDomains.length === 0 ? true : null
    if (domainResolutionBinding === null) errors.push('domain_binding_not_verifiable_from_systemd')
    const allowedCidrsExact = !properties.has('IPAddressAllow')
      ? null
      : expected.length === 0 && input.approvedDomains.length > 0
        ? null
        : allow.length === expected.length && allow.every((value, index) => value === expected[index])
    if (allowedCidrsExact === null) errors.push('allowed_cidrs_not_supplied')
    return {
      containmentUnitIdentified: loaded === undefined || controlGroup === undefined ? null : loaded === 'loaded' && controlGroup.startsWith('/'),
      outboundDefaultDeny: properties.has('IPAddressDeny') ? deny.includes('any') : null,
      allowedCidrsExact,
      domainResolutionBinding,
      errors,
    }
  }
}

function unknownInspection(error: string): DeepResearchEgressPolicyInspection {
  return {
    containmentUnitIdentified: null, outboundDefaultDeny: null,
    allowedCidrsExact: null, domainResolutionBinding: null, errors: [error],
  }
}

function observation(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

function redactedErrorCode(value: string): string {
  return /^[a-z0-9_]{1,80}$/.test(value) ? value : 'os_egress_inspection_reported_error'
}

function validateDomain(value: string): string {
  const domain = value.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253 || isIP(domain) !== 0 || domain === 'localhost'
    || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)) {
    throw new Error('Deep egress approved domain is invalid')
  }
  return domain
}

function validateUnitName(value: string): string {
  if (!/^myboon-deep-[a-z0-9_.-]+\.service$/.test(value)) throw new Error('Deep egress unit name is invalid')
  return value
}

function validateCidr(value: string): string {
  const candidate = value.trim().toLowerCase()
  const match = /^([^/]+)\/(\d+)$/.exec(candidate)
  const family = match ? isIP(match[1]!) : 0
  const prefix = match ? Number(match[2]) : -1
  if (!family || !Number.isInteger(prefix) || prefix < 0 || prefix > (family === 4 ? 32 : 128)) {
    throw new Error('Deep egress allowed CIDR is invalid')
  }
  return candidate
}

function words(value: string | undefined): string[] {
  return value?.trim() ? value.trim().split(/\s+/).filter(Boolean) : []
}

function csv(value: string | undefined): string[] {
  return value?.split(',').map((item) => item.trim()).filter(Boolean) ?? []
}

function processEnv(env: Readonly<Record<string, string | undefined>>, name: string): string | undefined {
  const value = env[name]
  if (value !== undefined && (value.length > 32_000 || value.includes('\0'))) throw new Error('Deep egress policy input is unsafe')
  return value
}

function egressUsage(): string {
  return 'Usage: feed-v3:verify-deep-egress-policy --unit myboon-deep-....service [--approved-domain example.com] [--allowed-cidr 203.0.113.0/24]'
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
