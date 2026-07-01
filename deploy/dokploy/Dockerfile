# syntax=docker/dockerfile:1

ARG ECOBASE_BASE_IMAGE=nocobase/nocobase:beta-full

FROM node:22-bookworm-slim AS plugin-builder

WORKDIR /repo

RUN corepack enable \
  && yarn config set network-timeout 600000 -g

COPY . .

RUN yarn install --frozen-lockfile \
  && yarn nocobase build @nocobase/plugin-ecobase --no-dts \
  && yarn nocobase tar @nocobase/plugin-ecobase \
  && yarn nocobase build @nocobase/plugin-ai-codex-subscription --no-dts \
  && yarn nocobase tar @nocobase/plugin-ai-codex-subscription \
  && mkdir -p /plugins/plugin-ecobase /plugins/plugin-ai-codex-subscription \
  && tar -xzf storage/tar/@nocobase/plugin-ecobase-*.tgz -C /plugins/plugin-ecobase \
  && tar -xzf storage/tar/@nocobase/plugin-ai-codex-subscription-*.tgz -C /plugins/plugin-ai-codex-subscription

FROM ${ECOBASE_BASE_IMAGE}

ARG ECOBASE_IMAGE_REVISION=unknown
LABEL org.opencontainers.image.revision=${ECOBASE_IMAGE_REVISION}

COPY --from=plugin-builder /plugins/plugin-ecobase /app/nocobase/storage/plugins/@nocobase/plugin-ecobase
COPY --from=plugin-builder /plugins/plugin-ai-codex-subscription /app/nocobase/storage/plugins/@nocobase/plugin-ai-codex-subscription
COPY packages/plugins/@nocobase/plugin-ecobase/docker/live-gate-startup.sh /app/nocobase/storage/scripts/010-enable-ecobase.sh

RUN chmod +x /app/nocobase/storage/scripts/010-enable-ecobase.sh
