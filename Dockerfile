# 감정 방패 API 서버. 환경변수는 배포 플랫폼에서 주입 (.env.example 참고)
FROM node:22-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/mock-commerce/package.json apps/mock-commerce/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile --prod
COPY apps/api apps/api
COPY apps/mock-commerce apps/mock-commerce
COPY packages/contracts packages/contracts
ENV NODE_ENV=production PORT=8000
EXPOSE 8000
# 시작할 때 마이그레이션(이미 적용된 건 건너뜀) + 데모 매장 시드(이미 있으면 건너뜀) 후 서버
CMD ["sh", "-c", "pnpm migrate && pnpm seed && pnpm start"]
