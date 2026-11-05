# PayKit playground — Next.js frontend.
#
# Build context is the REPO ROOT (see docker-compose.yml), because the frontend
# depends on the paykit SDK via a local `file:..` dependency. We build the SDK
# first so dist/ exists, then install + build the frontend against it. The
# playground runs the REAL paykit SDK in the browser — no backend required.
FROM node:20-alpine AS build
WORKDIR /repo

# 1. Build the paykit SDK -> dist/ (the file:.. dependency target)
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts
RUN npm run build

# 2. Install + build the frontend against the local paykit package
COPY frontend/package.json frontend/package-lock.json ./frontend/
WORKDIR /repo/frontend
RUN npm ci
COPY frontend ./
# Optional backend URL, inlined into the bundle by `next build` (NEXT_PUBLIC_*
# values are fixed at build time). Empty = the in-browser SDK.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
RUN npm run build

# 3. Runtime — serve the production Next.js build on :3005
FROM node:20-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /repo
# Copy as the built-in non-root `node` user (uid 1000, ships with the image) so
# nothing runs as root and Next can write its runtime cache under /repo/frontend.
# SDK package + built dist for the file:.. link to resolve at runtime.
COPY --from=build --chown=node:node /repo/package.json ./package.json
COPY --from=build --chown=node:node /repo/dist ./dist
COPY --from=build --chown=node:node /repo/src ./src
WORKDIR /repo/frontend
COPY --from=build --chown=node:node /repo/frontend ./
USER node
EXPOSE 3005
CMD ["npm", "run", "start"]
