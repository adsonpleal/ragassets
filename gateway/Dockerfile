# Build a tiny static binary, then ship it on distroless (a few MB, runs nonroot).
FROM golang:1.22-alpine AS build
WORKDIR /src

# Copy the module files first and pre-fetch deps for layer caching (reused unless
# go.mod/go.sum change), then copy the full source tree (the renderer lives under
# internal/render and embeds its resolver data via go:embed).
COPY go.mod go.sum ./
RUN go mod download
COPY . .

# CGO off → fully static binary that runs on the empty distroless/static image.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /ragassets-gateway .

FROM gcr.io/distroless/static:nonroot
EXPOSE 8080
COPY --from=build /ragassets-gateway /ragassets-gateway
USER nonroot:nonroot
ENTRYPOINT ["/ragassets-gateway"]
