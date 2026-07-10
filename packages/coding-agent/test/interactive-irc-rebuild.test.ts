import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { EventController } from "@gajae-code/coding-agent/modes/controllers/event-controller";
import { IrcObservationLedger } from "@gajae-code/coding-agent/modes/irc-observation-ledger";
import { initTheme } from "@gajae-code/coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@gajae-code/coding-agent/modes/types";
import { UiHelpers } from "@gajae-code/coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@gajae-code/coding-agent/session/session-manager";
import { Container } from "@gajae-code/tui";

beforeAll(() => initTheme());
afterEach(() => vi.useRealTimers());

function makeContext() {
	const chatContainer = new Container();
	const ledger = new IrcObservationLedger();
	const ctx = {
		chatContainer,
		pendingTools: new Map(),
		ircLedger: ledger,
		ui: { requestRender: vi.fn() },
		session: {},
	} as unknown as InteractiveModeContext;
	const helpers = new UiHelpers(ctx);
	ctx.addMessageToChat = message => helpers.addMessageToChat(message);
	return { ctx, ledger, helpers, chatContainer };
}

const emptyContext = { messages: [] } as unknown as SessionContext;

describe("IRC rebuild projection", () => {
	it("keeps the remaining absolute TTL when a rebuild reconciles its timer", () => {
		vi.useFakeTimers({ now: 0 });
		const { ctx, ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{ observationId: "ephemeral", kind: "incoming", from: "peer", to: "you", text: "hello", timestamp: 0 },
			true,
		);
		vi.advanceTimersByTime(4_000);
		helpers.renderSessionContext(emptyContext);
		new EventController(ctx).reconcileIrcExpiryTimers(helpers.getRenderedIrcInlineComponents());

		vi.advanceTimersByTime(5_999);
		expect(chatContainer.children).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(chatContainer.children).toHaveLength(0);
	});

	it("omits expired ephemeral records and retains persistent relays through rebuild", () => {
		vi.useFakeTimers({ now: 0 });
		const { ledger, helpers, chatContainer } = makeContext();
		ledger.observe(
			{ observationId: "expired", kind: "incoming", from: "peer", to: "you", text: "old", timestamp: 0 },
			true,
		);
		ledger.observe(
			{ observationId: "relay", kind: "relay", from: "one", to: "two", text: "visible", timestamp: 0 },
			false,
		);
		vi.advanceTimersByTime(10_000);
		helpers.renderSessionContext(emptyContext);

		expect(helpers.getRenderedIrcInlineComponents().has("expired")).toBe(false);
		expect(helpers.getRenderedIrcInlineComponents().has("relay")).toBe(true);
		expect(chatContainer.children).toHaveLength(2);
	});
});
