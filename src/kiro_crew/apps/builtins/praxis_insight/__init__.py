"""Praxis Insight — surfaces the PraxisCode domain model in Kiro Crew.

The page, routes and simulator in this package exist to make Praxis's UNIQUE
capabilities first-class in the product shell while the real praxisd daemon
grows up: the 13-word lifecycle vocabulary, scoped approvals with named
refusal consequences, six-level Evidence provenance, and UNKNOWN-as-its-own-
state reconciliation. The simulator is deterministic; swapping it for real
praxisd queries is a one-module change (see backend/simulator.py).
"""
from kiro_crew.apps.builtins.praxis_insight.backend.routes import (  # noqa: F401
    register_routes,
)
