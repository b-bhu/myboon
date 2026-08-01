import { loadDotenvChain } from '../pipeline-store/cli-env'

loadDotenvChain()

import { summarizeHyperliquidSqlite } from './sqlite-store'

const summary = summarizeHyperliquidSqlite(process.env.HYPERLIQUID_SQLITE_PATH)
console.log(JSON.stringify(summary, null, 2))
