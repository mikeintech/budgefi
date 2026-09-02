FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/capacitor-system-session/package.json packages/capacitor-system-session/package.json
RUN npm ci
COPY . .
RUN npm run build:backend:emit && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist-backend ./dist-backend
COPY --from=build /app/migrations ./dist-backend/migrations
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/capacitor-system-session ./packages/capacitor-system-session
USER node
CMD ["node", "dist-backend/apps/api/src/main.js"]
