# Base images are pinned by multi-arch index digest (tag kept for
# readability); Dependabot proposes digest bumps. Refresh with
# "docker compose build --pull" after merging one.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime: no shell, no package manager, runs as non-root.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3220
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
USER nonroot
EXPOSE 3220
CMD ["--enable-source-maps", "dist/index.js"]
