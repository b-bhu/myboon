import { SqlitePipelineStore } from './sqlite-store'
import { runPipelineStoreContract } from './store-contract'

runPipelineStoreContract('sqlite', () => new SqlitePipelineStore(':memory:'))
