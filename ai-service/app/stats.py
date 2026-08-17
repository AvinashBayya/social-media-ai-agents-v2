"""In-process request counter for `/ai/stats`.

`/ai/stats` used to hardcode `{"calls": 0, "cache_hits": 0}` regardless of
actual usage — reporting "nothing happened" on a service that plainly does
handle requests. `cache_hits` stays honestly 0: there is no caching layer
anywhere in this service yet, so a cache genuinely cannot have been hit,
which is a different situation from `calls` reporting a false zero for
something real. When a cache is actually added, `cache_hits` starts
meaning something; until then, 0 is the true count, not a placeholder.

Per-process only, mirroring `registry` in `loaders.py` — lost on restart,
which is fine here: this is a live-usage counter, not a durable log.
"""


class RequestStats:
    def __init__(self) -> None:
        self.calls = 0
        self.cache_hits = 0

    def record_call(self) -> None:
        self.calls += 1

    def snapshot(self) -> dict[str, int]:
        return {"calls": self.calls, "cache_hits": self.cache_hits}


stats = RequestStats()
