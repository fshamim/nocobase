# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS plugin-builder

WORKDIR /repo

RUN corepack enable \
  && yarn config set network-timeout 600000 -g

COPY . .

RUN yarn install --frozen-lockfile \
  && yarn nocobase build @nocobase/plugin-ecobase --no-dts \
  && yarn nocobase tar @nocobase/plugin-ecobase \
  && mkdir -p /ecobase-plugin \
  && tar -xzf storage/tar/@nocobase/plugin-ecobase-*.tgz -C /ecobase-plugin

FROM nocobase/nocobase:beta-full

COPY --from=plugin-builder /ecobase-plugin /app/nocobase/storage/plugins/@nocobase/plugin-ecobase
