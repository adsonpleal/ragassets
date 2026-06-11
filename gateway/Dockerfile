# Build a tiny static binary, then ship it on distroless (a few MB, runs nonroot).
FROM golang:1.22-alpine AS build
WORKDIR /src

# No external dependencies — copy go.mod first for layer caching, then sources.
COPY go.mod ./
COPY *.go ./

# CGO off → fully static binary that runs on the empty distroless/static image.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /zrenderer-gateway .

FROM gcr.io/distroless/static:nonroot
EXPOSE 8080
COPY --from=build /zrenderer-gateway /zrenderer-gateway
USER nonroot:nonroot
ENTRYPOINT ["/zrenderer-gateway"]
