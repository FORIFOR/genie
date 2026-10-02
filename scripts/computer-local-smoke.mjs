#!/usr/bin/env node
// Opt-in real local-model/native smoke. This exercises the production runtime,
// LLM adapter and native consent, but deliberately does not claim gateway/UI E2E.
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ComputerVisionRuntime } from '../workers/agent-host/dist/computer-vision.js';
import { NativeVisionDevice } from '../workers/agent-host/dist/computer-vision-device.js';
import { LlmRuntime } from '../workers/agent-host/dist/llm-steps.js';
import { HttpLlmClient } from '../workers/agent-host/dist/http-llm.js';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const help = `Usage: node scripts/computer-local-smoke.mjs --root <evidence-parent> --helper <production-background-helper>
  [--model qwen3.5:9b] [--endpoint http://127.0.0.1:11434/v1]
  [--fixture <compiled tools/computer-use/BackgroundFixture.swift executable>]
  [--fixture-start regular|accessory-then-regular]

Build first: pnpm exec tsc -b workers/agent-host
This opens a disposable AppKit fixture and the normal native target-consent dialog.
Select "Genie Smoke Target" / "Genie Background Target" in that dialog.
Only that fixture PID and bundle ID may reach the local model or receive input.
The helper must report deliveryMode=background and unattendedTest=false.
Optional accessory-then-regular stages only the disposable fixture windows on the current Space.
Results are stored in a fresh run-* directory below --root. No cloud fallback.
`;

function options() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return null;
  const parsed = {
    model: 'qwen3.5:9b',
    endpoint: 'http://127.0.0.1:11434/v1',
    'fixture-start': 'regular',
  };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^--/, '');
    if (
      !['root', 'helper', 'model', 'endpoint', 'fixture', 'fixture-start'].includes(key) ||
      !args[i + 1]
    )
      throw new Error(`Invalid option ${args[i]}. Use --help.`);
    parsed[key] = args[i + 1];
  }
  if (!parsed.root || !parsed.helper || !isAbsolute(parsed.helper))
    throw new Error('--root and an absolute --helper path are required.');
  if (/:cloud(?:$|[-/])/i.test(parsed.model))
    throw new Error('Cloud-served models are excluded from this smoke.');
  if (!['regular', 'accessory-then-regular'].includes(parsed['fixture-start']))
    throw new Error('--fixture-start must be regular or accessory-then-regular.');
  return parsed;
}

async function waitForFixture(path, child) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error('Fixture exited before it was ready.');
    try {
      const readback = JSON.parse(await readFile(path, 'utf8'));
      if (readback.startupReady !== false) return readback;
    } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    await delay(100);
  }
  throw new Error('Fixture did not produce its readback file within 10 seconds.');
}

