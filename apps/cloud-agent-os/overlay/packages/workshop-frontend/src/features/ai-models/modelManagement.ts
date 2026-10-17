import type { AiGatewayInfo } from '@gadgets/workshop-shared/api'

/** Keep subscription controls closed until the deployment policy loads. */
export const isAdminManagedSubscription = () => import.meta.env.VITE_CODEX_BRIDGE_MANAGEMENT === 'admin'

/** Whether the loaded deployment policy offers personal provider configuration. */
export const canAddPersonalModels = (config: AiGatewayInfo | null) =>
  config !== null && (config.enabled ? config.userModelsEnabled : !isAdminManagedSubscription())

/** A shared subscription with personal providers disabled offers model selection only. */
export const isSubscriptionSelectionOnly = (config: AiGatewayInfo | null) =>
  (isAdminManagedSubscription() || (config?.enabled === true && config.transport === 'subscription')) &&
  !canAddPersonalModels(config)
