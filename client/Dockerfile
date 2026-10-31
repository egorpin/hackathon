FROM node:22-bookworm-slim AS dev
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
EXPOSE 5173
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
    CMD node -e "fetch('http://127.0.0.1:5173/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["npm", "run", "dev", "--", "--port", "5173", "--strictPort"]

FROM node:22-bookworm-slim AS build
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /client/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
