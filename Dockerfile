FROM docker.io/tailscale/tailscale:stable AS tailscale
FROM nousresearch/hermes-agent:latest

USER root

ARG GRANITE_PACKAGE=granite-mem
ARG GRANITE_VERSION=0.1.11
ARG GRANITE_GIT_REPO=https://github.com/The-Vibe-Company/Granite.git
ARG GRANITE_GIT_REF=bbe36e2116116ff7da023ab2e65980f2bd75a781

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        build-essential ca-certificates git iptables nodejs npm python3 python3-yaml && \
    rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    if npm view "${GRANITE_PACKAGE}@${GRANITE_VERSION}" version >/dev/null 2>&1; then \
        npm install -g "${GRANITE_PACKAGE}@${GRANITE_VERSION}"; \
    else \
        git clone "${GRANITE_GIT_REPO}" /tmp/granite; \
        cd /tmp/granite; \
        git checkout "${GRANITE_GIT_REF}"; \
        npm ci; \
        npm run build; \
        HUSKY=0 npm pack --pack-destination /tmp; \
        npm install -g /tmp/"${GRANITE_PACKAGE}-${GRANITE_VERSION}.tgz"; \
        cd /; \
        rm -rf /tmp/granite /tmp/"${GRANITE_PACKAGE}-${GRANITE_VERSION}.tgz"; \
    fi

COPY --from=tailscale /usr/local/bin/tailscale /usr/local/bin/tailscale
COPY --from=tailscale /usr/local/bin/tailscaled /usr/local/bin/tailscaled

COPY --chmod=0755 bin/start-on-fly /usr/local/bin/hermes-fly-start
COPY --chmod=0755 bin/run-hermes-process /usr/local/bin/hermes-fly-run-process

ENV HERMES_DASHBOARD_ENABLED=true
ENV HERMES_DASHBOARD_HOST=0.0.0.0
ENV HERMES_DASHBOARD_INSECURE=false
ENV HERMES_DASHBOARD_MODE=serve
ENV HERMES_DASHBOARD_PORT=9119
ENV GRANITE_ENABLED=true
ENV GRANITE_VAULT=/opt/data/.granite
ENV HERMES_HOME=/opt/data/hermes
ENV TAILSCALE_STATE_DIR=/opt/data/tailscale
ENV TS_ACCEPT_DNS=false

ENTRYPOINT ["/usr/local/bin/hermes-fly-start"]
CMD ["gateway", "run"]
