FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
# --max-old-space-size=400  → limita heap a 400MB (dentro dos 512MB do Render free)
# --expose-gc               → permite chamar global.gc() no código para forçar limpeza
CMD ["node", "--max-old-space-size=400", "--expose-gc", "index.js"]
