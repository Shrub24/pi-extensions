# syntax=docker/dockerfile:1

ARG NODE_IMAGE=node:26.10.0-trixie-slim
ARG MISE_VERSION=2026.9.12

FROM ${NODE_IMAGE} AS package

WORKDIR /src

COPY pi-herdsman/package.json pi-herdsman/package-lock.json ./
RUN npm ci

COPY pi-herdsman/README.md pi-herdsman/SKILL.md pi-herdsman/LICENSE ./
COPY pi-herdsman/docs ./docs
COPY pi-herdsman/extension ./extension
COPY pi-bash-processes/package.json /sibling/package.json
COPY pi-bash-processes/extensions /sibling/extensions

# The release audit stays a host/CI gate: `npm run package:audit` compares against
# the running home and cwd, which here are `/root` and `/src` rather than a
# developer checkout.
RUN node -e '\
const runtime = require("./package.json").piHerdsman?.runtime; \
if (!runtime?.pi || !/^[0-9a-f]{40}$/.test(runtime.radar?.commit ?? "") || runtime.radar.protocol !== 2) \
  throw new Error("runtime metadata missing"); \
process.stdout.write(JSON.stringify(runtime));' > /runtime.json \
 && node -p 'require("./package.json").piHerdsman.runtime.radar.commit' > /radar-commit \
 && tarball="$(npm pack --ignore-scripts --silent)" \
 && mkdir /package \
 && tar -xzf "$tarball" -C /package --strip-components=1

FROM docker.io/library/rust:1.88-bookworm AS radar

COPY --from=package /radar-commit /tmp/radar-commit

RUN set -eu; \
    commit="$(cat /tmp/radar-commit)"; \
    git init -q /src; \
    cd /src; \
    git fetch -q --depth 1 https://github.com/Shrub24/agent-radar.git "$commit"; \
    git checkout -q FETCH_HEAD; \
    test "$(git rev-parse HEAD)" = "$commit"; \
    cargo build --release --locked --bin radar; \
    printf '%s\n' "$commit" > /radar-built-from

FROM ${NODE_IMAGE} AS tmux-build

RUN set -eu; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      bison \
      build-essential \
      ca-certificates \
      curl \
      libevent-dev \
      libncurses-dev \
      pkg-config; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL https://github.com/tmux/tmux/releases/download/3.7c/tmux-3.7c.tar.gz \
      -o /tmp/tmux-3.7c.tar.gz; \
    printf '%s  %s\n' \
      7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf \
      /tmp/tmux-3.7c.tar.gz | sha256sum -c -; \
    mkdir -p /tmp/tmux-src /out; \
    tar -xzf /tmp/tmux-3.7c.tar.gz -C /tmp/tmux-src --strip-components=1; \
    cd /tmp/tmux-src; \
    ./configure --prefix=/usr/local; \
    make -j"$(nproc)"; \
    install -m 0755 tmux /out/tmux; \
    install -m 0644 COPYING /out/tmux-LICENSE; \
    printf '%s\n' \
      'version: 3.7c' \
      'source-sha256: 7c60cae9a0e25288e2e24750aafc9e8800fc7fd4555e447e1b29ee4201cfb3bf' \
      > /out/tmux-build.txt

FROM ghcr.io/jdx/mise:${MISE_VERSION} AS mise

FROM ${NODE_IMAGE}

ARG TARGETARCH
ARG MISE_VERSION

