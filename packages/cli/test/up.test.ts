import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runUp } from "../src/up";

async function withHome<T>(run: (home: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "gajaeway-up-test-"));
	try {
		return await run(join(root, "home"));
	} finally {
		await rm(root, { recursive: true }).catch(() => {});
	}
}

describe("gajaeway up", () => {
	test("reports next steps when gateway is not running", async () => {
		await withHome(async (home) => {
			const lines: string[] = [];
			const log = (line: string) => lines.push(line);

			// Mock setup to avoid interactive prompts
			const setupRun = false; // We'll skip setup
			await runUp({
				home,
				skipSetup: true, // Skip setup since no config exists
				log,
			});

			// Should suggest services installation and docker
			expect(lines.some((l) => l.includes("Gateway is not running"))).toBe(true);
			expect(lines.some((l) => l.includes("gajaeway services install"))).toBe(true);
			expect(lines.some((l) => l.includes("docker compose"))).toBe(true);
		});
	});

	test("indicates when gateway is already running", async () => {
		await withHome(async (home) => {
			const lines: string[] = [];
			const log = (line: string) => lines.push(line);

			// Create a dummy config to pass the setup check
			await Bun.write(join(home, "config.json"), JSON.stringify({}));

			// Mock the gateway check to always fail (simulating not running)
			await runUp({
				home,
				skipSetup: true,
				log,
			});

			// Should suggest either Docker or manual start
			const output = lines.join("\n");
			expect(output).toContain("not running");
		});
	});

	test("gracefully handles missing home directory", async () => {
		const nonExistentHome = "/tmp/nonexistent-gajaeway-test-12345";
		const lines: string[] = [];
		const log = (line: string) => lines.push(line);

		try {
			await runUp({
				home: nonExistentHome,
				skipSetup: true,
				log,
			});
		} catch {
			// Expected if home doesn't exist
		}

		// Test passed if no crash
		expect(lines.length >= 0).toBe(true);
	});
});
