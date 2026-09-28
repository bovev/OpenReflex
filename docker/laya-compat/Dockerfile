# Linux environment for Laya real-model compatibility checks.
# Not a shipping artifact: native Windows support is verified separately.
FROM python:3.12-slim

ENV PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    HF_HOME=/hf-cache

COPY constraints.txt /tmp/constraints.txt
RUN pip install --index-url https://download.pytorch.org/whl/cpu -c /tmp/constraints.txt torch \
 && pip install -c /tmp/constraints.txt laya "pydantic>=2.9,<3" "pyyaml>=6.0.2,<7" "pytest>=8.3"

WORKDIR /repo
