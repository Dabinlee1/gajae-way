import { constants, type Stats } from "node:fs";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { acquireLease, homeLayout, type Lease, LeaseHeldError } from "@gajae-gateway/home";
import { assertAgentDb } from "./broker-agent/agent-db";
import { BROKER_ENV_PROTECTED_KEYS, LIVE_BROKER_ENV_KEYS, resolveBrokerAgentSource } from "./broker-agent/allowlist";
import { assertAgentDirectory, BrokerAgentError, recoverProvision } from "./broker-agent/provision";
import type { GatewayConfig } from "./config";
import { GJC_ATTACH_ONLY_ENV, readPinnedGjcVersion } from "./orchestrator/broker";
import { judgeBrokerLiveness, type PidAliveProbe } from "./orchestrator/broker-liveness";

const BROKER_ENV_FILE = "broker.env";

export interface BrokerWatchdogConfig {
	/** Milliseconds to wait after broker startup before starting checks. */
	startupGraceMs?: number;
	/** Interval between broker liveness probes. */
	probeIntervalMs?: number;
	/** Number of consecutive probe failures before terminating the broker. */
	failureThreshold?: number;
	/** Grace period after SIGTERM before sending SIGKILL. */
	killGraceMs?: number;
	/** Probe function for checking if a process is alive. */
	isPidAlive?: PidAliveProbe;
}

const DEFAULT_WATCHDOG_CONFIG: Required<BrokerWatchdogConfig> = {
	startupGraceMs: 10_000,
	probeIntervalMs: 5_000,
	failureThreshold: 3,
	killGraceMs: 5_000,
	isPidAlive: defaultPidAlive,
};

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
		throw error;
	}
}

