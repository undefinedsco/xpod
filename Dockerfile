# Build stage
FROM node:18-alpine AS build

# Install Python
RUN apk add --no-cache python3

# Set Python environment variable
ENV PYTHON=/usr/bin/python3

# Set current working directory
WORKDIR /xpod

# Copy the dockerfile's context's community server files
COPY . .

# Install and build the Solid community server (prepare script cannot run in wd)
RUN yarn install --frozen-lockfile && yarn build


# Runtime stage
FROM node:18-alpine

# Add contact informations for questions about the container
LABEL maintainer="Xpod Docker Image Maintainer <developer@undefieds.co>"

# Container config & data dir for volume sharing
# Defaults to filestorage with /data directory (passed through CMD below)
RUN mkdir /config /data

# Set current directory
WORKDIR /xpod

# Copy runtime files from build stage
COPY --from=build /xpod/package.json .
COPY --from=build /xpod/config ./config
COPY --from=build /xpod/dist ./dist
COPY --from=build /xpod/node_modules ./node_modules

# Informs Docker that the container listens on the specified network port at runtime
EXPOSE 3000

# Set command run by the container
ENTRYPOINT ["node", "node_modules/@solid/community-server/bin/server.js", "-c", "config/main.server.json", "config/extensions.cloud.json", "-m", "." ]