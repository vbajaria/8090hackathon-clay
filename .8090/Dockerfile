# Debian Bookworm supplies PostgreSQL 15. No cloud services are provisioned.
FROM node:22-bookworm
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       postgresql-15 postgresql-client-15 git curl ca-certificates sudo tmux openssl \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@9.15.0 --activate
