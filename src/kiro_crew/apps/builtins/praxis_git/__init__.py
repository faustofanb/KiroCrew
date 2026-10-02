"""Git Studio — a full visual Git client (Fork-class) as a KiroCrew page.

The backend in ``backend/`` is a typed adapter over real git subprocesses:
paginated commit graph with incremental lane layout, line-level staging,
merge conflict resolution, interactive rebase with a first-class todo
editor, stash, cherry-pick/revert, remotes, worktrees and streaming
fetch/pull/push. No mocks — every button is a real git invocation.
"""

from kiro_crew.apps.builtins.praxis_git.backend.routes import (  # noqa: F401
    register_routes,
)
