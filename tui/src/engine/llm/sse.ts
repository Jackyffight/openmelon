// Minimal Server-Sent Events reader for OpenAI-compatible streaming.
//
// Yields the payload of each `data:` frame as a string. The caller is
// responsible for the `[DONE]` sentinel and JSON parsing. Cancellation is
// handled upstream by aborting the fetch (which ends the body stream).

type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

function toAsyncIterable(body: ByteSource): AsyncIterable<Uint8Array> {
	if (Symbol.asyncIterator in body) {
		return body as AsyncIterable<Uint8Array>;
	}
	// Web ReadableStream without async-iterator support: adapt via a reader.
	const reader = (body as ReadableStream<Uint8Array>).getReader();
	return {
		[Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
			return {
				async next(): Promise<IteratorResult<Uint8Array>> {
					const {done, value} = await reader.read();
					if (done) {
						return {done: true, value: undefined};
					}
					return {done: false, value: value as Uint8Array};
				},
				async return(): Promise<IteratorResult<Uint8Array>> {
					reader.releaseLock();
					return {done: true, value: undefined};
				}
			};
		}
	};
}

/** Async-iterate the `data:` payloads of an SSE stream. */
export async function* sseData(body: ByteSource): AsyncGenerator<string> {
	const decoder = new TextDecoder();
	let buffer = '';
	for await (const chunk of toAsyncIterable(body)) {
		buffer += decoder.decode(chunk, {stream: true});
		let idx: number;
		while ((idx = buffer.indexOf('\n')) >= 0) {
			const line = buffer.slice(0, idx).replace(/\r$/, '');
			buffer = buffer.slice(idx + 1);
			if (!line || line.startsWith(':')) {
				continue; // keep-alive blank line or comment
			}
			if (line.startsWith('data:')) {
				yield line.slice(5).replace(/^ /, '');
			}
		}
	}
	const tail = buffer.trim();
	if (tail.startsWith('data:')) {
		yield tail.slice(5).replace(/^ /, '');
	}
}
