// Isolated, deterministic Herdsman/SDK join against the pinned real daemon.
// No LLM, simulated daemon, live socket, service restart or operator store.
// RADAR_BIN=/path/to/radar node scripts/radar-subject-acceptance.mjs
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createRadarClient } from 'pi-radar/client';
import { createRadarPublication, readProcessBirth } from 'pi-radar/publication';
import { resolveRadarProcessLocation } from 'pi-radar/location';
import { createRadarChildren } from 'pi-radar/children';
import { createRadarHandoffPort } from 'pi-radar/communication';
import { launchRadarWorker } from 'pi-radar/launch';
import { publishCompletionHandoff, persistAndAcknowledgeCompletion } from '../extension/radar-handoff.ts';
import { persistSealedCompletion, readCompletion, handoffPath } from '../extension/completions.ts';
import { HANDOFF_REQUIRED_SECTIONS } from '../extension/response-contracts.ts';

const exec = promisify(execFile);
const script = fileURLToPath(import.meta.url);
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
async function until(read, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`Timed out: ${label}`);
}
const [mode, root] = process.argv.slice(2);
if (mode === '--worker' || mode === '--parent') {
  try { await participant(mode, root); }
  catch (error) {
    writeFileSync(join(root, mode === '--parent' ? 'result.json' : 'worker-error.json'), JSON.stringify({ ok: false, error: String(error), stack: error.stack }));
    process.exitCode = 1;
  }
} else await main();

async function participant(mode, root) {
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'));
  const client = createRadarClient();
  const publication = createRadarPublication({
    client, dataRoot: join(root, `publication-${process.pid}`),
    registration: { source: 'pi', label: mode.slice(2) }, birth: readProcessBirth(),
    location: () => resolveRadarProcessLocation(client),
  });
  const session = mode === '--parent' ? config.owner : config.session;
  if (mode === '--worker') {
    // Match the baseline extension's awaited session_shutdown release. Killing
    // an SDK-only harness with no shutdown hook leaves a deliberately unreleased
    // claim and is not evidence about a normal Pi worker's close/continue path.
    const shutdown = async () => {
      await publication.presence.release();
      publication.stop();
      process.exit(0);
    };
    for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.once(signal, shutdown);
  }
  publication.presence.report(session);
  const subject = await until(async () => {
    const value = await publication.subject();
    return value?.subject_id ? value : undefined;
  }, `${mode} subject (${publication.diagnostic() ?? ''})`);
  const port = createRadarHandoffPort(client, publication);
  if (mode === '--worker') {
    // The worker writes the artifact; neither its final chat nor the owner
    // constructs the report. Every incarnation seals exactly the same bytes.
    const content = '---\nschema: handoff/v1\ntitle: Acceptance report\nsummary: Real worker handoff\n---\n\n' +
      HANDOFF_REQUIRED_SECTIONS.map((heading) => `## ${heading}\n\nDeterministic acceptance evidence.\n`).join('\n');
    writeFileSync(join(root, 'worker-handoff.md'), content);
    await publishCompletionHandoff(port, {
      requestId: config.request, runId: config.run, status: 'completed', agentLabel: 'acceptance',
      text: 'acknowledgement, not the report',
      handoff: { title: 'Acceptance report', summary: 'Real worker handoff', content: readFileSync(join(root, 'worker-handoff.md'), 'utf8') },
    });
    writeFileSync(join(root, 'worker.json'), JSON.stringify({ subject: subject.subject_id, pid: process.pid }));
    // Stay in the foreground until Radar closes/restarts this exact process.
    await new Promise(() => setInterval(() => {}, 60000));
  }
  const children = createRadarChildren(client, publication);
  const program = {
    executable: join(root, 'worker'), argv: [], cwd: resolve('.'),
    env: { RADAR_CONTROL_SOCKET: process.env.RADAR_CONTROL_SOCKET },
  };
  const events = [];
  try {
    const ready = await launchRadarWorker({ client, publication, launch: {
      request_id: randomUUID(), pane_id: subject.location.pane,
      parent_session_id: config.owner, ...program,
    } });
    assert.equal(ready.kind, 'ready', JSON.stringify(ready));
    const worker = ready.value.subject_id;
    events.push('launch-ready');
    const inbox = await until(async () => {
      const value = await port.inbox();
      return value.ok && value.value.handoff_ids.includes(config.request) ? value : undefined;
    }, 'worker handoff in parent inbox');
    assert.ok(inbox.ok);
    const retrieved = await port.get(config.request);
    assert.ok(retrieved.ok, JSON.stringify(retrieved));
    assert.equal(retrieved.value.handoff.content, readFileSync(join(root, 'worker-handoff.md'), 'utf8'));
    await persistAndAcknowledgeCompletion(port, retrieved.value.handoff,
      { runId: config.run, subjectId: worker }, (report) => {
        persistSealedCompletion({ requestId: report.requestId, ownerSessionId: config.owner,
          runId: config.run, workspaceId: 'acceptance', agentLabel: 'acceptance',
          paneId: ready.value.pane_id, cwd: root, definition: 'acceptance',
          piSessionId: config.session, piSessionFile: join(root, 'worker-session.jsonl'),
        }, report, Date.now());
      });
    const completion = readCompletion(config.owner, config.request);
    assert.equal(readFileSync(handoffPath(completion), 'utf8'), retrieved.value.handoff.content);
    const repeat = await port.get(config.request);
    assert.ok(repeat.ok && repeat.value.receipt);
    assert.equal(repeat.value.handoff.content, retrieved.value.handoff.content);
    events.push('sealed-handoff-persist-then-ack', 'repeat-retrieval');
    const restarted = await children.restart(worker, program);
    assert.equal(restarted.kind, 'ready', JSON.stringify(restarted));
    assert.equal(restarted.value.subject_id, worker);
    events.push('restart-same-subject');
    const closeId = randomUUID();
    const closed = await children.close(worker, 'complete', closeId);
    assert.ok(['completed', 'already_exited'].includes(closed.outcome), JSON.stringify(closed));
    assert.deepEqual(await children.close(worker, 'complete', closeId), closed);
    events.push('close-replay');
    await until(async () => (await children.observe(worker)).kind === 'gone', 'closed worker detached');
    const retained = await children.list('retained');
    assert.ok(retained.ok && retained.value.some((row) => row.subject_id === worker), JSON.stringify(retained));
    events.push('retained-roster');
    const continued = await launchRadarWorker({ client, publication, launch: {
      request_id: randomUUID(), pane_id: subject.location.pane,
      parent_session_id: config.owner, continues: worker, ...program,
    } });
    assert.equal(continued.kind, 'ready', JSON.stringify(continued));
    assert.equal(continued.value.subject_id, worker);
    events.push('continue-same-subject');
    const final = await children.close(worker, 'complete');
    assert.ok(['completed', 'already_exited'].includes(final.outcome), JSON.stringify(final));
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: true, events, subject: worker }));
  } catch (error) {
    writeFileSync(join(root, 'result.json'), JSON.stringify({ ok: false, events, error: String(error), stack: error.stack }));
  } finally { await publication.presence.release(); publication.stop(); }
}

