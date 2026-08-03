FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY db ./db
COPY src ./src

EXPOSE 3001

# Run migrations, then boot the API
CMD ["sh", "-c", "npm run migrate && node src/server.js"]
