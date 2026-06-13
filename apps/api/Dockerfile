# Multi-stage build for the Rust Axum API.
# rust:1-bookworm tracks the latest stable toolchain (matches rust-toolchain.toml
# `channel = "stable"`). Must be >= 1.85 — locked deps (e.g. time-core 0.1.8)
# require the edition2024 cargo feature.
FROM rust:1-bookworm AS builder
WORKDIR /app

# System dependencies for OpenSSL (used by jsonwebtoken, sea-orm).
RUN apt-get update && apt-get install -y --no-install-recommends \
    pkg-config libssl-dev ca-certificates && rm -rf /var/lib/apt/lists/*

# Pre-warm dependency cache. Copy every workspace member's manifest (the root
# workspace lists apps/api AND apps/api/migration — missing either makes cargo
# fail to load the workspace), then build against stub sources.
COPY Cargo.toml Cargo.lock ./
COPY apps/api/Cargo.toml apps/api/
COPY apps/api/migration/Cargo.toml apps/api/migration/
RUN mkdir -p apps/api/src apps/api/migration/src \
 && echo "fn main(){}" > apps/api/src/main.rs \
 && echo "fn main(){}" > apps/api/migration/src/main.rs \
 && echo "" > apps/api/migration/src/lib.rs \
 && cargo build --release -p acmind-api || true

# Real build. `touch` the just-copied sources first: Docker COPY preserves each
# file's original (git) mtime, which can be older than the stub artifacts built
# above — cargo would then skip recompiling and link the empty stub crates.
COPY apps/api apps/api
RUN find apps/api -name '*.rs' -exec touch {} + \
 && cargo build --release -p acmind-api

# Runtime image.
FROM debian:bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libssl3 && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/target/release/acmind-api /usr/local/bin/acmind-api

EXPOSE 8080
CMD ["acmind-api"]
