FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY index.html tsconfig.json vite.config.mjs ./
COPY src ./src
COPY server ./server
RUN npm run build && mkdir /workbench && chown node:node /workbench
USER node
ENV RENDER_WORKBENCH_HOME=/workbench RENDER_WORKBENCH_DOCKER=1
EXPOSE 5173
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--configLoader", "native", "--host", "0.0.0.0", "--port", "5173", "--strictPort"]
