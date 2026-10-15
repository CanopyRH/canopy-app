# One image for every role. Set ROLE and the settings from deploy/services.env.example on the host.
FROM oven/bun:1.4.4-slim
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json ./
RUN bun install --frozen-lockfile --production
COPY src ./src
USER bun
CMD ["bun", "src/index.ts"]
