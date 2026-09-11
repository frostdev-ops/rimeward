# Rimeward. Build: docker compose build (compose.yaml), or
#   docker build -t rimeward . && docker run --env-file .env -p 127.0.0.1:3005:3005 -v rimeward-data:/data rimeward
# The browser wards need what compose.yaml adds: the seccomp profile that lets
# Chromium keep its sandbox as a non-root user, host IPC, and an init process.
FROM node:22-bookworm-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# playwright-core's pinned Chromium plus its system libraries, in a path the
# runtime user can read (the default cache lives under root's home).
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright-core install --with-deps chromium && rm -rf /var/lib/apt/lists/*

COPY . .
# The deploy stamp the dashboard shows (CI passes the release version + sha).
ARG PUBLIC_APP_BUILD
ENV PUBLIC_APP_BUILD=$PUBLIC_APP_BUILD
RUN npm run build

# RIMEWARD_INSTALL=docker: the update chip says "pull the image" instead of installing in place.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3005 HOMEPAGE_DATA_DIR=/data RIMEWARD_INSTALL=docker
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3005
VOLUME /data
CMD ["node", "server.mjs"]
