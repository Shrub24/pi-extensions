#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$repo_root"

image=pi-herdsman:smoke
name="pi-herdsman-smoke-$$"
home="${name}-home"
ssh_state="${name}-ssh"
custom_volume="${name}-identity-home"
tmp="$(mktemp -d)"
port=

cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$home" "$ssh_state" >/dev/null 2>&1 || true
  if [ -n "${custom_volume:-}" ]; then
    docker volume rm "$custom_volume" >/dev/null 2>&1 || true
  fi
  if [ -d "$tmp/custom-home" ] && docker image inspect "$image" >/dev/null 2>&1; then
    docker run --rm \
      --entrypoint /bin/sh \
      -v "$tmp:/cleanup" \
      "$image" \
      -c 'rm -rf /cleanup/custom-home' >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
}
trap cleanup EXIT

ssh-keygen -q -t ed25519 -N '' -f "$tmp/id"

docker build --platform linux/amd64 -f pi-herdsman/Dockerfile -t "$image" .

default_ids="$(
  docker run --rm --entrypoint /bin/sh "$image" \
    -c 'printf "%s:%s" "$(id -u herdsman)" "$(id -g herdsman)"'
)"

if docker run --rm \
  -e PUID=0 \
  "$image" >"$tmp/invalid-id.log" 2>&1; then
  echo "PUID=0 unexpectedly succeeded" >&2
  exit 1
fi
grep -q 'PUID must be a positive decimal integer' "$tmp/invalid-id.log"

expected_pi="$(node -p 'require("./pi-herdsman/package.json").piHerdsman.runtime.pi')"
expected_radar="$(node -p 'require("./pi-herdsman/package.json").piHerdsman.runtime.radar.commit')"

start() {
  docker run -d \
    --name "$name" \
    -p 127.0.0.1::22 \
    -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
    -v "$home:/home/herdsman" \
    -v "$ssh_state:/var/lib/herdsman/ssh" \
    "$image" >/dev/null

  port="$(docker port "$name" 22/tcp | sed 's/.*://')"
  for _ in $(seq 1 60); do
    if ssh -F /dev/null -i "$tmp/id" -p "$port" \
      -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no \
      -o UserKnownHostsFile=/dev/null herdsman@127.0.0.1 true 2>/dev/null; then
      return
    fi
    sleep 1
  done
  docker logs "$name"
  echo "SSH did not become ready" >&2
  return 1
}

remote() {
  ssh -F /dev/null -i "$tmp/id" -p "$port" \
    -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null herdsman@127.0.0.1 "$@"
}

# Every check is joined to the next with &&: the remote shell has no errexit, so a
# semicolon list would let the last check's status speak for all the earlier ones,
# and a negated check is exempt from errexit under `set -e` anyway.
verify_runtime() {
  remote "test \"\$(pi --version)\" = '$expected_pi' && \
    test \"\$(readlink -f \"\$(command -v pi)\")\" = /opt/pi/pi && \
    npm_global=\"\$(npm list -g --depth=0 2>/dev/null)\" && \
    ! printf '%s\n' \"\$npm_global\" | grep -q '@earendil-works/pi-coding-agent' && \
    command -v node >/dev/null && node --version | grep -q '^v26\\.' && \
    command -v radar >/dev/null && command -v tmux >/dev/null && \
    ! command -v herdr >/dev/null 2>&1 && test ! -e /usr/local/bin/herdr && \
    test \"\$(cat /usr/share/doc/pi-herdsman/radar-commit)\" = '$expected_radar' && \
    command -v mise >/dev/null && mise --version >/dev/null && \
    command -v rg >/dev/null && command -v fd >/dev/null && \
    command -v jq >/dev/null && command -v gh >/dev/null && \
    command -v python3 >/dev/null && command -v git >/dev/null && \
    test -r /AGENTS.md && \
    grep -q '^# Pi Herdsman container environment$' /AGENTS.md && \
    grep -q '/opt/pi-herdsman' ~/.pi/agent/settings.json && \
    pi --offline --help >/tmp/pi-help 2>&1 && \
    ! grep -q 'Failed to load extension' /tmp/pi-help"
}

