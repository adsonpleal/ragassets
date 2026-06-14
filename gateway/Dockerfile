# Build a tiny static binary, then ship it on distroless (a few MB, runs nonroot).
FROM golang:1.22-alpine AS build
WORKDIR /src

# Two small pure-Go deps (APNG decode + color quantization, used only by /gif).
# Copy the module files first and pre-fetch the deps for layer caching (reused
# unless go.mod/go.sum change), then copy sources.
COPY go.mod go.sum ./
RUN go mod download github.com/kettek/apng github.com/ericpauley/go-quantize
COPY *.go ./

# CGO off → fully static binary that runs on the empty distroless/static image.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /zrenderer-gateway .

# Pre-create an empty cache dir owned by the distroless nonroot user (UID 65532).
# A fresh named volume mounted at /cache inherits this ownership, so the nonroot
# process can write to it. Without this the volume defaults to root-owned.
RUN mkdir -p /cache

FROM gcr.io/distroless/static:nonroot
EXPOSE 8080
COPY --from=build /zrenderer-gateway /zrenderer-gateway
COPY --from=build --chown=65532:65532 /cache /cache
USER nonroot:nonroot
ENTRYPOINT ["/zrenderer-gateway"]
