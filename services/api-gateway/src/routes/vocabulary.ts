/**
 * 個人の辞書（本人の操作だけ。認証必須）。
 *
 *   GET    /v1/vocabulary        一覧（Mac の音声入力が取りに来る）
 *   POST   /v1/vocabulary        登録 { spoken, written }（同じ聞こえ方は上書き）
 *   DELETE /v1/vocabulary/:id    削除
 *
 * 会話でも同じことができる（「辞書に登録: ジーニーは Genie」）。
 */
import { GenieError } from '@genie/contracts';
import { MAX_VOCABULARY, type VocabularyService } from '@genie/service-vocabulary';
import { z } from 'zod';
import type { App } from '../fastify.js';
import { requirePrincipal } from '../auth/middleware.js';

const Entry = z.object({
  spoken: z.string().trim().min(1).max(100),
  written: z.string().trim().min(1).max(500),
});

export function registerVocabularyRoutes(app: App, deps: { vocabulary: VocabularyService }): void {
  const store = deps.vocabulary.store;

  app.get('/v1/vocabulary', async () => {
    const principal = requirePrincipal();
    const entries = await store.list(principal.tenantId, principal.userId);
    return {
      items: entries.map((e) => ({
        id: e.id,
        spoken: e.spoken,
        written: e.written,
        created_at: e.createdAt,
      })),
    };
  });

  app.post('/v1/vocabulary', async (request, reply) => {
    const principal = requirePrincipal();
    const body = Entry.parse(request.body ?? {});
    const result = await store.upsert(
      principal.tenantId,
      principal.userId,
      body.spoken,
      body.written,
    );
    if (result === 'full')
      throw new GenieError('common.conflict', `the vocabulary is full (${String(MAX_VOCABULARY)})`);
    return reply.status(result === 'added' ? 201 : 200).send({ result });
  });

  app.delete<{ Params: { id: string } }>('/v1/vocabulary/:id', async (request, reply) => {
    const principal = requirePrincipal();
    const removed = await store.remove(principal.tenantId, principal.userId, request.params.id);
    if (!removed) throw new GenieError('common.not_found', 'no such entry');
    return reply.status(204).send();
  });
}
