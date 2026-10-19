import { OPENAI_CODEX_MODELS } from "@earendil-works/pi-ai/providers/openai-codex.models";
import type {
  AiChatAuthorInfo,
  AiModelProvider,
  GatewayModelMode,
} from "@gadgets/workshop-shared/api";
import { z } from "zod";
import type { AdminConfig } from "./storage-schema/admin-settings-storage.js";
import type { UserAiModelRecord } from "./storage-schema/user-storage.js";

type SubscriptionEnvironment = {
  CODEX_BRIDGE_MANAGEMENT?: string;
  CODEX_BRIDGE_SETUP?: string;
  CODEX_BRIDGE?: { subscriptionConnections(): Promise<unknown> };
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
export type SubscriptionConnections = z.infer<typeof subscriptionConnectionsSchema>;

/** Parse the private binding's safe catalog without granting model access to its caller. */
export async function readSubscriptionConnections(env: Cloudflare.Env & SubscriptionEnvironment): Promise<SubscriptionConnections | undefined> {
  if (env.CODEX_BRIDGE_SETUP !== "siwc") return undefined;
  if (!env.CODEX_BRIDGE) throw new Error("inference_bridge_not_configured");
  return subscriptionConnectionsSchema.parse(await env.CODEX_BRIDGE.subscriptionConnections());
}

/** A credential-free catalog; the bridge retains account and inference authority. */
export class SubscriptionModels {
  readonly transport = "subscription";
  readonly providers: ReadonlySet<AiModelProvider> = new Set(["openai"]);
  readonly userModels: boolean;
  readonly setupUrl?: string;
  readonly all: readonly { id: string; name: string; providerDisplayName: string; provider: "openai"; mode: GatewayModelMode;
    accountId: string; subscriptionProvider: SubscriptionConnections[number]["provider"] | null; ready: boolean | null }[];
  readonly #selectable: boolean;
  readonly #physicalModel: string;
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
    this.#physicalModel = catalog.id;
    this.#selectable = connections !== undefined;
    this.all = (connections ?? [{ id: "owner", label: "Codex subscription", provider: null, ready: null }]).map(connection => {
      const id = connection.id === "owner" ? catalog.id : `subscription-${connection.id}`;
      const mode = Object.hasOwn(config.modelModes, id) ? config.modelModes[id] : "enabled";
      return { id, name: config.modelDisplayNames && Object.hasOwn(config.modelDisplayNames, id)
          ? config.modelDisplayNames[id] : connection.label,
        providerDisplayName: connection.label, provider: "openai", mode, accountId: connection.id,
        subscriptionProvider: connection.provider, ready: connection.ready };
    });
  }

  get(id: string) {
    return this.all.find((model) => model.id === id);
  }

  list(): AiChatAuthorInfo[] {
    if (!this.#authorized) return [];
    return this.all
      .filter((model) => model.mode === "enabled")
      .map(({ id, name, providerDisplayName }) => ({ type: "agent", id, name, providerDisplayName }));
  }

  resolve(id: string): UserAiModelRecord | undefined {
    const model = this.get(id);
    if (!this.#authorized || !model || model.mode === "disabled") return undefined;
    return {
      profile: { type: "agent", id: model.id, name: model.name, providerDisplayName: model.providerDisplayName },
      config: { provider: "openai", model: this.#physicalModel, apiToken: "", transport: "subscription",
        ...(this.#selectable ? { subscriptionAccountId: model.accountId } : {}) },
    };
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
