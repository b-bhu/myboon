import assert from 'node:assert/strict'
import test from 'node:test'
import {
  NodeSystemdEgressPolicyInspector,
  parseDeepResearchEgressPolicyVerificationArgs,
  verifyDeepResearchEgressPolicy,
} from './egress-policy-verification'

test('egress parser uses explicit reviewed values or bounded environment policy', () => {
  assert.deepEqual(parseDeepResearchEgressPolicyVerificationArgs([
    '--unit', 'myboon-deep-work_1.service', '--approved-domain', 'API.Example.com.',
    '--allowed-cidr', '203.0.113.0/24',
  ], {}), {
    unitName: 'myboon-deep-work_1.service', approvedDomains: ['api.example.com'], allowedCidrs: ['203.0.113.0/24'],
  })
  assert.deepEqual(parseDeepResearchEgressPolicyVerificationArgs([
    '--unit', 'myboon-deep-work.service',
  ], {
    FEED_V3_DEEP_RESEARCH_APPROVED_DOMAINS: 'example.com',
    FEED_V3_DEEP_RESEARCH_EGRESS_ALLOWED_CIDRS: '2001:db8::/32',
  }).allowedCidrs, ['2001:db8::/32'])
  assert.throws(() => parseDeepResearchEgressPolicyVerificationArgs([]), /Usage/)
  assert.throws(() => parseDeepResearchEgressPolicyVerificationArgs([
    '--unit', 'myboon-deep-work.service', '--unit', 'myboon-deep-other.service',
  ]), /Duplicate/)
})

test('egress verifier passes only complete read-only OS observations and redacts policy values', async () => {
  const report = await verifyDeepResearchEgressPolicy({
    unitName: 'myboon-deep-fixture.service', approvedDomains: ['api.example.com'],
    allowedCidrs: ['203.0.113.0/24'],
    inspector: { inspect: async () => ({
      containmentUnitIdentified: true, outboundDefaultDeny: true,
      allowedCidrsExact: true, domainResolutionBinding: true, errors: [],
    }) },
    now: () => new Date('2026-08-27T00:00:00.000Z'),
  })
  assert.equal(report.readOnly, true)
  assert.equal(report.complete, true)
  assert.equal(report.passed, true)
  assert.doesNotMatch(JSON.stringify(report), /api\.example\.com|203\.0\.113|myboon-deep-fixture/)
})

test('unknown egress observations stay incomplete rather than being guessed clean', async () => {
  const report = await verifyDeepResearchEgressPolicy({
    unitName: 'myboon-deep-fixture.service', approvedDomains: ['api.example.com'], allowedCidrs: [],
    inspector: { inspect: async () => ({
      containmentUnitIdentified: true, outboundDefaultDeny: null,
      allowedCidrsExact: null, domainResolutionBinding: null,
      errors: ['domain_binding_not_verifiable_from_systemd'],
    }) },
  })
  assert.equal(report.complete, false)
  assert.equal(report.passed, false)
  assert.equal(report.checks.outboundDefaultDeny, null)
  assert.ok(report.errors.includes('os_egress_evidence_incomplete'))
})

test('systemd egress adapter performs only a bounded read-only property query', async () => {
  const calls: Array<{ command: string, args: readonly string[] }> = []
  const inspector = new NodeSystemdEgressPolicyInspector((async (command: string, args: readonly string[]) => {
    calls.push({ command, args })
    return {
      stdout: 'LoadState=loaded\nControlGroup=/system.slice/myboon-deep-fixture.service\nIPAddressDeny=any\nIPAddressAllow=203.0.113.0/24\n',
      stderr: '',
    }
  }) as never, 'linux')
  const inspection = await inspector.inspect({
    unitName: 'myboon-deep-fixture.service', approvedDomains: ['api.example.com'],
    allowedCidrs: ['203.0.113.0/24'],
  })
  assert.deepEqual(calls, [{
    command: 'systemctl',
    args: [
      'show', 'myboon-deep-fixture.service',
      '--property=LoadState,ControlGroup,IPAddressDeny,IPAddressAllow', '--no-pager',
    ],
  }])
  assert.equal(inspection.outboundDefaultDeny, true)
  assert.equal(inspection.allowedCidrsExact, true)
  assert.equal(inspection.domainResolutionBinding, null)
})
