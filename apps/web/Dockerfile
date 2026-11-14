FROM node:22-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@12.18.0 --activate

COPY package.json ./
RUN pnpm install

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
RUN pnpm build

FROM nginx:alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80
