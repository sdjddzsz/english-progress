/**
 * httpFetch.ts —— 带超时的 fetch（AbortController + 外部 signal 合并）。
 * neuralProvider（Azure / OpenAI 兼容）与 dashscopeProvider 共用；从 neuralProvider.ts 抽出，
 * 避免两通道相互 import 形成环。
 */

/** 带超时的 fetch（AbortController + 外部 signal 合并） */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  externalSignal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onAbort);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onAbort);
  }
}
