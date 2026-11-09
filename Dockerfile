FROM node:24.22.1-slim AS build

WORKDIR /workspace
RUN npm install --global pnpm@10.26.1

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm run build

FROM node:24.22.1-slim AS runtime

WORKDIR /workspace
ENV NODE_ENV=production
ENV SERVE_FRONTEND=true

COPY --from=build /workspace/artifacts/api-server/dist ./artifacts/api-server/dist
COPY --from=build /workspace/artifacts/sharepoint-browser/dist/public ./artifacts/sharepoint-browser/dist/public

CMD ["node", "--enable-source-maps", "artifacts/api-server/dist/index.mjs"]
