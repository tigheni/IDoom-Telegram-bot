import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src";

describe("IDoom bot worker", () => {
	it("responds to health check (unit style)", async () => {
		const request = new Request("http://example.com");
		// Create an empty context to pass to `worker.fetch()`.
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		// Wait for all `Promise`s passed to `ctx.waitUntil()` to settle before running test assertions
		await waitOnExecutionContext(ctx);
		expect(await response.text()).toMatchInlineSnapshot(`"IDoom Bot is running!"`);
	});

	it("responds to health check (integration style)", async () => {
		const response = await SELF.fetch("http://example.com");
		expect(await response.text()).toMatchInlineSnapshot(`"IDoom Bot is running!"`);
	});
});

describe("Telegram webhook", () => {
	const post = (headers = {}) =>
		new Request("http://example.com/telegram", {
			method: "POST",
			headers: { "Content-Type": "application/json", ...headers },
			body: JSON.stringify({ update_id: 1 }),
		});

	it("rejects requests with a wrong secret token", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(post({ "X-Telegram-Bot-Api-Secret-Token": "nope" }), { ...env, TELEGRAM_WEBHOOK_SECRET: "s3cret" }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(401);
	});

	it("accepts requests with the right secret token", async () => {
		const ctx = createExecutionContext();
		const response = await worker.fetch(post({ "X-Telegram-Bot-Api-Secret-Token": "s3cret" }), { ...env, TELEGRAM_WEBHOOK_SECRET: "s3cret" }, ctx);
		await waitOnExecutionContext(ctx);
		expect(response.status).toBe(200);
	});

	it("returns 404 for unknown paths", async () => {
		const response = await SELF.fetch("http://example.com/nope");
		expect(response.status).toBe(404);
	});
});
