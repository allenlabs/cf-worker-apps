import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type {
  AiChatAuthorInfo,
  AiModelProvider,
  AgentProviderCatalog,
  GatewayModelMode,
} from "@gadgets/workshop-shared/api";
import { z } from "zod";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "./storage-schema/user-storage.js";

type SubscriptionEnvironment = {
  CODEX_BRIDGE_MANAGEMENT?: string;
  CODEX_BRIDGE_SETUP?: string;
  CODEX_BRIDGE?: { subscriptionConnections(): Promise<unknown>; subscriptionModels?(): Promise<unknown> };
  CODEX_BRIDGE_MODEL?: string;
  CODEX_BRIDGE_ALLOWED_USER_IDS?: string;
};

/** Whether the deployment explicitly delegates its fixed subscription catalog to admins. */
export function isAdminManagedSubscription(env: Cloudflare.Env & SubscriptionEnvironment): boolean {
  return env.CODEX_BRIDGE_MANAGEMENT === "admin";
}

export const subscriptionAccountIdSchema = z.union([
  z.literal("owner"),
  z.string().regex(/^account-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
]);
const subscriptionConnectionsSchema = z.array(z.object({
  id: subscriptionAccountIdSchema,
  label: z.string().trim().min(1).max(128).refine(value => new TextEncoder().encode(value).length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/.test(value)),
  provider: z.enum(["siwc", "codex"]),
  ready: z.boolean(),
}).strict()).min(1).max(20).refine(connections =>
  connections.some(connection => connection.id === "owner") &&
  new Set(connections.map(connection => connection.id)).size === connections.length,
);
const subscriptionCatalogSchema = z.object({
  source: z.literal("bundled-provider-catalog"),
  entitlementVerified: z.literal(false),
  connections: z.array(subscriptionConnectionsSchema.element.extend({
    models: z.array(z.object({
      id: z.string().regex(/^[a-zA-Z0-9._-]{1,128}$/),
      name: z.string().trim().min(1).max(256).refine(value => !/[\u0000-\u001f\u007f-\u009f]/.test(value)),
    }).strict()).max(2048).refine(models => new Set(models.map(model => model.id)).size === models.length),
  }).strict()).min(1).max(20),
}).strict();
export type SubscriptionConnections = (z.infer<typeof subscriptionConnectionsSchema>[number] & {
  catalog?: { source: z.infer<typeof subscriptionCatalogSchema>["source"]; entitlementVerified: false;
    models: z.infer<typeof subscriptionCatalogSchema>["connections"][number]["models"] };
})[];

/** Parse the private binding's safe catalog without granting model access to its caller. */
export async function readSubscriptionConnections(env: Cloudflare.Env & SubscriptionEnvironment): Promise<SubscriptionConnections | undefined> {
  if (env.CODEX_BRIDGE_SETUP !== "siwc") return undefined;
  if (!env.CODEX_BRIDGE) throw new Error("inference_bridge_not_configured");
  const connections = subscriptionConnectionsSchema.parse(await env.CODEX_BRIDGE.subscriptionConnections());
  if (typeof env.CODEX_BRIDGE.subscriptionModels !== "function") return connections;
  const catalog = subscriptionCatalogSchema.parse(await env.CODEX_BRIDGE.subscriptionModels());
  if (catalog.connections.length !== connections.length || catalog.connections.some(row => {
    const connection = connections.find(connection => connection.id === row.id);
    return !connection || connection.label !== row.label || connection.provider !== row.provider || connection.ready !== row.ready;
  }) || new Set(catalog.connections.map(row => row.id)).size !== connections.length)
    throw new Error("inference_bridge_catalog_changed");
  return catalog.connections.map(({ models, ...connection }) => ({ ...connection, catalog: {
    source: catalog.source, entitlementVerified: catalog.entitlementVerified, models,
  } }));
}

/** A credential-free catalog; the bridge retains account and inference authority. */
export class SubscriptionModels {
  readonly transport = "subscription";
  readonly providers: ReadonlySet<AiModelProvider> = new Set(["openai"]);
  readonly userModels: boolean;
  readonly setupUrl?: string;
  readonly all: readonly { id: string; name: string; providerDisplayName: string; provider: "openai"; mode: GatewayModelMode;
    accountId: string; subscriptionProvider: SubscriptionConnections[number]["provider"] | null; ready: boolean | null }[];
  readonly catalog: readonly (SubscriptionModels["all"][number] & {
    modelId: string; catalogSource?: "bundled-provider-catalog"; entitlementVerified?: false;
  })[];
  readonly #selectable: boolean;
  readonly #authorized: boolean;

  constructor(
    env: Cloudflare.Env & SubscriptionEnvironment,
    config: Pick<AdminConfig, "modelModes" | "userModelsEnabled"> & Partial<Pick<AdminConfig, "modelDisplayNames">>,
    userId: string | undefined,
    connections: SubscriptionConnections | undefined,
  ) {
    if (!isAdminManagedSubscription(env))
      throw new Error("This subscription is not admin-managed.");
    const catalog = Object.values(OPENAI_CODEX_MODELS).find(
      (model) => model.id === env.CODEX_BRIDGE_MODEL,
    );
    let users: unknown;
    try {
      users = JSON.parse(env.CODEX_BRIDGE_ALLOWED_USER_IDS || "");
    } catch {
      throw new Error("inference_bridge_not_configured");
    }
    const allowed = z
      .array(z.email().refine((value) => value === value.toLowerCase()))
      .min(1)
      .max(20)
      .safeParse(users);
    if (!env.CODEX_BRIDGE || !catalog || !allowed.success)
      throw new Error("inference_bridge_not_configured");
    this.userModels = config.userModelsEnabled;
    this.setupUrl = env.CODEX_BRIDGE_SETUP === "siwc" ? "/gatekeeper/subscription" : undefined;
    this.#authorized = userId !== undefined && allowed.data.includes(userId);
    this.#selectable = connections !== undefined;
    this.all = (connections ?? [{ id: "owner", label: "Codex subscription", provider: null, ready: null }]).map(connection => {
      const id = connection.id === "owner" ? catalog.id : `subscription-${connection.id}`;
      const mode = Object.hasOwn(config.modelModes, id) ? config.modelModes[id] : "enabled";
      return { id, name: config.modelDisplayNames && Object.hasOwn(config.modelDisplayNames, id)
          ? config.modelDisplayNames[id] : connection.label,
        providerDisplayName: connection.label, provider: "openai", mode, accountId: connection.id,
        subscriptionProvider: connection.provider, ready: connection.ready };
    });
    this.catalog = this.all.flatMap(connection => {
      const metadata = connections?.find(row => row.id === connection.accountId)?.catalog;
      const choices: SubscriptionModels["catalog"][number][] = [{ ...connection, modelId: catalog.id,
        ...(metadata ? { catalogSource: metadata.source, entitlementVerified: metadata.entitlementVerified } : {}) }];
      if (!metadata) return choices;
      for (const physical of metadata.models) {
        if (physical.id === env.CODEX_BRIDGE_MODEL) continue;
        const id = `subscription-model:${connection.accountId}:${connection.subscriptionProvider}:${physical.id}`;
        const mode = connection.mode === "disabled" ? "disabled" : Object.hasOwn(config.modelModes, id)
          ? config.modelModes[id] : connection.mode;
        choices.push({ ...connection, id, modelId: physical.id, mode,
          name: config.modelDisplayNames && Object.hasOwn(config.modelDisplayNames, id)
            ? config.modelDisplayNames[id] : `${connection.name} · ${physical.name}`,
          catalogSource: metadata.source, entitlementVerified: metadata.entitlementVerified });
      }
      return choices;
    });
  }

  get(id: string) {
    return this.catalog.find((model) => model.id === id);
  }

  list(): AiChatAuthorInfo[] {
    if (!this.#authorized) return [];
    return this.catalog
      .filter((model) => model.mode === "enabled")
      .map(({ id, name, providerDisplayName }) => ({ type: "agent", id, name, providerDisplayName }));
  }

  providerCatalog(): AgentProviderCatalog {
    const visible = new Set(this.list().map(model => model.id));
    return { providers: this.all.flatMap(connection => {
      const models = this.catalog.filter(model => model.accountId === connection.accountId && visible.has(model.id));
      if (models.length === 0) return [];
      const scope = { kind: "organization" as const };
      return [{ id: `subscription:${connection.accountId}`, name: connection.providerDisplayName, scope,
        refreshedAt: null, error: connection.ready === false ? "This subscription is not connected." : null,
        models: models.map(model => ({ id: model.id, providerId: `subscription:${connection.accountId}`,
          modelId: model.modelId, name: model.name, providerName: model.providerDisplayName, scope,
          source: "subscription" as const })) }];
    }) };
  }

  resolve(id: string): UserAiModelRecord | undefined {
    const model = this.get(id);
    if (!this.#authorized || !model || model.mode === "disabled") return undefined;
    return {
      profile: { type: "agent", id: model.id, name: model.name, providerDisplayName: model.providerDisplayName },
      config: { provider: "openai", model: model.modelId, apiToken: "", transport: "subscription",
        ...(model.catalogSource && model.subscriptionProvider
          ? { subscriptionProvider: model.subscriptionProvider } : {}),
        ...(this.#selectable ? { subscriptionAccountId: model.accountId } : {}) },
    };
  }

  /** Revalidate a persisted binding against the current connection catalog and admin modes. */
  resolveConfig(config: UserAiModelRecord["config"]): UserAiModelRecord | undefined {
    if (config.transport !== "subscription" || config.provider !== "openai" || config.apiToken ||
        config.apiUrl !== undefined || Object.keys(config.extraHeaders ?? {}).length) return undefined;
    const model = this.catalog.find(model => model.accountId === (config.subscriptionAccountId ?? "owner") &&
      model.modelId === config.model && (config.subscriptionProvider === undefined
        ? !model.id.startsWith("subscription-model:") : model.catalogSource !== undefined &&
          model.subscriptionProvider === config.subscriptionProvider));
    if (!model) return undefined;
    this.refuseDisabled(model.id);
    return this.resolve(model.id);
  }

  refuseDisabled(id: string): void {
    if (!this.get(id)) return;
    if (this.get(id)?.mode === "disabled")
      throw new Error("The subscription model is disabled by an administrator.");
    if (!this.#authorized) throw new Error("inference_bridge_user_denied");
  }

  refuseUserModel(_name?: string): void {
    if (!this.userModels)
      throw new Error("Adding your own models is disabled on this deployment by an administrator.");
  }
}