# The entrypoint's tmux server holds the one pane it created, running Pi, and the
# daemon in the container answers for that pane and the registration Pi's own
# Herdsman extension wrote for itself.
verify_stack() {
  panes="$(docker exec --user herdsman "$name" \
    tmux -L herdsman list-panes -a -F '#{pane_id} #{pane_current_command}')"
  pi_panes="$(printf '%s\n' "$panes" | grep -cE '^%[0-9]+ pi$' || true)"
  if [ "$pi_panes" != 1 ]; then
    echo "the herdsman tmux server does not hold exactly one pane running Pi: $panes" >&2
    exit 1
  fi
  remote 'node - /run/herdsman/control.sock' <"$tmp/radar-stack.cjs"
}

cat >"$tmp/radar-stack.cjs" <<'PROBE'
// The container's Radar stack, read over its own control socket: the backend and
// tmux server it was started for, the pane the entrypoint created, and the Pi in
// that pane that the Herdsman extension registered. Reads only.

const { connect } = require("node:net");
const { randomUUID } = require("node:crypto");

const socket = process.argv[2];
const deadline = Date.now() + Number(process.env.RADAR_PROBE_WAIT_MS || 30000);

function request(method, params) {
  return new Promise((resolve, reject) => {
    const client = connect(socket);
    const id = randomUUID();
    let buffered = "";
    client.setEncoding("utf8");
    client.on("error", reject);
    client.on("data", (chunk) => {
      buffered += chunk;
      const end = buffered.indexOf("\n");
      if (end === -1) return;
      const line = buffered.slice(0, end);
      client.destroy();
      let reply;
      try {
        reply = JSON.parse(line);
      } catch {
        reject(new Error(`${method}: unparsable reply ${line}`));
        return;
      }
      if (reply.error) {
        reject(new Error(`${method}: refused ${reply.error.code}: ${reply.error.message}`));
      } else if (reply.id !== id) {
        reject(new Error(`${method}: mismatched reply id ${reply.id}`));
      } else {
        resolve(reply.result);
      }
    });
    client.write(`${JSON.stringify({ version: 2, id, method, params })}\n`);
  });
}

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function main() {
  const problems = [];

  const ping = await request("daemon.ping", {});
  if (ping.protocol !== 2) problems.push(`protocol ${ping.protocol}`);
  if (!Number.isInteger(ping.revision) || ping.revision < 1) problems.push(`wire revision ${ping.revision}`);
  if (ping.backend !== "tmux") problems.push(`backend ${ping.backend}`);
  if (ping.instance !== "herdsman") problems.push(`instance ${ping.instance}`);
  for (const contract of [
    "registry.v1",
    "spawn.v1",
    "spawn.close.v1",
    "spawn.launch_context.v1",
  ]) {
    if (!(ping.contracts ?? []).includes(contract)) problems.push(`contract ${contract}`);
  }

  const observed = await request("mux.observe", {});
  const panes = (observed.inventory?.panes ?? [])
    .map((pane) => pane.location?.pane_id ?? "")
    .filter((id) => /^tmux:herdsman:%\d+$/.test(id));
  if (panes.length !== 1) problems.push(`the daemon observed ${panes.length} panes of its server`);

  let registration;
  while (panes.length === 1) {
    const listing = await request("agent.list", {});
    registration = (listing.agents ?? []).find(
      (agent) => agent.registration?.location?.pane === panes[0],
    )?.registration;
    if (registration !== undefined || Date.now() > deadline) break;
    await pause(500);
  }
  if (registration === undefined) problems.push(`no registration is bound to ${panes[0]}`);

  let verification;
  if (registration !== undefined) {
    const read = await request("agent.get", { agent_id: registration.agent_id });
    verification = read.agent?.process?.verification;
    if (verification !== "verified") {
      problems.push(`registration ${registration.agent_id} process ${verification}`);
    }
  }

  const summary = {
    protocol: ping.protocol,
    backend: ping.backend,
    instance: ping.instance,
    pane: panes[0] ?? null,
    agent_id: registration?.agent_id ?? null,
    source: registration?.source ?? null,
    process: verification ?? null,
  };
  if (problems.length > 0) {
    console.error(`radar stack failed: ${problems.join("; ")} ${JSON.stringify(summary)}`);
    process.exit(1);
  }
  console.log(JSON.stringify(summary));
}

main().catch((error) => {
  console.error(`radar probe error: ${error.message}`);
  process.exit(1);
});
PROBE

