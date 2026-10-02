"""HTTP routes for CI/CD Studio."""
from aiohttp import web

_BASE = "/api/apps/praxis-cicd"

def register_routes(app: web.Application) -> None:
    """Register on the gateway's aiohttp Application."""
    # Routes will be added in the implementation pass.
    pass