export async function runBrokerHost(config: GatewayConfig): Promise<number> {
	let lease: Lease;
	try {
		lease = await acquireLease(config.home, "broker");
		console.info(`lease_acquired name=broker pid=${process.pid}`);
	} catch (error) {
		if (error instanceof LeaseHeldError) console.error(error.message);
		else {
			console.error(`lease_failed name=broker detail=${error instanceof Error ? error.message : String(error)}`);
			console.error(`broker_host_refused ${error instanceof Error ? error.message : String(error)}`);
		}
		return 1;
	}
	try {
		const layout = homeLayout(config.home);
		const agentDir = resolve(config.gjc.agentDir);
		await assertAgentDirectory(agentDir);
		const agentReal = await realpath(agentDir);
		const operatorAgent = resolveBrokerAgentSource();
		const operatorReal = await realpath(operatorAgent).catch(() => resolve(operatorAgent));
		if (agentReal === operatorReal)
			throw new BrokerAgentError("broker_agent_live_link", "agentDir is the operator agent directory");

		await recoverProvision(config.home, agentDir, lease);
		const manifest = await readProvisionManifest(layout.brokerProvisionManifest);
		if (!manifest) throw new BrokerAgentError("broker_agent_unprovisioned", "manifest is absent or invalid");
		if (manifest.agentDir !== agentReal)
			throw new BrokerAgentError("broker_agent_unrecoverable", "manifest agentDir does not match config");
		await validateTargetAgentDb(agentDir);

		const brokerEnv = await readBrokerEnvironment(join(config.home, BROKER_ENV_FILE));
		for (const key of LIVE_BROKER_ENV_KEYS) {
			if (process.env[key] !== undefined || brokerEnv[key] !== undefined)
				throw new BrokerAgentError("broker_agent_live_link", `refused ${key}`);
		}
		for (const key of BROKER_ENV_PROTECTED_KEYS.slice(LIVE_BROKER_ENV_KEYS.length)) {
			if (brokerEnv[key] !== undefined)
				throw new BrokerAgentError("broker_agent_live_link", `broker.env may not set ${key}`);
		}

		const exe = await realpath(layout.gjcExecutable());
		await access(exe, constants.X_OK);
		const env: NodeJS.ProcessEnv = {
			HOME: process.env.HOME ?? homedir(),
			PATH: process.env.PATH ?? "",
			LANG: process.env.LANG ?? "C",
			GJC_CODING_AGENT_DIR: agentDir,
			[GJC_ATTACH_ONLY_ENV]: "0",
			...brokerEnv,
		};
		const version = await versionOf(exe, env, config.home);
		const pinned = readPinnedGjcVersion();
		if (version !== pinned)
			throw new Error(`broker_host_version_mismatch running=${version ?? "unknown"} required=${pinned}`);
		return await runForegroundBroker(exe, agentDir, env, config.home);
	} catch (error) {
		console.error(`broker_host_refused ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	} finally {
		await lease.release();
	}
}

async function readProvisionManifest(path: string): Promise<Record<string, unknown> | undefined> {
	try {
		const info = await lstat(path);
		if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) return undefined;
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		if (
			record.version !== 2 ||
			typeof record.genId !== "string" ||
			!record.entries ||
			typeof record.entries !== "object"
		)
			return undefined;
		return record;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function validateTargetAgentDb(agentDir: string): Promise<void> {
	const path = join(agentDir, "agent.db");
	const info = await lstat(path).catch(() => undefined);
	if (!info || info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
		throw new BrokerAgentError("broker_agent_unrecoverable", "agent.db must be a regular 0600 file with one link");
	await assertAgentDb(path);
}

async function readBrokerEnvironment(path: string): Promise<Record<string, string>> {
	let info: Stats;
	try {
		info = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new BrokerAgentError(
			"broker_agent_live_link",
			`broker.env unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`,
		);
	}
	if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600)
		throw new BrokerAgentError(
			"broker_agent_live_link",
			"broker.env must be a regular file with mode 0600 and one link",
		);
	const result: Record<string, string> = {};
	for (const [index, raw] of (await readFile(path, "utf8")).split(/\r?\n/).entries()) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new BrokerAgentError("broker_agent_live_link", `broker.env invalid line=${index + 1}`);
		const key = line.slice(0, separator).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in result)
			throw new BrokerAgentError("broker_agent_live_link", `broker.env invalid key line=${index + 1}`);
		result[key] = line.slice(separator + 1);
	}
	return result;
}

async function versionOf(exe: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
	const child = Bun.spawn([exe, "--version"], { cwd, env, stdout: "pipe", stderr: "pipe" });
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (exitCode !== 0) return undefined;
	return (stdout || stderr).match(/\b(\d+\.\d+\.\d+)\b/)?.[1];
}

export async function runForegroundBroker(
	exe: string,
	agentDir: string,
	env: NodeJS.ProcessEnv,
	cwd: string,
	watchdogConfig?: BrokerWatchdogConfig,
): Promise<number> {
	const args = [exe, "sdk", "broker", "run", "--agent-dir", agentDir];
	const child = Bun.spawn(args, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
	const envKeys = Object.keys(env).sort().join(",");
	console.log(`broker_host_started gjc=${exe} agentDir=${agentDir} pid=${child.pid} env_keys=${envKeys}`);
	const forward = (signal: NodeJS.Signals) => {
		try {
			child.kill(signal);
		} catch {
			// The child may have exited between the signal and this callback.
		}
	};
	process.on("SIGTERM", forward);
	process.on("SIGINT", forward);

	const config = { ...DEFAULT_WATCHDOG_CONFIG, ...watchdogConfig };
	const watchdog = startBrokerWatchdog(child, agentDir, config);

	try {
		const exitCode = await child.exited;
		console.log(`broker_host_child_exit pid=${child.pid} code=${exitCode}`);
		return exitCode;
	} finally {
		process.off("SIGTERM", forward);
		process.off("SIGINT", forward);
		watchdog.stop();
	}
}

function startBrokerWatchdog(
	child: ReturnType<typeof Bun.spawn>,
	agentDir: string,
	config: Required<BrokerWatchdogConfig>,
): { stop(): void } {
	const discoveryPath = join(agentDir, "sdk", "broker.json");
	let failureCount = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let killed = false;

	const probe = async () => {
		if (child.exitCode !== null || child.signalCode !== null) {
			// Child has exited; stop watching.
			return;
		}

		const verdict = await judgeBrokerLiveness(discoveryPath, config.isPidAlive);

		// Only consider a verdict if the discovery reports our exact child pid.
		if (verdict.state === "live") {
			// Broker is responding normally.
			failureCount = 0;
			return;
		}

		// Check if there's a discovery record and verify the pid matches.
		try {
			const raw = JSON.parse(await readFile(discoveryPath, "utf8"));
			if (raw && typeof raw === "object" && (raw as Record<string, unknown>).pid !== child.pid) {
				// Different pid in discovery; don't signal.
				return;
			}
		} catch {
			// Discovery file missing or unparseable; proceed with failure count.
		}

		// Broker is either absent or wedged.
		failureCount++;

		if (failureCount >= config.failureThreshold) {
			if (!killed) {
				killed = true;
				console.log(`broker_host_wedged pid=${child.pid} failures=${failureCount}`);
				awaitTerminateWedgedBroker(child, config.killGraceMs);
			}
		}
	};

	const schedule = () => {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		timer = setTimeout(() => {
			probe().catch(() => {
				// Probe errors do not escalate; just retry next interval.
			});
			schedule();
		}, config.probeIntervalMs);
	};

	// Start after grace period.
	timer = setTimeout(schedule, config.startupGraceMs);

	return {
		stop() {
			if (timer) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}

async function awaitTerminateWedgedBroker(child: ReturnType<typeof Bun.spawn>, graceMs: number): Promise<void> {
	try {
		child.kill("SIGTERM");
	} catch {
		// Child may have already exited.
	}

	const deadline = Date.now() + graceMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}

	// Grace period expired; send SIGKILL.
	try {
		child.kill("SIGKILL");
	} catch {
		// Child may have exited just as we tried to kill it.
	}
}
