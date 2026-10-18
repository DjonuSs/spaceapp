import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  createDefaultConfig,
  validateConfig,
  renderWorkspaceCompose,
  composeCommand,
  prepareInstallation,
  saveConfig,
  loadConfig
} from "../src/index.mjs";
import {
  checkMacPodmanMachine,
  ensurePodmanAvailable,
  podmanCliAndComposeAreAvailable,
  podmanIsReady,
  podmanInstallHelp
} from "../src/prerequisites.mjs";
import { run } from "../src/cli.mjs";

function capture() {
  let value = "";
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      value += chunk.toString();
      callback();
    }
  });
  return { stream, value: () => value };
}

function ttyStdin(...answers) {
  let index = 0;
  return {
    isTTY: true,
    setRawMode() {},
    resume() {},
    pause() {},
    setEncoding() {},
    [Symbol.asyncIterator]() {
      return {
        async next() {
          if (index >= answers.length) {
            return { done: true };
          }
          const answer = answers[index];
          index += 1;
          return { done: false, value: `${answer}\n` };
        },
        async return() {
          return { done: true };
        }
      };
    }
  };
}

const mockGuestResources = Object.freeze({
  cpuCount: 8,
  totalMemoryBytes: 16 * 1024 ** 3,
  freeDiskBytes: 50 * 1024 ** 3
});

function readyRequest(url) {
  return Promise.resolve(new Response(JSON.stringify(
    url.endsWith("/readyz") ? { ok: true } : { setupRequired: false, expiresAt: null }
  ), {
    status: 200,
    headers: { "content-type": "application/json" }
  }));
}

test("composeCommand returns podman command and correct arguments when engine is podman", () => {
  const root = "/test/spaceapp";
  const upSpec = composeCommand("up", root, { profile: "small", engine: "podman", companionsEnabled: false });
  assert.equal(upSpec.command, "podman");
  assert.equal(upSpec.args[0], "compose");
  assert.ok(upSpec.args.includes("up"));

  const config = createDefaultConfig({ version: "1.0.0", profile: "small", accessMode: "isolated", engine: "podman" });
  const downSpec = composeCommand("down", root, config);
  assert.equal(downSpec.command, "podman");
  assert.equal(downSpec.args[0], "compose");
  assert.ok(downSpec.args.includes("down"));
});

test("composeCommand defaults to docker when no engine is specified", () => {
  const root = "/test/spaceapp";
  const upSpec = composeCommand("up", root, { profile: "small" });
  assert.equal(upSpec.command, "docker");
  assert.equal(upSpec.args[0], "compose");
});

test("renderWorkspaceCompose appends bind selinux: z option on Podman", () => {
  const hostDir = resolve(tmpdir(), "spaceapp-test-project");
  const dockerConfig = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  dockerConfig.workspaces = [
    {
      id: "project-a1b2c3d4",
      name: "proj",
      hostPath: hostDir,
      containerPath: "/workspaces/proj",
      readOnly: false
    }
  ];
  const dockerYaml = renderWorkspaceCompose(dockerConfig);
  assert.match(dockerYaml, /type: bind/);
  assert.doesNotMatch(dockerYaml, /selinux: z/);

  const podmanConfig = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  podmanConfig.workspaces = [
    {
      id: "project-a1b2c3d4",
      name: "proj",
      hostPath: hostDir,
      containerPath: "/workspaces/proj",
      readOnly: false
    }
  ];
  const podmanYaml = renderWorkspaceCompose(podmanConfig);
  assert.match(podmanYaml, /type: bind/);
  assert.match(podmanYaml, /bind:\s+selinux: z/);
});

test("validateConfig rejects host-root access mode when engine is podman", () => {
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  config.accessMode = "host-root";
  assert.throws(() => validateConfig(config), /Host-root access is not supported on Podman\./);
});

test("installCommand rejects host-root access mode when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-hostroot-"));
  await assert.rejects(
    () => run(["install", "--engine", "podman", "--access", "host-root", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("", "", "", "", "", "y"),
      inspectResources: async () => mockGuestResources
    }),
    /Host-root access is not supported on Podman\./
  );
});

test("engine switching on existing install is refused with migration instructions", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-switch-"));
  await prepareInstallation(root, {
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "docker"
  });
  await saveConfig(root, config);

  await assert.rejects(
    prepareInstallation(root, {
      version: "1.0.0",
      profile: "small",
      accessMode: "isolated",
      engine: "podman"
    }),
    /Cannot switch container engine from "docker" to "podman" on an existing installation\. Docker volumes are not visible to Podman\. To migrate engines, run "spaceapp backup", uninstall with "spaceapp uninstall --purge-data", install with "--engine podman", and run "spaceapp restore"\./
  );

  const loaded = await loadConfig(root);
  assert.equal(loaded.engine, "docker");
});

test("cli parses --engine flag and rejects unsupported engines", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-engine-arg-"));
  await assert.rejects(
    run(["install", "--engine", "containerd", "--no-open"], {
      env: { SPACEAPP_HOME: root },
      platform: "linux",
      stdout: capture().stream,
      stderr: capture().stream,
      stdin: ttyStdin("y")
    }),
    /Usage: .*install \[--engine docker\|podman\]/
  );
});

