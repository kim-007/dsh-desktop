FROM --platform=linux/amd64 debian:10-slim AS build

ARG NODE_VERSION=22.20.0

RUN sed -i \
      -e 's|deb.debian.org/debian|archive.debian.org/debian|g' \
      -e 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' \
      -e '/buster-updates/d' \
      /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      binutils ca-certificates curl fakeroot file g++ git make python3 xz-utils \
      xvfb dbus-x11 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && mkdir -p /opt/node \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" --strip-components=1 -C /opt/node \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz"

ENV PATH="/opt/node/bin:${PATH}"
WORKDIR /workspace
COPY . .

RUN npm ci
# The full suite already runs on the host job. Debian 10 ships Python 3.7,
# while the unrelated Feishu release-note helper requires Python 3.9.
RUN npm test -- --exclude test/feishu-release-notes.test.ts && npm run typecheck
RUN npm run package:linux:amd64
RUN scripts/verify-linux-deb.sh dist/dsh-desktop-linux-amd64.deb
RUN apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y \
      ./dist/dsh-desktop-linux-amd64.deb \
    && useradd --create-home smoke \
    && rm -rf /var/lib/apt/lists/*
RUN set +e; \
    runuser -u smoke -- xvfb-run -a timeout 45s /usr/bin/dsh-desktop --disable-gpu; \
    status="$?"; \
    set -e; \
    test "$status" -eq 124

FROM scratch AS artifact
COPY --from=build /workspace/dist/dsh-desktop-linux-amd64.deb /dsh-desktop-linux-amd64.deb
