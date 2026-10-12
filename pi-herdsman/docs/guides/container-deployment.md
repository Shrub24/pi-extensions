# Container deployment

Run Pi Herdsman as a portable SSH-accessible coding-agent environment with Pi, the Radar daemon, tmux, developer tools, and persistent state.

## Quick start

Start:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" docker compose up -d
```

Connect:

```sh
ssh -p 2222 herdsman@your-host
```

The login attaches to the Pi pane of the container's tmux server `herdsman`.
That server and the `radar daemon` serving it are started by the container
entrypoint, and Pi is already running in the pane.

That's it.

## Build from the monorepo checkout

From the repository root, build the image with its sibling runtime modules from
the same checkout:

```sh
docker build -f pi-herdsman/Dockerfile -t pi-herdsman:local .
```

The Dockerfile-specific ignore file keeps the context to the package and the
`pi-bash-processes` runtime inputs it imports.

## Connect from another terminal

A second interactive login attaches to the same Pi pane, so several terminals
share one session instead of starting rival shells.

The container's Radar daemon serves only that tmux server: Agents are launched
and supervised inside the container.

## Use Tailscale

Start with the Tailscale sidecar:

```sh
TS_AUTHKEY=tskey-auth-... \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose \
  -f compose.yaml \
  -f compose.tailscale.yaml \
  up -d
```

Connect:

```sh
ssh herdsman@pi-herdsman
```

Use another hostname:

```sh
TAILSCALE_HOSTNAME=my-herd \
TS_AUTHKEY=tskey-auth-... \
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose \
  -f compose.yaml \
  -f compose.tailscale.yaml \
  up -d
```

Tailscale provides networking only. SSH remains normal OpenSSH.

## Update

```sh
docker compose pull
docker compose up -d
```

Persistent state survives container replacement.

## Use a host bind mount

The default Docker-managed volume needs no manual permission setup.

For a Linux or NAS bind mount, prepare the directory for the UID/GID the
container will use:

```sh
PUID=1035
PGID=65537

mkdir -p ./data/herdsman-home
sudo chown "$PUID:$PGID" ./data/herdsman-home
sudo chmod go-w ./data/herdsman-home
```

Set the same IDs in `.env`:

```dotenv
PUID=1035
PGID=65537
```

Create `compose.bind-mount.yaml` to replace the home volume with the host
directory while keeping the SSH server identity in its named volume:

```yaml
services:
  herdsman:
    volumes:
      - ./data/herdsman-home:/home/herdsman
      - herdsman-ssh:/var/lib/herdsman/ssh
```

Start with both Compose files:

```sh
SSH_AUTHORIZED_KEYS="$(cat ~/.ssh/id_ed25519.pub)" \
docker compose -f compose.yaml -f compose.bind-mount.yaml up -d
```

OpenSSH requires the home directory to be owned by root or the login user and
not writable by group or others. The container validates this at startup but
does not change ownership or permissions of host bind mounts.

## Forward your SSH agent

For private Git repositories:

```sh
ssh -A -p 2222 herdsman@your-host
```

## Install another tool

```sh
mise use -g uv@latest
```

Tools installed with mise persist in the home volume.

## What persists?

| Path                    | Contents                                                                          |
| ----------------------- | --------------------------------------------------------------------------------- |
| `/home/herdsman`        | Pi state, repositories, config, credentials, SSH state, installed tools           |
| `/var/lib/herdsman/ssh` | SSH server identity                                                               |

Running processes do not survive a container restart.

## Defaults

| Setting            | Default       |
| ------------------ | ------------- |
| SSH port           | `2222`        |
| User               | `herdsman`    |
| Tailscale hostname | `pi-herdsman` |
| Password login     | disabled      |
| Root SSH login     | disabled      |

`SSH_AUTHORIZED_KEYS` is required only on first start. Existing authorized keys are not overwritten.

Pi sessions automatically receive the container environment context from `/AGENTS.md`.