async function main() {
  const opts = options();
  if (!opts) {
    process.stdout.write(help);
    return;
  }
  if (process.platform !== 'darwin') throw new Error('This smoke requires macOS.');
  // HttpLlmClient validates loopback-only URLs and refuses HTTP redirects. The
  // extra guard covers every request made by this instance, including discovery.
  const modelOrigin = new URL(opts.endpoint).origin;
  const client = new HttpLlmClient({
    kind: 'local',
    endpoint: opts.endpoint,
    model: opts.model,
    timeoutMs: 60_000,
    maxOutputTokens: 800,
    fetch: (url, init) => {
      if (new URL(url).origin !== modelOrigin) throw new Error('Nonlocal model request refused.');
      return fetch(url, { ...init, redirect: 'error' });
    },
  });
  const llm = new LlmRuntime({ allowedKinds: ['local'], http: { local: client } });
  await mkdir(resolve(opts.root), { recursive: true, mode: 0o700 });
  const runRoot = await mkdtemp(join(await realpath(resolve(opts.root)), 'run-'));
  const cache = join(runRoot, 'VisualContext');
  await mkdir(cache, { mode: 0o700 });
  process.env.ASTRA_VISUAL_CONTEXT_DIR = cache;
  process.env.ASTRA_COMPUTER_STAGE_LOG = 'on';
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const report = {
    scope:
      'real local model -> ComputerVisionRuntime -> NativeVisionDevice -> production native consent -> disposable AppKit fixture',
    excludes: [
      'gateway/task-worker path',
      'main app UI',
      'human concurrent-input acceptance',
      'external applications',
    ],
    startedAt: new Date().toISOString(),
    root: runRoot,
    model: { kind: 'local', name: opts.model, endpoint: opts.endpoint },
    helper: opts.helper,
    fixtureStart: opts['fixture-start'],
    modelCalls: [],
    status: 'RUNNING',
  };
  let fixture;
  let sentinel;
  try {
    report.revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: repo })).stdout.trim();
    report.executedFileHashes = Object.fromEntries(
      await Promise.all(
        [
          opts.helper,
          ...[
            'computer-vision.js',
            'computer-vision-policy.js',
            'computer-vision-prompts.js',
            'computer-vision-device.js',
            'llm-steps.js',
            'http-llm.js',
            'visual-context.js',
          ].map((name) => join(repo, 'workers/agent-host/dist', name)),
        ].map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        ]),
      ),
    );
    const status = JSON.parse((await exec(opts.helper, ['--status'], { timeout: 10_000 })).stdout);
    report.helperStatus = status;
    if (!status.ready || status.deliveryMode !== 'background' || status.unattendedTest !== false)
      throw new Error('A ready production background helper with native consent is required.');
    const available = await llm.options();
    if (!available.some((option) => option.kind === 'local' && option.available))
      throw new Error(`The selected local model is unavailable: ${opts.model}`);
    const appDir = join(runRoot, 'GenieSmokeTarget.app', 'Contents');
    await mkdir(join(appDir, 'MacOS'), { recursive: true, mode: 0o700 });
    const executable = join(appDir, 'MacOS', 'Fixture');
    if (opts.fixture) await copyFile(resolve(opts.fixture), executable);
    else
      await exec(
        'swiftc',
        [join(repo, 'tools/computer-use/BackgroundFixture.swift'), '-o', executable],
        { timeout: 120_000 },
      );
    const bundleId = `org.genie.smoke.${randomUUID().replaceAll('-', '')}`;
    await writeFile(
      join(appDir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleName</key><string>Genie Smoke Target</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
      { mode: 0o600 },
    );
    const readback = join(runRoot, 'fixture-readback.json');
    fixture = spawn(executable, [], {
      env: {
        ...process.env,
        GENIE_FIXTURE_ROLE: 'target',
        GENIE_FIXTURE_PASSIVE: '0',
        GENIE_FIXTURE_ALL_SPACES: '1',
        GENIE_FIXTURE_ACTIVATE: '1',
        GENIE_FIXTURE_STAGE_ACCESSORY:
          opts['fixture-start'] === 'accessory-then-regular' ? '1' : '0',
        GENIE_FIXTURE_RESULT: readback,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    fixture.stderr.on('data', (chunk) => process.stderr.write(chunk));
    fixture.on('error', stop);
    report.fixture = {
      pid: fixture.pid,
      bundleId,
      source: 'tools/computer-use/BackgroundFixture.swift',
    };
    report.fixtureStartup = await waitForFixture(readback, fixture);
    // Start a second disposable input sentinel. Its observed activation state is
    // recorded below; requesting activation alone does not prove foreground status.
    await delay(300);
    const sentinelDir = join(runRoot, 'GenieSmokeSentinel.app', 'Contents');
    await mkdir(join(sentinelDir, 'MacOS'), { recursive: true, mode: 0o700 });
    await copyFile(executable, join(sentinelDir, 'MacOS', 'Fixture'));
    await writeFile(
      join(sentinelDir, 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}.sentinel</string><key>CFBundleName</key><string>Genie Smoke Sentinel</string><key>CFBundleExecutable</key><string>Fixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>`,
    );
    const sentinelReadback = join(runRoot, 'sentinel-readback.json');
    sentinel = spawn(join(sentinelDir, 'MacOS', 'Fixture'), [], {
      env: {
        ...process.env,
        GENIE_FIXTURE_ROLE: 'sentinel',
        GENIE_FIXTURE_PASSIVE: '0',
        GENIE_FIXTURE_ALL_SPACES: '1',
        GENIE_FIXTURE_STAGE_ACCESSORY:
          opts['fixture-start'] === 'accessory-then-regular' ? '1' : '0',
        GENIE_FIXTURE_RESULT: sentinelReadback,
      },
      stdio: 'ignore',
    });
    report.sentinel = { pid: sentinel.pid, bundleId: `${bundleId}.sentinel` };
    report.sentinelStartup = await waitForFixture(sentinelReadback, sentinel);
    await delay(300);

    const device = new NativeVisionDevice(opts.helper);
    const scopedDevice = {
      claim: (id) => device.claim(id),
      stopped: (id, code, audit) => device.stopped(id, code, audit),
      begin: async (goal, recipient, signal) => {
        const frame = await device.begin(goal, recipient, signal);
        if (frame.pid !== fixture.pid || frame.bundleId !== bundleId)
          throw new Error(
            'Selected window is not the disposable smoke fixture. No model call or input is allowed.',
          );
        return frame;
      },
      capture: (scope, signal) => device.capture(scope, signal),
      resume: (scope, signal) => device.resume(scope, signal),
      previewTarget: (frame, action, signal, expiresAt) =>
        device.previewTarget(frame, action, signal, expiresAt),
      apply: (frame, action, signal, expiresAt) => device.apply(frame, action, signal, expiresAt),
      close: () => device.close(),
    };
    const runtime = new ComputerVisionRuntime({
      enabled: true,
      allowExternalPixels: false,
      selectModel: async () => 'local',
      device: () => scopedDevice,
      maxActions: 4,
      timeoutMs: 300_000,
      model: {
        run: async (step, signal) => {
          const started = Date.now();
          const info = { tool: step.toolId, phase: step.args.phase ?? 'plan' };
          process.stderr.write(`MODEL ${info.phase} started\n`);
          const answer = await llm.run(step, signal);
          const metadata = {
            ...info,
            ms: Date.now() - started,
            ok: answer.ok,
            ...(answer.error ? { code: answer.error.code } : {}),
            ...(answer.result?.outcome ? { outcome: answer.result.outcome } : {}),
            ...(answer.result?.action ? { action: answer.result.action } : {}),
          };
          report.modelCalls.push(metadata);
          process.stderr.write(`MODEL ${JSON.stringify(metadata)}\n`);
          return answer;
        },
      },
    });
    // Capture baselines after both apps have settled, not during the target's
    // asynchronous startup activation. No consent or model timeout starts here.
    [report.before, report.sentinelBefore] = await Promise.all(
      [readback, sentinelReadback].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    );
    report.preflight = {
      targetVisible: report.before.isVisible === true,
      targetOnActiveSpace: report.before.isOnActiveSpace === true,
      ...(opts['fixture-start'] === 'accessory-then-regular'
        ? {
            targetRegular: report.before.activationPolicy === 'regular',
            sentinelRegular: report.sentinelBefore.activationPolicy === 'regular',
          }
        : {}),
    };
    if (!Object.values(report.preflight).every(Boolean))
      throw new Error(
        'The disposable target is not visible on the active Space. Native consent was not opened and no model call or input was attempted. Show the fixture on the current desktop before running this smoke again.',
      );
    const started = Date.now();
    const expectedText = 'Genie local smoke';
    process.stderr.write(
      `Evidence: ${runRoot}\nSelect "Genie Smoke Target" / "Genie Background Target" in the native consent dialog.\n`,
    );
    report.outcome = await runtime.run(
      {
        id: `local-smoke-${randomUUID()}`,
        toolId: 'computer.run',
        args: {
          goal: `In this test window, enter "${expectedText}" into the large empty text area, then click "Show details". Leave the protected field untouched.`,
          successCriteria: `The large text area reads "${expectedText}"; The heading reads "Details open".`,
        },
        // The harness supplies the host request authorization for this synthetic
        // fixture task. The real native scope/recipient consent still runs in begin.
        approval: {
          approvalId: `smoke-${randomUUID()}`,
          operationId: 'computer.run',
          decision: 'APPROVED',
          decidedBy: 'local-smoke-operator',
          decidedAt: new Date(started).toISOString(),
          expiresAt: new Date(started + 600_000).toISOString(),
        },
      },
      controller.signal,
    );
    await delay(150);
    [report.after, report.sentinelAfter] = await Promise.all(
      [readback, sentinelReadback].map(async (path) => JSON.parse(await readFile(path, 'utf8'))),
    );
    report.readbackChecks = {
      textMatches: report.after.text === expectedText,
      clickedExactlyOnce: report.after.clicks === 1,
      targetDidNotActivate: report.after.activations === report.before.activations,
      sentinelTextPreserved: report.sentinelAfter.text === report.sentinelBefore.text,
      sentinelClicksPreserved: report.sentinelAfter.clicks === report.sentinelBefore.clicks,
    };
    report.status =
      report.outcome.ok && Object.values(report.readbackChecks).every(Boolean) ? 'PASS' : 'FAIL';
    if (report.status !== 'PASS') process.exitCode = 1;
  } catch (error) {
    report.status = 'BLOCKED';
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    controller.abort();
    if (fixture?.exitCode === null) fixture.kill('SIGTERM');
    if (sentinel?.exitCode === null) sentinel.kill('SIGTERM');
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    report.finishedAt = new Date().toISOString();
    await writeFile(join(runRoot, 'result.json'), JSON.stringify(report, null, 2) + '\n', {
      mode: 0o600,
    });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  }
}

await main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
