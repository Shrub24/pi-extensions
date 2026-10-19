# Getting started

[Documentation index](README.md) · [Coordination API](coordination-api.md)

This is the shortest path from installation to useful asynchronous delegation.
You do not need to call structured coordination tools yourself.

## 1. Install

You need:

- [Radar](https://github.com/Shrub24/agent-radar), built at the commit the released package records
  in `piHerdsman.runtime.radar.commit` with `cargo build --release --locked --bin radar`, with
  `radar` on `PATH`
- tmux on `PATH`
- Pi `1.1.0` (tested runtime)
- Node `>=22.19.0`

On Linux or macOS, install the released, tested stack:

```sh
curl -fsSL https://raw.githubusercontent.com/boadij/pi-herdsman/main/install.sh | sh
```

The installer checks that `radar` and `tmux` are already on `PATH`; it installs
neither of them. If you already manage Pi and Radar yourself:

```sh
pi install npm:pi-herdsman
```

For an SSH-ready container deployment that ships both, see
[Container deployment](guides/container-deployment.md).

## 2. Start the Radar daemon and Pi

Start the daemon for the tmux server it will serve:

```sh
RADAR_CONTROL_BACKEND=tmux RADAR_TMUX_SERVER=<server> radar daemon
```

Then start Pi in a pane of that same server:

```sh
tmux -L <server> new-session pi
```

Pi loads the package extension and optional `agents` skill. A Lead started
outside a pane of the daemon's tmux server cannot safely manage its Agents.

## 3. Delegate without leaving the conversation

Ask Pi normally:

```text
Use scout to inspect this repository.
```

The Agent starts asynchronously. Once the assignment is accepted, the Lead
conversation remains available while the Agent works.

You can keep discussing the problem, delegate other genuinely independent work,
or end the turn. Do not poll for completion. Results and Agent questions return
to the exact owner when they need attention.

The exact assignment behavior is documented in
[Lifecycle](concepts/lifecycle.md).

## 4. Open the Agent menu

Run:

```text
/agents
```

The native menu provides the live Agent inventory, session usage, Agent definitions,
layout, message limits, context-retirement configuration, and emergency cleanup.

Use `Running` to focus a verified live Agent. Use `Session stats` to inspect
Pi-native token usage and cost for the current Pi session plus transitively
owned managed-Agent sessions. Use `Definitions` to inspect or override the
effective bundled, project, and global roster. Placement and the other runtime
settings are set in the rendered configuration, not from this menu.

See [Commands](reference/commands.md) for the exact human-facing behavior.

## 5. Customize when needed

Pi Herdsman is opinionated about coordination, not your development workflow.
Definitions control models, thinking, tools, skills, extensions, instructions,
and permitted delegation.

Continue with:

- [Agent definitions](guides/agent-definitions.md)
- [Customizing bundled Agents](guides/customizing-agents.md)
- [Agent-definition schema](reference/agent-definition-schema.md)
- [Configuration](reference/configuration.md)

## 6. Observe active work

The status widget shows current managed work and transient startup activity.
Presentation is not control authority: operations still revalidate exact
identity and lifecycle state.

Completed Agent generations are cleaned up after result delivery. Their Pi
sessions remain available for explicit continuation through the model-facing
API.

See [Status widget](reference/status-widget.md) and
[Agents and identity](concepts/agents.md).

## 7. Supervise Leads from Chief

An eligible Lead can enter Chief mode to supervise its ordinary Leads directly:

```text
/chief
```

For the role and authority model, read [Coordination](concepts/coordination.md).

## Next steps

- Keep delegating naturally through the Lead conversation.
- Use [Coordination API](coordination-api.md) when you need exact model-facing interfaces.
- Use [Recovery](guides/recovery.md) only when normal coordination cannot converge safely.
