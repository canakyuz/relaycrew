# syntax=docker/dockerfile:1

ARG NODE_VERSION=22
FROM node:${NODE_VERSION}-alpine

ARG VERSION=dev
ARG VCS_REF=unknown
ARG BUILD_DATE
LABEL org.opencontainers.image.title="relaycrew" \
      org.opencontainers.image.description="Team gateway for Claude Code and Codex" \
      org.opencontainers.image.source="https://github.com/sep1ol/relaycrew" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}"

RUN apk add --no-cache tini su-exec

ENV NODE_ENV=production \
    RELAYCREW_DISABLE_AUTOUPDATE=1

WORKDIR /app

COPY --chown=root:root package.json LICENSE ./
COPY --chown=root:root --chmod=755 src/ ./src/

RUN ln -s /app/src/index.js /usr/local/bin/relaycrew \
    && ln -s /app/src/index.js /usr/local/bin/teamclaude \
    && ln -s /app/src/index.js /usr/local/bin/teamrouter

COPY --chown=root:root --chmod=755 docker-entrypoint.sh /usr/local/bin/

RUN mkdir -p /data && chown node:node /data

WORKDIR /data

EXPOSE 3456

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD docker-entrypoint.sh node -e "const fs=require('fs');const c=(process.env.RELAYCREW_CONFIG??process.env.TEAMROUTER_CONFIG??process.env.TEAMCLAUDE_CONFIG)||['relaycrew','teamrouter','teamclaude'].map(n=>'/data/'+n+'.json').find(p=>fs.existsSync(p))||'/data/relaycrew.json';let p=3456;try{p=require(c).proxy?.port||p}catch{};fetch('http://127.0.0.1:'+p+'/relaycrew/status',{headers:{'x-api-key':require(c).proxy?.apiKey||''}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh", "relaycrew"]
CMD ["server", "--headless"]