docker run -d \
  --name "$name" \
  -v "$home:/home/herdsman" \
  -v "$ssh_state:/var/lib/herdsman/ssh" \
  "$image" >/dev/null
for _ in $(seq 1 30); do
  [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ] && break
  sleep 1
done
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" -ne 0
docker logs "$name" 2>&1 | grep -q 'SSH_AUTHORIZED_KEYS is required on first start'
docker rm "$name" >/dev/null

if [ "$(uname -s)" = Darwin ]; then
  # Docker Desktop translates host bind-mount IDs; use a Linux volume for numeric ownership checks.
  docker volume create "$custom_volume" >/dev/null
  custom_home="$custom_volume"
else
  custom_home="$tmp/custom-home"
  mkdir "$custom_home"
fi
docker run --rm \
  --entrypoint /bin/sh \
  -v "$custom_home:/mnt" \
  "$image" \
  -c "chown 12345:23456 /mnt
      chmod 0775 /mnt
      : > /mnt/preserved-owner
      chown $default_ids /mnt/preserved-owner"

if docker run --rm \
  -e PUID=12345 \
  -e PGID=23456 \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$custom_home:/home/herdsman" \
  "$image" >"$tmp/unsafe-home.log" 2>&1; then
  echo "group-writable home unexpectedly succeeded" >&2
  exit 1
fi
grep -Fq \
  '/home/herdsman must be owned by root or UID 12345 and not writable by group or others for SSH public-key authentication (found UID 12345, mode 775)' \
  "$tmp/unsafe-home.log"

docker run --rm \
  --entrypoint chmod \
  -v "$custom_home:/mnt" \
  "$image" \
  go-w /mnt

docker run -d \
  --name "$name" \
  -p 127.0.0.1::22 \
  -e PUID=12345 \
  -e PGID=23456 \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$custom_home:/home/herdsman" \
  "$image" >/dev/null
port="$(docker port "$name" 22/tcp | sed 's/.*://')"
for _ in $(seq 1 30); do
  if remote true >/dev/null 2>&1; then
    break
  fi

  if [ "$(docker inspect -f '{{.State.Status}}' "$name")" = exited ]; then
    docker logs "$name"
    echo "custom UID/GID container exited during startup" >&2
    exit 1
  fi

  sleep 1
done
remote true
test "$(docker exec "$name" id -u herdsman)" = 12345
test "$(docker exec "$name" id -g herdsman)" = 23456
docker exec "$name" \
  runuser -u herdsman -- \
  touch /home/herdsman/custom-owner
test "$(docker run --rm --entrypoint stat -v "$custom_home:/mnt:ro" "$image" -c '%u:%g' /mnt/custom-owner)" = '12345:23456'
test "$(docker run --rm --entrypoint stat -v "$custom_home:/mnt:ro" "$image" -c '%u:%g' /mnt/preserved-owner)" = "$default_ids"
docker rm -f "$name" >/dev/null

start
verify_runtime
verify_stack
# An SSH session does not carry the image's NPM_CONFIG_UPDATE_NOTIFIER (sshd builds
# the session environment itself), so the key is asserted where the image sets it:
# inside the container, whose environment the Pi pane and every exec inherit.
docker exec --user herdsman "$name" sh -c 'test "$(npm config get update-notifier)" = false'

# An interactive login has to land in the Pi pane's own tmux server instead of
# starting a second shell outside it. The probe shadows tmux so the login's
# decision is recorded: it answers the session lookup the guard makes and stops
# at the attach it asks for. Whether that server really holds the session is what
# verify_stack reads from the daemon, not this stub's business.
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s:%s:%s %s\n" "$(id -un)" "$HOME" "$PWD" "$*" >> /tmp/tmux-autostart' \
  'exit 0' |
  remote 'mkdir -p ~/.local/bin && cat > ~/.local/bin/tmux && chmod +x ~/.local/bin/tmux'

docker exec "$name" rm -f /tmp/tmux-autostart
printf 'exit\n' |
  ssh -tt -F /dev/null -i "$tmp/id" -p "$port" \
    -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null \
    herdsman@127.0.0.1 >/dev/null 2>&1 || true
docker exec "$name" grep -q '^herdsman:/home/herdsman:/home/herdsman -L herdsman has-session -t herdsman$' \
  /tmp/tmux-autostart
