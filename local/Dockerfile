# Game image for local play, used by local/compose.play.yaml.
# Unlike the production Dockerfile it points the client to the Firebase Auth emulator.
# Build context: repository root.

FROM node:24.19.0-alpine AS builder
RUN apk add git --no-cache
WORKDIR /usr/src/app
COPY ./ ./
RUN npm install
RUN npm run download-music
RUN npm run assetpack

# Client config baked into the bundle at build time (dummy values, the emulator ignores them)
ENV FIREBASE_AUTH_EMULATOR_URL=auto \
    FIREBASE_API_KEY=fake-api-key \
    FIREBASE_AUTH_DOMAIN=demo-pac.firebaseapp.com \
    FIREBASE_PROJECT_ID=demo-pac \
    FIREBASE_STORAGE_BUCKET=demo-pac.appspot.com \
    FIREBASE_MESSAGING_SENDER_ID=000000000000 \
    FIREBASE_APP_ID=1:000000000000:web:0000000000000000
RUN npm run build

FROM node:24.19.0-alpine
# openssl is used to generate a throwaway service account key at startup
RUN apk add openssl --no-cache
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm install --only=production --ignore-scripts
COPY --from=builder /usr/src/app/app/public/dist ./app/public/dist
EXPOSE 9000
