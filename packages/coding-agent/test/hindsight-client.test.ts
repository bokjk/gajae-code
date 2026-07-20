import { afterEach, describe, expect, it, vi } from "bun:test";
import { HindsightApi, HindsightError } from "@gajae-code/coding-agent/hindsight/client";

const client = new HindsightApi({ baseUrl: "https://hindsight.test" });

afterEach(() => {
	vi.restoreAllMocks();
});

describe("HindsightApi response boundaries", () => {
	it("parses a normal JSON response", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ results: [{ text: "remember this" }] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		await expect(client.recall("bank", "query")).resolves.toEqual({
			results: [{ text: "remember this" }],
		});
	});

	it("preserves structured API error mapping", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ detail: "service unavailable" }), { status: 503 }),
		);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error).toMatchObject({ statusCode: 503, details: "service unavailable" });
		expect(error.message).toBe("recall failed: service unavailable");
	});

	it("rejects an oversized declared response before parsing it", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("sensitive-response-content", {
				status: 200,
				headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER) },
			}),
		);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toContain("response exceeded size limit");
		expect(error.message).not.toContain("sensitive-response-content");
	});

	it("rejects a chunked response that crosses the streaming byte cap", async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
				controller.close();
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toContain("response exceeded size limit");
	});

	it("maps an aborted stalled body to a content-free timeout error", async () => {
		const timeoutController = new AbortController();
		vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
		vi.spyOn(globalThis, "fetch").mockImplementation((async (
			_input: Parameters<typeof fetch>[0],
			init?: Parameters<typeof fetch>[1],
		) => {
			expect(init?.signal).toBe(timeoutController.signal);
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener("abort", () => {
						controller.error(new DOMException("sensitive upstream detail", "AbortError"));
					});
					queueMicrotask(() => timeoutController.abort());
				},
			});
			return new Response(body, { status: 200 });
		}) as unknown as typeof fetch);

		const error = await client.recall("bank", "query").catch(value => value);
		expect(error).toBeInstanceOf(HindsightError);
		expect(error.message).toBe("recall request failed: timed out");
		expect(error.message).not.toContain("sensitive upstream detail");
	});

	it("keeps allow404 responses body-independent", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(body, {
				status: 404,
				headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER) },
			}),
		);

		await expect(client.getDocument("bank", "missing")).resolves.toBeNull();
		expect(cancelled).toBe(true);
	});
});
