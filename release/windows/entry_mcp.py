"""PyInstaller entry script for the MCP executable."""

import sys

from openreflex_mcp.cli import main

sys.exit(main())
