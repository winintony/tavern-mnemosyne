FROM node:26.5.0-alpine3.23@sha256:0473b6671ff22c8eeb570c0e1e51408595d3171e73f8002c269b763f0a943149

RUN apk add --no-cache tini
WORKDIR /opt/tavern-mnemosyne
COPY --chown=node:node . .
RUN cd tavern-mnemosyne \
    && npm ci --omit=dev --no-audit --no-fund \
    && mkdir -p /var/lib/mnemosyne \
    && chown -R node:node /var/lib/mnemosyne /opt/tavern-mnemosyne

ENV MNEMOSYNE_STATE_ROOT=/var/lib/mnemosyne \
    MNEMOSYNE_UPSTREAM_AUTH_MODE=passthrough \
    MNEMOSYNE_CONTEXT_MODE=production

USER node
ENTRYPOINT ["tini", "--", "node", "/opt/tavern-mnemosyne/tavern-mnemosyne/distribution/cloud/common/runtime-entrypoint.mjs"]
