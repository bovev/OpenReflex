"""Thin stdio MCP bridge to the local OpenReflex service.

The bridge never loads a model. Every tool call is forwarded to the one
running service over loopback HTTP with the shared per-install token.
"""
