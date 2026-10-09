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
  CODEX_BRIDGE?: unknown;
  CODEX_BRIDGE_MODEL?: string;
  CODEX_BRIDGE_ALLOWED_USER_IDS?: string;
};

/** Whether the deployment explicitly delegates its fixed subscription catalog to admins. */
export function isAdminManagedSubscription(env: Cloudflare.Env & SubscriptionEnvironment): boolean {
  return env.CODEX_BRIDGE_MANAGEMENT === "admin";
}

/** A fixed, credential-free catalog; the existing bridge retains account and inference authority. */
export class SubscriptionModels {
  readonly transport = "subscription";
  readonly providers: ReadonlySet<AiModelProvider> = new Set(["openai"]);
  readonly userModels = false;
  readonly all: readonly { id: string; name: string; provider: "openai"; mode: GatewayModelMode }[];
  readonly #authorized: boolean;

  constructor(
    env: Cloudflare.Env & SubscriptionEnvironment,
    config: Pick<AdminConfig, "modelModes">,
    userId?: string,
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
    this.#authorized = userId !== undefined && allowed.data.includes(userId);
    const mode = Object.hasOwn(config.modelModes, catalog.id)
      ? config.modelModes[catalog.id]
      : "enabled";
    this.all = [{ id: catalog.id, name: "Codex subscription", provider: "openai", mode }];
  }

  get(id: string) {
    return this.all.find((model) => model.id === id);
  }

  list(): AiChatAuthorInfo[] {
    if (!this.#authorized) return [];
    return this.all
      .filter((model) => model.mode === "enabled")
      .map(({ id, name }) => ({ type: "agent", id, name }));
  }

  resolve(id: string): UserAiModelRecord | undefined {
    const model = this.get(id);
    if (!this.#authorized || !model || model.mode === "disabled") return undefined;
    return {
      profile: { type: "agent", id: model.id, name: model.name },
      config: { provider: "openai", model: model.id, apiToken: "" },
    };
  }

  refuseDisabled(id: string): void {
    if (this.get(id)?.mode === "disabled")
      throw new Error("The subscription model is disabled by an administrator.");
    if (!this.#authorized) throw new Error("inference_bridge_user_denied");
  }

  refuseUserModel(): never {
    throw new Error("Adding your own models is disabled on this deployment by an administrator.");
  }
}
