import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOperatorCommand } from './run-operation'

test('operator commands require an explicit actor and exact operation', () => {
  assert.deepEqual(parseOperatorCommand(['approve', 'finding-1', 'ceo-review']), {
    kind: 'approve', findingId: 'finding-1', actor: 'ceo-review',
  })
  assert.deepEqual(parseOperatorCommand(['rollback-alias', 'operation-1', 'cto']), {
    kind: 'rollback-alias', operationId: 'operation-1', actor: 'cto',
  })
  assert.deepEqual(parseOperatorCommand(['apply-merge', 'finding-1', 'agent']), {
    kind: 'apply-merge', findingId: 'finding-1', actor: 'agent',
  })
  assert.deepEqual(parseOperatorCommand(['rollback-merge', 'operation-2', 'cto']), {
    kind: 'rollback-merge', operationId: 'operation-2', actor: 'cto',
  })
  assert.throws(() => parseOperatorCommand(['approve', 'finding-1']), /Usage/)
  assert.throws(() => parseOperatorCommand(['delete', 'finding-1', 'agent']), /Unsupported/)
})
