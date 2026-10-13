import { createModels } from '@earendil-works/pi-ai'
import { vercelAIGatewayProvider } from '@earendil-works/pi-ai/providers/vercel-ai-gateway'

// defaultProvider identifies the only supported production gateway.
export const defaultProvider = 'vercel-ai-gateway'

// gatewayModels registers the bundled Vercel chat and classifier catalogs with their native transports.
export function gatewayModels () {
  const models = createModels()
  models.setProvider(vercelAIGatewayProvider())
  return models
}
