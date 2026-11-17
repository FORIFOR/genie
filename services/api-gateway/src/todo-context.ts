/**
 * 「これを金曜までにやって」の「これ」を、会話の直前の文から決める（TodoService の previousText）。
 *
 * handleTurn は、やることの言い方を読む前にこの発話を turn に足している。なので直近の本人の turn の
 * いちばん新しいものがこの発話で、その 1 つ前が「これ」。古すぎる（30 分より前）なら指していないとみなす。
 */
import type { ConversationService } from '@genie/service-conversation';

export const REF_WINDOW_MS = 30 * 60_000;

export function previousUserText(
  conversations: Pick<ConversationService, 'recentTurns'>,
  now: () => number = Date.now,
) {
  return async (
    principal: { tenantId: string; userId: string },
    conversationId: string,
  ): Promise<string | null> => {
    const turns = await conversations.recentTurns(principal.tenantId, conversationId, 8);
    const mine = turns.filter((t) => t.role === 'user' && t.text.trim());
    const before = mine.at(-2);
    if (!before) return null;
    const at = Date.parse(String(before.created_at));
    if (Number.isFinite(at) && now() - at > REF_WINDOW_MS) return null;
    return before.text.trim();
  };
}
