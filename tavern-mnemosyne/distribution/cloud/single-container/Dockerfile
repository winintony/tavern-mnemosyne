ARG SILLYTAVERN_IMAGE=ghcr.io/sillytavern/sillytavern:1.18.0@sha256:7b30a1698b605d01dbd01a20459600c035f0d2c866912b69d7eee98065dcedd3
FROM ${SILLYTAVERN_IMAGE}

USER root
COPY --chown=node:node . /opt/tavern-mnemosyne
RUN cd /opt/tavern-mnemosyne/tavern-mnemosyne \
    && npm ci --omit=dev --no-audit --no-fund \
    && node \
      distribution/cloud/common/apply-sillytavern-1.18.0-compat.mjs \
      /home/node/app \
    && ln -s /opt/tavern-mnemosyne \
      /home/node/app/plugins/tavern-mnemosyne \
    && cp -R \
      /opt/tavern-mnemosyne/tavern-mnemosyne/integrations/sillytavern-extension \
      /home/node/app/public/scripts/extensions/third-party/tavern-mnemosyne \
    && chown -R node:node \
      /home/node/app/plugins \
      /home/node/app/public/scripts/extensions/third-party \
      /opt/tavern-mnemosyne

ENV MNEMOSYNE_STATE_ROOT=/home/node/app/data/_mnemosyne \
    MNEMOSYNE_UPSTREAM_AUTH_MODE=passthrough \
    MNEMOSYNE_CONTEXT_MODE=production \
    MNEMOSYNE_EXTERNAL_RUNTIME=true \
    MNEMOSYNE_ENABLE_EVALUATION_BRIDGE=false \
    SILLYTAVERN_ENABLESERVERPLUGINS=true \
    SILLYTAVERN_ENABLESERVERPLUGINSAUTOUPDATE=false \
    SILLYTAVERN_DISABLECSRFPROTECTION=false \
    SILLYTAVERN_BROWSERLAUNCH_ENABLED=false \
    SILLYTAVERN_LISTEN=true \
    SILLYTAVERN_WHITELISTMODE=false \
    SILLYTAVERN_BASICAUTHMODE=true \
    SILLYTAVERN_CORS_ENABLED=false \
    SILLYTAVERN_PRIVATEADDRESSWHITELIST_ENABLED=true \
    SILLYTAVERN_PRIVATEADDRESSWHITELIST_ALLOWEDRANGES='["127.0.0.0/8","::1/128"]' \
    SILLYTAVERN_HEARTBEATINTERVAL=15

USER node
ENTRYPOINT ["tini", "--", "node", "/opt/tavern-mnemosyne/tavern-mnemosyne/distribution/cloud/common/supervisor.mjs"]
