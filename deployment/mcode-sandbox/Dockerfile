# syntax=docker/dockerfile:1.7
ARG AES_IMAGE=ghcr.io/rlabs88/toolkit/aes-sandbox@sha256:8965a9f6d38494d90e717e72f3283c7b47c82368ebe390c49c604c718023bda0
ARG OPS_IMAGE=ghcr.io/rlabs88/toolkit/ops-sandbox@sha256:6dca52326968f8e0442fd405cfe1a0e02bc536546838806851880eccfe303270

FROM ${AES_IMAGE} AS sandbox-admission-runtime

FROM ${AES_IMAGE} AS mcode-runtime-build
ARG TARGETARCH
USER root
RUN test "$TARGETARCH" = arm64 \
    && install -d /opt/mastra-toolkit/mcode-runtime
COPY deployment/mcode-sandbox/runtime/package.json deployment/mcode-sandbox/runtime/package-lock.json /opt/mastra-toolkit/mcode-runtime/
WORKDIR /opt/mastra-toolkit/mcode-runtime
RUN npm ci --omit=dev --ignore-scripts=false --no-audit --no-fund
COPY deployment/mcode-sandbox/runtime-probe.sh /usr/local/bin/mastra-toolkit-runtime-probe
COPY deployment/mcode-sandbox/credential-guard.sh /usr/local/lib/mastra-toolkit/credential-guard.sh
RUN chmod 0755 /usr/local/bin/mastra-toolkit-runtime-probe /usr/local/lib/mastra-toolkit/credential-guard.sh

FROM ${AES_IMAGE} AS ephemeral-development
ARG TARGETARCH
ARG SOURCE_REVISION
RUN test "$TARGETARCH" = arm64 \
    && case "$SOURCE_REVISION" in (*[!a-f0-9]*|'') exit 1;; esac \
    && test "${#SOURCE_REVISION}" = 40 \
    && install -d /etc/mastra-toolkit \
    && printf '%s\n' ephemeral-development > /etc/mastra-toolkit/runtime-profile
COPY packages/sandbox/config/runtime-profiles.json /etc/mastra-toolkit/runtime-profiles.json
COPY --from=mcode-runtime-build /opt/mastra-toolkit/mcode-runtime /opt/mastra-toolkit/mcode-runtime
COPY --from=mcode-runtime-build /usr/local/bin/mastra-toolkit-runtime-probe /usr/local/bin/mastra-toolkit-runtime-probe
COPY --from=mcode-runtime-build /usr/local/lib/mastra-toolkit/credential-guard.sh /usr/local/lib/mastra-toolkit/credential-guard.sh
ENV PATH="/opt/mastra-toolkit/mcode-runtime/node_modules/.bin:${PATH}"
LABEL io.rlabs.mastra-toolkit.runtime-profile="ephemeral-development" \
      org.opencontainers.image.source="https://github.com/rlabs88/mastra-toolkit" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"

FROM ${OPS_IMAGE} AS persistent-operations
ARG TARGETARCH
ARG SOURCE_REVISION
RUN test "$TARGETARCH" = arm64 \
    && case "$SOURCE_REVISION" in (*[!a-f0-9]*|'') exit 1;; esac \
    && test "${#SOURCE_REVISION}" = 40 \
    && install -d /etc/mastra-toolkit \
    && printf '%s\n' persistent-operations > /etc/mastra-toolkit/runtime-profile
COPY packages/sandbox/config/runtime-profiles.json /etc/mastra-toolkit/runtime-profiles.json
COPY --from=mcode-runtime-build /opt/mastra-toolkit/mcode-runtime /opt/mastra-toolkit/mcode-runtime
COPY --from=mcode-runtime-build /usr/local/bin/mastra-toolkit-runtime-probe /usr/local/bin/mastra-toolkit-runtime-probe
COPY --from=mcode-runtime-build /usr/local/lib/mastra-toolkit/credential-guard.sh /usr/local/lib/mastra-toolkit/credential-guard.sh
COPY --from=sandbox-admission-runtime /usr/local/bin/sandbox-entrypoint /usr/local/bin/sandbox-entrypoint
COPY --from=sandbox-admission-runtime /opt/agent-sandbox/cortex/provisioning.ts /opt/agent-sandbox/cortex/provisioning.ts
ENV PATH="/opt/mastra-toolkit/mcode-runtime/node_modules/.bin:${PATH}"
LABEL io.rlabs.mastra-toolkit.runtime-profile="persistent-operations" \
      org.opencontainers.image.source="https://github.com/rlabs88/mastra-toolkit" \
      org.opencontainers.image.revision="${SOURCE_REVISION}"
