/**
 * useWordExamples.ts —— 当前词的例句：加载 / AI 生成 / 删除（用户 2026-10-22）。
 *
 * - 加载：挂载/换词即拉该词全部例句（一词多条，按生成时间升序）；
 * - 生成：chatTurn（走设置页 AI 通道/模型）→ parseExampleReply → exampleRepo 落库 → 本地追加；
 *   每次调用只生成一条（用户：每次生成可以增加一个例句）；
 *   模型优先用调用方传入的**临时模型**（用户 2026-10-23：问答框的临时模型下拉同时管例句生成，
 *   一处选择两处生效）；没传回落设置页默认；
 * - 删除：按 id 删，RLS 保证只能删自己的。
 * 写失败/解析失败都在明面给文案（genError），不静默。
 */
import { useCallback, useEffect, useState } from 'react';
import { chatTurn } from '../ai/llmClient';
import { getRepos, useAppStore } from '../store/useAppStore';
import { useSettingsStore } from '../store/useSettingsStore';
import { buildExampleMessages, parseExampleReply } from '../features/examples';
import type { WordExample, WordSense } from '../types/domain';

export interface UseWordExamplesApi {
  examples: WordExample[];
  loading: boolean;
  /** 正在生成（LLM + 落库） */
  genBusy: boolean;
  /** 生成/删除失败的明面文案 */
  error: string;
  /** 为某个义项生成一条例句（追加，不覆盖） */
  generate(sense: WordSense): Promise<WordExample | null>;
  /** 删除一条 */
  remove(id: string): Promise<void>;
}

export function useWordExamples(wordId: string | null, lemma: string, tempModel?: string): UseWordExamplesApi {
  const userId = useAppStore((s) => s.userId);
  const [examples, setExamples] = useState<WordExample[]>([]);
  const [loading, setLoading] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [error, setError] = useState('');

  // 换词重载
  useEffect(() => {
    setExamples([]);
    setError('');
    if (!userId || !wordId) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const rows = await getRepos().example.listExamplesForWord(userId, wordId);
        if (!cancelled) setExamples(rows);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, wordId]);

  const generate = useCallback(
    async (sense: WordSense): Promise<WordExample | null> => {
      if (!userId || !wordId || genBusy) return null;
      setGenBusy(true);
      setError('');
      try {
        const { aiChannel, aiBaseUrl, aiModel } = useSettingsStore.getState();
        const result = await chatTurn(buildExampleMessages(lemma, sense), {
          model: tempModel || aiModel || 'step-5-preview',
          channel: aiChannel,
          ...(aiBaseUrl ? { baseUrl: aiBaseUrl } : {}),
        });
        const parsed = parseExampleReply(result.content);
        if (!parsed) {
          setError('模型回复不合规，没生成例句——再试一次');
          return null;
        }
        const saved = await getRepos().example.addExample({
          userId,
          wordId,
          senseId: sense.senseId,
          lemma,
          en: parsed.en,
          zh: parsed.zh,
        });
        setExamples((prev) => [...prev, saved]);
        return saved;
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        return null;
      } finally {
        setGenBusy(false);
      }
    },
    [userId, wordId, lemma, genBusy, tempModel],
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!userId) return;
      setError('');
      try {
        await getRepos().example.removeExample(id);
        setExamples((prev) => prev.filter((x) => x.id !== id));
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [userId],
  );

  return { examples, loading, genBusy, error, generate, remove };
}
