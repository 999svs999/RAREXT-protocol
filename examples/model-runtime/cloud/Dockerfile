FROM node:24-slim

WORKDIR /work

# The runtime and its SDK are TypeScript run directly by Node; there is no
# build step and no native dependency. Copy only what the control plane needs.
COPY package.json tsconfig.json ./
COPY apps/runtime ./apps/runtime
COPY packages/core ./packages/core
COPY packages/agent-sdk ./packages/agent-sdk

ENV NODE_ENV=production
EXPOSE 8790

ENTRYPOINT ["node", "apps/runtime/src/cli.ts"]
CMD ["serve", "--manifest", "/state/deployment.json", "--state", "/state", "--host", "0.0.0.0", "--port", "8790", "--publish"]
