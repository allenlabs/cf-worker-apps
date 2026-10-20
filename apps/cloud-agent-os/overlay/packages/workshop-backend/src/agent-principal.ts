import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api';

/** Only for authors obtained from a trusted user DO or its server-minted gadget wrapper. */
export function accountIdForTrustedAgentAuthor(author: AiChatAuthorInfo): string | undefined {
  return author.type === 'user' || author.type === 'gadget' ? author.id : undefined;
}
