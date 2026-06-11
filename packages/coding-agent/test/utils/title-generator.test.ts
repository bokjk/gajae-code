import { describe, expect, it } from "bun:test";
import { formatSessionTerminalTitle } from "../../src/utils/title-generator";

describe("formatSessionTerminalTitle", () => {
	it("falls back to GJC branding when no session name or cwd is available", () => {
		expect(formatSessionTerminalTitle(undefined)).toBe("GJC");
	});

	it("prefixes the session name with GJC branding", () => {
		expect(formatSessionTerminalTitle("My Session")).toBe("GJC: My Session");
	});

	it("uses the cwd basename as a fallback label", () => {
		expect(formatSessionTerminalTitle(undefined, "/home/user/projects/gajae")).toBe("GJC: gajae");
	});

	it("strips control characters to keep terminal titles safe", () => {
		expect(formatSessionTerminalTitle("evil\x1b]0;pwned\x07title")).toBe("GJC: evil]0;pwnedtitle");
	});

	it("falls back to GJC when the sanitized session name is empty", () => {
		expect(formatSessionTerminalTitle("\x1b\x07")).toBe("GJC");
	});
});
