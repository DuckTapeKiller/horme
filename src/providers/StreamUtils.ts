export function createAssistantContentReader(
  content: string,
  signal?: AbortSignal,
  chunkSize = 64
): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  let offset = 0;
  let aborted = false;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (signal) {
        if (signal.aborted) {
          aborted = true;
          controller.error(new DOMException("Aborted", "AbortError"));
          return;
        }
        const onAbort = () => {
          aborted = true;
          controller.error(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }
    },
    pull(controller) {
      if (aborted) return;
      if (offset >= content.length) {
        controller.close();
        return;
      }
      const next = content.slice(offset, offset + chunkSize);
      offset += chunkSize;
      // Emit JSON objects compatible with HormeChatView.processChunk()
      controller.enqueue(encoder.encode(JSON.stringify({ message: { content: next } })));
    },
    cancel() {
      offset = content.length;
    },
  });

  return stream.getReader();
}

