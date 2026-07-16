import { describe, expect, test } from "bun:test";
import { Effort, type Model } from "@gajae-code/ai";
import { resolveSelector, splitSelectorThinkingSuffix } from "@gajae-code/coding-agent/config/model-resolver";

const model = (provider: string, id: string): Model<"anthropic-messages"> => ({
	id,
	name: id,
	api: "anthropic-messages",
	provider,
	baseUrl: "https://example.test",
	reasoning: true,
	thinking: { mode: "budget", minLevel: Effort.Minimal, maxLevel: Effort.High },
	input: ["text"],
	cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const candidates = [model("openai", "gpt"), model("openrouter", "z-ai/glm-4.7")];

describe("staged selector golden table", () => {
	test("documents case and suffix divergence", () => {
		const golden = [
			{ selector: "OPENAI/GPT", id: "gpt", thinkingLevel: undefined, explicit: false },
			{ selector: "openai/gpt:high", id: "gpt", thinkingLevel: Effort.High, explicit: true },
			// A second suffix is not recursively consumed by the staged resolver.
			{ selector: "openai/gpt:high:low", id: undefined, thinkingLevel: undefined, explicit: false },
		] as const;

		for (const expected of golden) {
			const resolved = resolveSelector(expected.selector, candidates);
			expect(resolved.model?.id).toBe(expected.id);
			expect(resolved.thinkingLevel).toBe(expected.thinkingLevel);
			expect(resolved.explicitThinkingLevel).toBe(expected.explicit);
		}
	});

	test("case-only duplicate provider selectors fall through to bare-id ranking", () => {
		const duplicates = [model("openai", "gpt"), model("openai", "GPT")];
		expect(resolveSelector("openai/gpt", duplicates).model?.id).toBe("gpt");
	});

	test("preserves OpenRouter route and date suffix cloning", () => {
		const resolved = resolveSelector("openrouter/z-ai/glm-4.7-20251222:nitro", candidates);
		expect(resolved.model).toMatchObject({ provider: "openrouter", id: "z-ai/glm-4.7-20251222:nitro" });
	});

	test("splits only the final selector suffix", () => {
		expect(splitSelectorThinkingSuffix("openrouter/qwen/model:route:high")).toEqual({
			selector: "openrouter/qwen/model:route",
			thinkingLevel: Effort.High,
		});
	});
});
