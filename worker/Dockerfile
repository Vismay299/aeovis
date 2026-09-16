# The probe fleet's image. Built for a container host, per
# docs/decisions/2026-09-05-worker-host.md §1 — not for a request-scoped runtime.
#
# Build context is `worker/`, NOT the repo root: nothing here may reach into
# src/, and src/lib/workerIsolation.test.mjs enforces that in the main suite.
# A build context that included the root would make violating it possible.
FROM node:20-bookworm-slim

# Playwright resolves the browser it needs from the INSTALLED library version,
# so the browser is fetched after `npm ci` rather than baked in from a version
# guessed here. worker/package.json declares ^1.47.0; the lockfile currently
# resolves 1.63.0, and hardcoding either would drift.
# NODE_ENV is deliberately NOT set to "production" here. config.js treats
# `NODE_ENV === "production"` as, on its own, evidence of a production target
# (R1.2.12), so baking it into the image would mean the fleet either refuses to
# boot or has to carry FLEET_ALLOW_PRODUCTION_DB=true forever — which turns that
# guard into a no-op for every deployment. Arming production is a decision that
# belongs on the Deployment, not in the base image. `npm ci --omit=dev` below
# already prunes dev dependencies, which is the only other thing it bought.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# tini reaps zombies. Playwright spawns Chromium as a child process tree, and a
# Node process running as PID 1 does not reap orphans — over a long-lived loop
# (the whole point of this host) those accumulate.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --with-deps installs the system libraries Playwright needs, which is the
# specific thing a plain Node buildpack does not give you and the reason
# worker/README.md says the browser "does not belong in a deploy bundle".
# Chromium only: the fleet drives consumer surfaces, not a matrix.
RUN npx playwright install --with-deps chromium \
 && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

COPY src ./src

# Least privilege. The node user exists in the base image; /app is root-owned
# and read-only to it, which is all the fleet needs.
USER node

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/index.js"]
