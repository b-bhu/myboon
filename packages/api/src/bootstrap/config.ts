export type ApiConfig = {
  supabaseUrl: string
  supabaseServiceRoleKey: string
  internalDashboardToken?: string
  internalEntityWriteToken?: string
  internalPolymarketCatalogWriteToken?: string
  port: number
  host: string
  aiExplanationProvider: string
  aiExplanationApiKey?: string
  aiExplanationBaseUrl: string
  aiExplanationModel: string
  tokenIdentityEnabled: boolean
  tokensApiKey?: string
  jupApiKey?: string
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const supabaseUrl = env.SUPABASE_URL
  const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY
  const missing: string[] = []
  if (!supabaseUrl) missing.push('SUPABASE_URL')
  if (!supabaseServiceRoleKey) missing.push('SUPABASE_SERVICE_ROLE_KEY')

  if (missing.length > 0) {
    console.error(`[api] Missing required env vars: ${missing.join(', ')}`)
    process.exit(1)
  }

  const aiExplanationProvider = env.AI_EXPLANATION_PROVIDER
    ?? (env.MINIMAX_API_KEY ? 'minimax' : (env.OPENAI_API_KEY ? 'openai' : 'xai'))
  const aiExplanationApiKey = env.AI_EXPLANATION_API_KEY
    ?? (aiExplanationProvider === 'minimax' ? env.MINIMAX_API_KEY : undefined)
    ?? env.OPENAI_API_KEY
    ?? env.XAI_API_KEY
  const aiExplanationBaseUrl = env.AI_EXPLANATION_BASE_URL
    ?? (aiExplanationProvider === 'minimax'
      ? 'https://api.minimax.io/anthropic/v1'
      : (env.OPENAI_API_KEY ? 'https://api.openai.com/v1' : 'https://api.x.ai/v1'))
  const aiExplanationModel = env.AI_EXPLANATION_MODEL
    ?? (aiExplanationProvider === 'minimax'
      ? (env.CLASSIFIER_MODEL ?? 'MiniMax-M2.7-lightning')
      : (env.OPENAI_API_KEY ? 'gpt-4o-mini' : (env.XAI_MODEL ?? 'grok-3-mini')))

  const tokenIdentityEnabled = env.TOKEN_IDENTITY_ENABLED === '1' || env.TOKEN_IDENTITY_ENABLED === 'true'

  return {
    supabaseUrl: supabaseUrl!,
    supabaseServiceRoleKey: supabaseServiceRoleKey!,
    internalDashboardToken: env.INTERNAL_DASHBOARD_TOKEN,
    internalEntityWriteToken: env.INTERNAL_ENTITY_WRITE_TOKEN,
    internalPolymarketCatalogWriteToken: env.INTERNAL_POLYMARKET_CATALOG_WRITE_TOKEN,
    port: parseInt(env.PORT ?? '3000', 10),
    host: env.HOST ?? '0.0.0.0',
    aiExplanationProvider,
    aiExplanationApiKey,
    aiExplanationBaseUrl,
    aiExplanationModel,
    tokenIdentityEnabled,
    tokensApiKey: env.TOKENS_API_KEY,
    jupApiKey: env.JUP_API_KEY,
  }
}
