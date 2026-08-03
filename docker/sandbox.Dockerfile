# syntax=docker/dockerfile:1.7
ARG AES_SANDBOX_IMAGE=ghcr.io/rlabs88/toolkit/aes-sandbox@sha256:8965a9f6d38494d90e717e72f3283c7b47c82368ebe390c49c604c718023bda0
FROM ${AES_SANDBOX_IMAGE}

LABEL ai.mastra.toolkit="true"
