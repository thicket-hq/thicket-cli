// A minimal Server-Sent Events reader over fetch: yields {event, data, id}
// per message, ignores comment lines (`: ping`), honours `retry:`. Node has
// no EventSource with custom headers, and the bearer token has to ride one.

export type SseMessage = {
  event: string;
  data: string;
  id: string | null;
  retry: number | null;
};

/** Parses a stream of SSE text chunks into messages. */
export async function* parseSse(
  body: AsyncIterable<Uint8Array | string>,
): AsyncGenerator<SseMessage, void, void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let id: string | null = null;
  let retry: number | null = null;
  const flush = (): SseMessage | null => {
    if (data.length === 0 && event === "message" && id === null && retry === null) return null;
    const message: SseMessage = { event, data: data.join("\n"), id, retry };
    event = "message";
    data = [];
    id = null;
    retry = null;
    return message;
  };
  /** Applies one field line; returns a message when the line was a blank separator. */
  const consume = (raw: string): SseMessage | null => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (line === "") return flush();
    if (line.startsWith(":")) return null; // comment (`: ping`)
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "event":
        event = value;
        break;
      case "data":
        data.push(value);
        break;
      case "id":
        id = value;
        break;
      case "retry": {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n)) retry = n;
        break;
      }
      default:
        break;
    }
    return null;
  };
  const worth = (m: SseMessage | null): m is SseMessage => !!m && (m.data !== "" || m.event !== "message");
  for await (const chunk of body) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const message = consume(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (worth(message)) yield message;
    }
  }
  if (buffer !== "") {
    const message = consume(buffer);
    if (worth(message)) yield message;
  }
  const last = flush();
  if (worth(last)) yield last;
}

/** Wraps a fetch Response body as an async iterable of chunks. */
export function bodyChunks(response: Response): AsyncIterable<Uint8Array> {
  const body = response.body as unknown as
    | (ReadableStream<Uint8Array> & Partial<AsyncIterable<Uint8Array>>)
    | null;
  if (!body) return (async function* () {})();
  if (typeof body[Symbol.asyncIterator] === "function") {
    return body as AsyncIterable<Uint8Array>;
  }
  return (async function* () {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        if (value) yield value;
      }
    } finally {
      reader.releaseLock();
    }
  })();
}
