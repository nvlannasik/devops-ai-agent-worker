FROM node:24-alpine AS builder

WORKDIR /app

COPY package*.json ./
# --ignore-scripts: this stage only runs `tsc`, but npm ci also installs tsx (for `npm test`),
# whose esbuild dependency has a postinstall that EXECS the binary it just wrote. Under QEMU
# emulation — any cross-arch build, e.g. linux/amd64 on an arm64 host — that exec races the
# write and dies with ETXTBSY. No dependency here needs its install scripts, so skipping them
# fixes it deterministically instead of relying on the race landing the right way.
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY index.ts ./
COPY src/ ./src/

RUN npm run build


FROM alpine:3.20 AS aws-tools

ARG TARGETARCH
ARG SIGNING_HELPER_VERSION=1.8.4

RUN apk add --no-cache curl && \
    case "$TARGETARCH" in \
      amd64) ARCH="X86_64" ;; \
      arm64) ARCH="Aarch64" ;; \
      *)     echo "Unsupported arch: $TARGETARCH" && exit 1 ;; \
    esac && \
    curl -fLo /aws_signing_helper \
      "https://rolesanywhere.amazonaws.com/releases/${SIGNING_HELPER_VERSION}/${ARCH}/Linux/Amzn2023/aws_signing_helper" && \
    chmod +x /aws_signing_helper

FROM node:24-alpine AS runtime

RUN apk add --no-cache gcompat openssl

WORKDIR /app

COPY --from=aws-tools /aws_signing_helper /usr/local/bin/aws_signing_helper
RUN /usr/local/bin/aws_signing_helper version

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

EXPOSE 3000

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "dist/index.js"]