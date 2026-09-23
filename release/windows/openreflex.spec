# PyInstaller spec: one --onedir folder holding both executables.
#
# openreflex-service.exe and openreflex-mcp.exe share one ``_internal``
# runtime and sit side by side, which is the layout the MCP launcher and the
# client-config generator rely on to find each other. Built by build.py,
# which also adds the UI and notices next to the executables.
import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

HERE = Path(SPECPATH)
ROOT = HERE.parents[1]
PATHS = [str(ROOT / "backend" / "src"), str(ROOT / "mcp_bridge" / "src")]
sys.path[:0] = PATHS

from openreflex.identity import MCP_EXECUTABLE, PRODUCT_NAME, SERVICE_EXECUTABLE

DATAS = collect_data_files("openreflex")
# uvicorn picks its loop/protocol implementations by import string.
HIDDEN = collect_submodules("uvicorn")


def analysis(entry):
    return Analysis(
        [str(HERE / entry)],
        pathex=PATHS,
        datas=DATAS,
        hiddenimports=HIDDEN,
        noarchive=False,
    )


def executable(built, name):
    return EXE(
        PYZ(built.pure),
        built.scripts,
        [],
        exclude_binaries=True,
        name=name,
        console=True,
        upx=False,
    )


service = analysis("entry_service.py")
mcp = analysis("entry_mcp.py")

COLLECT(
    executable(service, SERVICE_EXECUTABLE),
    service.binaries,
    service.datas,
    executable(mcp, MCP_EXECUTABLE),
    mcp.binaries,
    mcp.datas,
    name=PRODUCT_NAME,
    upx=False,
)