docker exec "$name" grep -q '^herdsman:/home/herdsman:/home/herdsman -L herdsman attach-session -t herdsman$' \
  /tmp/tmux-autostart

docker exec "$name" rm -f /tmp/tmux-autostart /tmp/bash-ran
docker exec --user herdsman -e TMUX=/tmp/tmux-1000/herdsman,1,0 \
  "$name" script -qec 'bash -ic "printf ok > /tmp/bash-ran"' /dev/null >/dev/null
docker exec "$name" sh -c 'test "$(cat /tmp/bash-ran)" = ok'
docker exec "$name" test ! -e /tmp/tmux-autostart

remote 'rm -f ~/.local/bin/tmux'
docker exec "$name" rm -f /tmp/tmux-autostart /tmp/bash-ran
verify_runtime
verify_stack

if ssh -F /dev/null -i "$tmp/id" -p "$port" \
  -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  root@127.0.0.1 true >/dev/null 2>&1; then
  echo "root SSH unexpectedly succeeded" >&2
  exit 1
fi
if ssh -F /dev/null -p "$port" -o BatchMode=yes \
  -o PreferredAuthentications=password -o PubkeyAuthentication=no \
  -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  herdsman@127.0.0.1 true >/dev/null 2>&1; then
  echo "password SSH unexpectedly succeeded" >&2
  exit 1
fi

host_fingerprint="$(docker exec "$name" ssh-keygen -lf /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub)"
remote 'mkdir -p ~/persist-package/extensions && printf "%s\n" "{\"name\":\"persist-package\",\"version\":\"1.0.0\"}" > ~/persist-package/package.json && printf "%s\n" "export default function () {}" > ~/persist-package/extensions/persist.ts && pi install ~/persist-package && mkdir -p ~/.local/bin && printf "%s\n" "#!/bin/sh" "printf persisted" > ~/.local/bin/persist-tool && chmod +x ~/.local/bin/persist-tool'

docker rm -f "$name" >/dev/null
start
verify_runtime
verify_stack
remote 'grep -q persist-package ~/.pi/agent/settings.json && test "$(persist-tool)" = persisted'
test "$host_fingerprint" = "$(docker exec "$name" ssh-keygen -lf /var/lib/herdsman/ssh/ssh_host_ed25519_key.pub)"

docker exec "$name" sh -c 'printf root-owned-sentinel > /home/herdsman/root-owned-target; chmod 0644 /home/herdsman/root-owned-target'
test "$(docker exec "$name" stat -c %u /home/herdsman/root-owned-target)" = 0
target_before="$(docker exec "$name" stat -c '%u:%a' /home/herdsman/root-owned-target):$(docker exec "$name" cat /home/herdsman/root-owned-target)"
remote 'ln -sf /home/herdsman/root-owned-target ~/.ssh/authorized_keys'
docker rm -f "$name" >/dev/null
docker run -d \
  --name "$name" \
  -e SSH_AUTHORIZED_KEYS="$(cat "$tmp/id.pub")" \
  -v "$home:/home/herdsman" \
  -v "$ssh_state:/var/lib/herdsman/ssh" \
  "$image" >/dev/null
sleep 2
test "$(docker inspect -f '{{.State.Status}}' "$name")" = exited
test "$(docker inspect -f '{{.State.ExitCode}}' "$name")" -ne 0
target_after="$(docker run --rm --entrypoint /bin/sh -v "$home:/home/herdsman" "$image" -c 'stat -c "%u:%a" /home/herdsman/root-owned-target; cat /home/herdsman/root-owned-target' | tr '\n' ':')"
target_after="${target_after%:}"
test "$target_after" = "$target_before"
test "$(docker run --rm --entrypoint /bin/sh -v "$home:/home/herdsman" "$image" -c 'stat -c %a /home/herdsman/root-owned-target')" = 644
docker rm -f "$name" >/dev/null 2>&1 || true
docker run --rm \
  --user herdsman \
  --entrypoint /bin/sh \
  -v "$home:/home/herdsman" \
  "$image" \
  -c 'rm -f /home/herdsman/.ssh/authorized_keys /home/herdsman/root-owned-target'
start
verify_runtime
verify_stack

echo "Container smoke test passed (Pi $expected_pi, Radar $expected_radar)."
