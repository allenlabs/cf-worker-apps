import type { AiGatewayInfo } from '@gadgets/workshop-shared/api'

/** Build-time labels and loading-state controls for an admin-managed subscription deployment. */
export const isAdminManagedSubscription = () => import.meta.env.VITE_CODEX_BRIDGE_MANAGEMENT === 'admin'

/** Subscription users choose models; the deployment manages their provider. */
export const isSubscriptionSelectionOnly = (config: AiGatewayInfo | null) =>
  isAdminManagedSubscription() || (config?.enabled === true && config.transport === 'subscription')

/** Whether the deployment policy offers personal provider configuration. */
export const canAddPersonalModels = (config: AiGatewayInfo | null) =>
  !isSubscriptionSelectionOnly(config) && (config?.enabled !== true || config.userModelsEnabled)
