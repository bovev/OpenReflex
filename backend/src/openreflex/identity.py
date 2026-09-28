"""Single source of product naming and protocol versions.

Rename the product here; nothing else should hard-code these values.
"""

from __future__ import annotations

from typing import Final

PRODUCT_NAME: Final = "OpenReflex"
PACKAGE_SLUG: Final = "openreflex"
APP_DATA_DIR_NAME: Final = "OpenReflex"
SERVICE_EXECUTABLE: Final = "openreflex-service"
MCP_EXECUTABLE: Final = "openreflex-mcp"

# Versions of the public, product-owned contracts.
RECIPE_SCHEMA_VERSION: Final = 1
RESULT_CONTRACT_VERSION: Final = 1
API_PREFIX: Final = "/v1"

ATTRIBUTION: Final = (
    "Powered by Laya, an open-source System 1 decision model developed by Convai Innovations."
)
