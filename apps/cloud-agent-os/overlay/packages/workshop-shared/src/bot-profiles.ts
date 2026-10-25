/** Personal, reusable configuration. A profile grants no model, connector or workspace access. */
export type BotProfileInput = {
  id: string;
  name: string;
  description: string;
  instructions: string;
  icon: 'spark' | 'search' | 'code' | 'notebook';
  starterPrompts: string[];
  memory: 'off' | 'connected';
  archived: boolean;
};

export type BotProfile = BotProfileInput & {
  revision: number;
  createdAt: string;
  updatedAt: string;
};

/** The revision the person actually selected, checked again when a chat is accepted. */
export type BotSelection = { id: string; revision: number };

/** Immutable in a chat. Profile edits and archiving never rewrite prior conversations. */
export type BotProfileSnapshot = Pick<BotProfile,
  'id' | 'revision' | 'name' | 'icon' | 'instructions' | 'memory'>;

/** A single account-wide preference; changing it never mutates any conversation snapshot. */
export type MainBotSelection = { key: 'main'; botId: string | null; revision: number };
