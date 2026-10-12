import { access } from "node:fs/promises";
import { join } from "node:path";
import { GajaewayClient } from "@gajae-gateway/sdk";
import { runSetup } from "./setup";
import type { RunSetupOptions } from "./setup";

export interface UpOptions extends Omit<RunSetupOptions, "home"> {
	readonly home: string;
	readonly socket?: string;
	/** Skip the setup check and assume config exists. */
	readonly skipSetup?: boolean;
}

/**
 * `gajaeway up`: One-command setup and start for first-time users.
 *
 * Checks for existing config.json; if missing, runs interactive setup.
 * Reports next steps and hints about service installation on local machines.
 */
export async function runUp(options: UpOptions): Promise<void> {
	const log = options.log ?? ((line: string) => console.log(line));
	const configPath = join(options.home, "config.json");

	// Check if setup is needed
	if (!options.skipSetup) {
		let exists = false;
		try {
			await access(configPath);
			exists = true;
		} catch {
			// File does not exist
		}

		if (!exists) {
			log("No configuration found. Running setup...\n");
			try {
				// Run setup in default (interactive) mode
				await runSetup([], {
					home: options.home,
					env: options.env,
					fetch: options.fetch,
					prompter: options.prompter,
					log,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				log(`Setup failed: ${message}`);
				throw error;
			}

			log("\n✓ Configuration saved.\n");
		}
	}

	// Check gateway status
	const socket = options.socket ?? `${options.home}/gateway.sock`;
	let isRunning = false;

	try {
		const client = await GajaewayClient.connectSocket(socket);
		try {
			await client.status();
			isRunning = true;
		} finally {
			await client.close();
		}
	} catch {
		// Gateway is not running
	}

	if (isRunning) {
		log("✓ Gateway is already running.");
		log("\nNext steps:");
		log("  • Send a message to your bot on Discord/Slack/Telegram");
		log("  • View logs: gajaeway ops cycle");
		log("  • See memory: gajaeway memory search");
		log("\nStop the gateway with: gajaeway shutdown");
	} else {
		log("⚠ Gateway is not running. Start it with one of:");
		log("");
		log("  Local installation:");
		log("    • Install services: gajaeway services install --bin-dir ./dist [--platform darwin|linux]");
		log("    • Then services will start on boot; restart with: gajaeway ops restart-stack");
		log("");
		log("  Docker Compose (from the repository root):");
		log("    • First time: docker compose run --rm -it setup gajaeway setup");
		log("    • Then start: docker compose up");
		log("");
		log("  Manual (for development):");
		log("    • Terminal 1: bun packages/gateway/src/main.ts daemon");
		log("    • Terminal 2: dist/gajaeway-discord  (or gajaeway-slack/gajaeway-telegram)");
	}
}
