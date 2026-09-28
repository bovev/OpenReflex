"""The only package allowed to import ``laya``.

Everything upstream-specific (question schema, output fields, token budgets,
stdout printing, error types) is contained here and converted into
product-owned contracts. See docs/architecture/laya-compatibility.md.
"""

from openreflex.laya_adapter.adapter import LayaAdapter

__all__ = ["LayaAdapter"]
