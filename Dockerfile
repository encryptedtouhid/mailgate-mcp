FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
LABEL org.opencontainers.image.title="mailgate-mcp" \
      org.opencontainers.image.description="Guarded MCP server for IMAP/SMTP mailboxes" \
      org.opencontainers.image.source="https://github.com/encryptedtouhid/mailgate-mcp"
WORKDIR /app
# HTTP by default; set MCP_TRANSPORT=stdio to use the container from Claude Desktop.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 MCP_TRANSPORT=http
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 3000
USER node
# Only meaningful in HTTP mode; stdio containers have no port to probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD [ "$MCP_TRANSPORT" != "http" ] || wget -q -O /dev/null "http://127.0.0.1:${PORT}/health"
CMD ["node", "dist/index.js"]
