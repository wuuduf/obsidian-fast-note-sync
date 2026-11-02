/** Bound the whole read-and-hash operation, including a stalled vault read. */
export async function withHashTimeout<T>(work: (signal: AbortSignal) => Promise<T>, timeoutMs = 15000): Promise<T> {
  let timer: number | undefined;
  const controller = new AbortController();
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(() => {
          const error = new Error("Hash timeout");
          controller.abort(error);
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}