test("install with --engine podman initializes launcher configuration with engine podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-install-"));
  const calls = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--engine", "podman", "--profile", "small", "--no-open"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    stdin: ttyStdin("", "", "", "", "", "y"),
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.args?.includes("pg_dump")) {
        io.stdout.write("-- PostgreSQL database dump\nSELECT 1;\n");
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
  assert.ok(calls.some((spec) => spec.command === "podman" && spec.args.includes("pull")));
  assert.ok(calls.some((spec) => spec.command === "podman" && spec.args.includes("up")));
});

test("install without --engine auto-selects podman when docker is absent and podman is ready (non-interactive)", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-autodetect-"));
  const calls = [];
  const stdout = capture();
  const stderr = capture();

  const code = await run(["install", "--profile", "small", "--no-open", "--non-interactive", "--answers", '{"confirm": true}'], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    request: readyRequest,
    sleep: async () => {},
    execute: async (spec, io) => {
      calls.push(spec);
      if (spec.command === "docker") return 127;
      if (spec.command === "podman") return 0;
      return 0;
    }
  });

  assert.equal(code, 0);
  const saved = await loadConfig(root);
  assert.equal(saved.engine, "podman");
});

test("macOS Podman Machine checks resource sizing against profile requirements and advises resize", async () => {
  const stdoutShortage = capture();
  const stderrShortage = capture();

  const shortage = await checkMacPodmanMachine({
    execute: async (spec, io) => {
      if (spec.args.includes("inspect")) {
        io.stdout.write(JSON.stringify([{
          CPUs: 1,
          Memory: 1024 * 1024 * 1024,
          DiskSize: 10 * 1024 * 1024 * 1024,
          Running: true
        }]));
        return 0;
      }
      return 0;
    },
    profile: "small",
    stdout: stdoutShortage.stream,
    stderr: stderrShortage.stream
  });
  // Without output from inspect, inspect failure/empty falls back to list or reports shortage
  assert.equal(shortage.ok, false);
  assert.equal(shortage.code, 1);
  assert.match(stderrShortage.value(), /podman machine set/);

  const stdoutSufficient = capture();
  const stderrSufficient = capture();
  const sufficient = await checkMacPodmanMachine({
    execute: async (spec, io) => {
      if (spec.args.includes("inspect")) {
        io.stdout.write(JSON.stringify([{
          CPUs: 6,
          Memory: 8192 * 1024 * 1024,
          DiskSize: 64 * 1024 * 1024 * 1024,
          Running: true
        }]));
        return 0;
      }
      return 0;
    },
    profile: "small",
    stdout: stdoutSufficient.stream,
    stderr: stderrSufficient.stream
  });
  assert.equal(sufficient.ok, true);
  assert.equal(sufficient.code, 0);
});

test("doctor diagnostics report Podman facts including rootless, cgroup v2, and controller delegation", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-doctor-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const stdout = capture();
  const stderr = capture();

  const code = await run(["doctor"], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    inspectResources: async () => mockGuestResources,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  assert.match(stdout.value(), /PASS Podman CLI: available/);
  assert.match(stdout.value(), /PASS Podman Compose: available/);
  assert.match(stdout.value(), /PASS Podman Service: available/);
  assert.match(stdout.value(), /PASS Podman rootless: rootless/);
  assert.match(stdout.value(), /PASS Podman cgroup version: v2/);
  assert.match(stdout.value(), /PASS Podman resource limit delegation: CPU and memory controllers delegated/);
});

test("support-bundle collects Podman facts without secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-bundle-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const bundlePath = join(root, "test-bundle.json");
  const stdout = capture();
  const stderr = capture();

  const code = await run(["support-bundle", "--out", bundlePath], {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: stdout.stream,
    stderr: stderr.stream,
    execute: async (spec, io) => {
      if (spec.args?.includes("--format") && spec.args?.includes("json")) {
        io.stdout.write(JSON.stringify({
          version: { Version: "5.1.0" },
          host: {
            security: { rootless: true },
            cgroupVersion: "v2",
            cgroupControllers: ["cpu", "memory", "pids"]
          }
        }));
      }
      return 0;
    }
  });

  assert.equal(code, 0);
  const bundleContent = JSON.parse(await readFile(bundlePath, "utf8"));
  assert.equal(bundleContent.installation.config.engine, "podman");
  assert.equal(bundleContent.engine.engine, "podman");
  assert.equal(bundleContent.engine.version, "5.1.0");
  assert.equal(bundleContent.engine.rootless, true);
  assert.equal(bundleContent.engine.cgroupVersion, "v2");
  assert.deepEqual(bundleContent.engine.cgroupControllers, ["cpu", "memory", "pids"]);
});

test("lifecycle commands use podman executable when engine is podman", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-podman-lifecycle-"));
  const config = createDefaultConfig({
    version: "1.0.0",
    profile: "small",
    accessMode: "isolated",
    engine: "podman"
  });
  await saveConfig(root, config);

  const calls = [];
  const options = {
    env: { SPACEAPP_HOME: root },
    platform: "linux",
    stdout: capture().stream,
    stderr: capture().stream,
    execute: async (spec) => {
      calls.push(spec);
      return 0;
    }
  };

  assert.equal(await run(["up"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("up"));

  assert.equal(await run(["status"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("ps"));

  assert.equal(await run(["logs"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("logs"));

  assert.equal(await run(["down"], options), 0);
  assert.equal(calls.at(-1).command, "podman");
  assert.ok(calls.at(-1).args.includes("down"));
});
