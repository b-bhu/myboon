import assert from 'node:assert/strict'
import test from 'node:test'
import { polymarketResearcherCliConfig } from './run-researcher'

test('polymarket researcher CLI config separates one-shot and daemon interval settings', () => {
  assert.deepEqual(polymarketResearcherCliConfig({
    POLYMARKET_RESEARCHER_RUN_ONCE: '1',
    POLYMARKET_RESEARCHER_INTERVAL_MS: '45000',
  }), {
    runOnce: true,
    intervalMs: 45_000,
    researchPlannerHermesToolsets: 'browser',
    researchGateClassificationEnabled: true,
  })

  assert.deepEqual(polymarketResearcherCliConfig({
    POLYMARKET_RESEARCHER_RUN_ONCE: '0',
    POLYMARKET_RESEARCHER_INTERVAL_MS: 'invalid',
  }), {
    runOnce: false,
    intervalMs: 300_000,
    researchPlannerHermesToolsets: 'browser',
    researchGateClassificationEnabled: true,
  })
})

test('polymarket researcher can restore the legacy Hermes gate without constructing classification', () => {
  assert.equal(polymarketResearcherCliConfig({
    RESEARCH_GATE_CLASSIFICATION_DISABLED: '1',
  }).researchGateClassificationEnabled, false)
})

test('polymarket researcher CLI config pins and trims planner toolsets', () => {
  assert.equal(polymarketResearcherCliConfig({
    POLYMARKET_RESEARCH_PLANNER_HERMES_TOOLSETS: ' browser, custom ',
  }).researchPlannerHermesToolsets, 'browser,custom')
})