async function main() {
  const binary = process.env.RADAR_BIN;
  assert.ok(binary && existsSync(binary), 'RADAR_BIN must name the pinned daemon');
  const root = mkdtempSync(join(tmpdir(), 'herdsman-radar-'));
  const server = `herdsman-accept-${randomUUID().slice(0, 8)}`;
  const socket = join(root, 'control.sock');
  const state = join(root, 'state');
  mkdirSync(state, { mode: 0o700 });
  writeFileSync(join(root, 'config.json'), JSON.stringify({ owner: randomUUID(), session: randomUUID(), request: randomUUID(), run: randomUUID() }));
  // A standalone harness executable keeps Node's script operands out of the
  // Pi launch argument grammar. Radar still owns all process/subject checks.
  writeFileSync(join(root, 'worker'), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} --worker ${quote(root)}\n`, { mode: 0o700 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(HERDR_|PI_RADAR_|PI_HERDSMAN_)/.test(key) && !['TMUX', 'TMUX_PANE'].includes(key)));
  Object.assign(env, { RADAR_CONTROL_BACKEND: 'tmux', RADAR_TMUX_SERVER: server,
    RADAR_CONTROL_STATE: state, RADAR_CONTROL_SOCKET: socket, PI_HERDSMAN_DATA_DIR: join(root, 'herdsman'),
    // The pinned daemon parses the operator's own config by default, and a newer
    // config's fields are fatal to an older binary. Name one inside the run.
    RADAR_CONFIG: join(root, 'radar-config.toml'), XDG_CONFIG_HOME: join(root, 'xdg') });
  let daemon;
  let logs = '';
  const tmux = (...args) => exec('tmux', ['-L', server, ...args], { env });
  try {
    // Radar serves only a server owned by its named unit. Start a uniquely
    // named instance, never the operator's server or daemon service.
    const unit = `radar-tmux@${server}.service`;
    const template = await exec('systemctl', ['--user', 'cat', 'radar-tmux@.service']).then(() => true, () => false);
    if (template) await exec('systemctl', ['--user', 'start', unit]);
    else await exec('systemd-run', ['--user', '--collect', '--quiet', `--unit=${unit}`,
      '--property=Type=simple', '--property=KillMode=control-group',
      'tmux', '-D', '-L', server, '-f', '/dev/null']);
    await until(async () => tmux('show-options', '-g').then(() => true, () => false), 'isolated tmux unit');
    await tmux('new-session', '-d', '-s', 'accept', '-x', '160', '-y', '45', 'sleep 86400');
    daemon = spawn(binary, ['daemon'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    daemon.stdout.on('data', (x) => { logs += x; }); daemon.stderr.on('data', (x) => { logs += x; });
    await until(() => existsSync(socket), 'daemon socket');
    await tmux('respawn-pane', '-k', '-t', 'accept:0.0',
      `exec env RADAR_CONTROL_SOCKET=${quote(socket)} PI_HERDSMAN_DATA_DIR=${quote(env.PI_HERDSMAN_DATA_DIR)} ${quote(process.execPath)} ${quote(script)} --parent ${quote(root)}`);
    await until(() => existsSync(join(root, 'result.json')), 'parent acceptance result', 90000);
    const result = JSON.parse(readFileSync(join(root, 'result.json'), 'utf8'));
    console.log(JSON.stringify({ ...result, daemonSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
      daemonVersion: (await exec(binary, ['--version'])).stdout.trim() }, null, 2));
    assert.ok(result.ok, JSON.stringify(result));
  } catch (error) {
    console.error(logs);
    if (existsSync(join(root, 'worker-error.json'))) console.error(readFileSync(join(root, 'worker-error.json'), 'utf8'));
    throw error;
  } finally {
    await exec('systemctl', ['--user', 'stop', `radar-tmux@${server}.service`]).catch(() => {});
    if (daemon && daemon.exitCode === null) { daemon.kill('SIGTERM'); await once(daemon, 'exit'); }
    rmSync(root, { recursive: true, force: true });
  }
}