ENV LANG=C.UTF-8 \
    NPM_CONFIG_UPDATE_NOTIFIER=false

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      dnsutils \
      fd-find \
      file \
      fzf \
      gh \
      git \
      git-lfs \
      iproute2 \
      jq \
      less \
      lsof \
      netcat-openbsd \
      openssh-client \
      openssh-server \
      pkg-config \
      procps \
      psmisc \
      python3 \
      python3-venv \
      ripgrep \
      rsync \
      sqlite3 \
      libevent-core-2.1-7t64 \
      libtinfo6 \
      tree \
      unzip \
      util-linux \
      zip \
 && rm -rf /var/lib/apt/lists/* \
 && ln -s /usr/bin/fdfind /usr/local/bin/fd \
 && rm -f /etc/ssh/ssh_host_*

RUN groupmod -n herdsman node \
 && usermod -l herdsman -d /home/herdsman -m node \
 && passwd -d herdsman \
 && install -d -m 0755 /run/sshd \
 && install -d -m 0700 /var/lib/herdsman/ssh

RUN cat >> /etc/bash.bashrc <<'EOF'

# Attach interactive logins to the Pi pane's tmux server. Panes set TMUX.
if [ "$(id -un)" = herdsman ]; then
  export HOME=/home/herdsman
  export USER=herdsman
  export LOGNAME=herdsman
  export PATH=/home/herdsman/.local/share/mise/shims:/home/herdsman/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

  if [ -t 0 ] && [ -t 1 ] && [ -z "${TMUX:-}" ] &&
    tmux -L herdsman has-session -t herdsman 2>/dev/null; then
    exec tmux -L herdsman attach-session -t herdsman
  fi
fi
EOF

COPY --from=mise /usr/local/bin/mise /usr/local/bin/mise
COPY --from=radar /src/target/release/radar /usr/local/bin/radar
COPY --from=radar /radar-built-from /usr/share/doc/pi-herdsman/radar-commit
COPY --from=tmux-build /out/tmux /usr/local/bin/tmux
COPY --from=tmux-build /out/tmux-LICENSE /usr/share/doc/pi-herdsman/third-party/tmux-LICENSE
COPY --from=tmux-build /out/tmux-build.txt /usr/share/doc/pi-herdsman/tmux-build.txt
COPY --from=package /runtime.json /tmp/runtime.json

RUN set -eu; \
    pi_version="$(node -p 'require("/tmp/runtime.json").pi')"; \
    case "$TARGETARCH" in \
      amd64) pi_arch=x64 ;; \
      arm64) pi_arch=arm64 ;; \
      *) echo "unsupported architecture: $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    asset="pi-linux-${pi_arch}.tar.gz"; \
    release="https://github.com/earendil-works/pi/releases/download/v${pi_version}"; \
    curl -fsSL "$release/$asset" -o "/tmp/$asset"; \
    curl -fsSL "$release/SHA256SUMS" -o /tmp/SHA256SUMS; \
    (cd /tmp && grep -F "  $asset" SHA256SUMS | sha256sum -c -); \
    mkdir -p /opt/pi; \
    tar -xzf "/tmp/$asset" -C /opt/pi --strip-components=1; \
    ln -s /opt/pi/pi /usr/local/bin/pi; \
    test "$(pi --version)" = "$pi_version"; \
    rm -f /tmp/SHA256SUMS "/tmp/$asset"

RUN set -eu; \
    mkdir -p /usr/share/doc/pi-herdsman/third-party; \
    pi_version="$(node -p 'require("/tmp/runtime.json").pi')"; \
    curl -fsSL "https://raw.githubusercontent.com/earendil-works/pi/v${pi_version}/LICENSE" -o /usr/share/doc/pi-herdsman/third-party/pi-LICENSE; \
    curl -fsSL "https://raw.githubusercontent.com/jdx/mise/v${MISE_VERSION}/LICENSE" -o /usr/share/doc/pi-herdsman/third-party/mise-LICENSE; \
    rm -f /tmp/runtime.json

COPY --from=package /package /opt/pi-herdsman
COPY --from=package /sibling /opt/pi-bash-processes
COPY --chmod=0444 pi-herdsman/docker/AGENTS.md /AGENTS.md
COPY pi-herdsman/docker/entrypoint.sh /usr/local/bin/container-entrypoint
COPY pi-herdsman/docker/sshd_config /etc/ssh/sshd_config

RUN chmod 0755 /usr/local/bin/container-entrypoint \
 && chmod 0600 /etc/ssh/sshd_config

WORKDIR /home/herdsman

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/container-entrypoint"]
