"""
Minimal HTTP wrapper around the theHarvester CLI.

WHY A WRAPPER EXISTS AT ALL. theHarvester is a command-line tool with no HTTP
interface of its own, unlike SpiderFoot which ships its own web server. The
Sentinel adapter (`src/utils/collectors/external/theharvester.ts`) speaks HTTP,
so something has to bridge the two.

THE CONTRACT IS ALREADY FIXED — this file conforms to it, not the reverse.
`theharvester.ts` was written first and defines:

    POST /harvest   {"domain": "...", "sources": ["crtsh", "certspotter"]}
      -> {"emails": [...], "hosts": ["host" | "host:ip", ...],
          "ips": [...], "urls": [...]}
    GET  /health    -> 200

Its parser reads `ips` or `ip_addresses`, and `urls` or `interesting_urls`, and
drops any element that is not a string. Do not "improve" the shapes below
without changing the adapter in the same commit.

LICENCE NOTE. theHarvester is GPL. It runs here as a separate process behind
HTTP and is never linked into Sentinel, which is precisely why the adapter was
built as a worker client rather than as a subprocess call inside the app.

PASSIVE SOURCES ONLY. The adapter's DEFAULT_SOURCES is ["crtsh", "certspotter"]
— both read public Certificate Transparency logs and never contact the target.
`-b all` is refused below: it pulls in sources that do touch the target, which
would silently break the passive-only guarantee the rest of Module 2 depends
on. Active reconnaissance in this system goes through the authorisation gate in
`src/utils/scan-authorization.ts`, not through here.
"""

import json
import re
import subprocess
import tempfile
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

app = FastAPI(title="theHarvester worker", version="1.0.0")

# theHarvester runs can be slow; this bounds a single request so a stuck scan
# cannot hold the adapter's own 30s budget open indefinitely.
TIMEOUT_SECONDS = 120

# Sources permitted through this wrapper. Passive only — see the module note.
ALLOWED_SOURCES = {"crtsh", "certspotter", "anubis", "hackertarget", "otx", "rapiddns", "urlscan"}

# A domain, conservatively. Anything else is refused rather than passed to a
# subprocess: this value reaches a command line.
DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


class HarvestRequest(BaseModel):
    domain: str
    sources: list[str] = Field(default_factory=lambda: ["crtsh", "certspotter"])


@app.get("/health")
def health() -> dict:
    """The adapter's healthCheck() calls this. Reports whether the CLI is present."""
    try:
        proc = subprocess.run(
            ["theHarvester", "--help"], capture_output=True, timeout=15, check=False
        )
        available = proc.returncode == 0
    except (FileNotFoundError, subprocess.TimeoutExpired):
        available = False
    # Honest about the distinction: the wrapper being up is not the same as
    # theHarvester being installed, and reporting 200 for both would hide it.
    return {"status": "ok" if available else "degraded", "theharvester_available": available}


@app.post("/harvest")
def harvest(req: HarvestRequest) -> JSONResponse:
    domain = req.domain.strip().lower().rstrip(".")
    if not DOMAIN_RE.match(domain):
        return JSONResponse(
            status_code=400,
            content={"error": f"{req.domain!r} is not a valid domain."},
        )

    sources = [s.strip().lower() for s in req.sources if s and s.strip()]
    # "all" is refused explicitly rather than filtered away silently, so a
    # caller asking for it learns why instead of quietly getting less.
    if "all" in sources:
        return JSONResponse(
            status_code=400,
            content={
                "error": "source 'all' is refused: it includes sources that contact the target "
                "directly, which would break the passive-only guarantee this worker exists to "
                "preserve. Name passive sources explicitly."
            },
        )
    sources = [s for s in sources if s in ALLOWED_SOURCES] or ["crtsh", "certspotter"]

    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "result"
        try:
            proc = subprocess.run(
                ["theHarvester", "-d", domain, "-b", ",".join(sources), "-f", str(out)],
                capture_output=True,
                timeout=TIMEOUT_SECONDS,
                check=False,
            )
        except FileNotFoundError:
            return JSONResponse(
                status_code=503,
                content={"error": "theHarvester is not installed in this container."},
            )
        except subprocess.TimeoutExpired:
            return JSONResponse(
                status_code=504,
                content={"error": f"theHarvester exceeded {TIMEOUT_SECONDS}s for {domain}."},
            )

        # theHarvester appends its own extension; accept either form.
        candidates = [out.with_suffix(".json"), Path(str(out) + ".json"), out]
        payload = None
        for candidate in candidates:
            if candidate.exists():
                try:
                    payload = json.loads(candidate.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    payload = None
                break

        if payload is None:
            # A failed run must not look like a domain with no records. The two
            # are opposite conclusions about the target.
            return JSONResponse(
                status_code=502,
                content={
                    "error": "theHarvester produced no readable JSON output.",
                    "exit_code": proc.returncode,
                    "stderr": proc.stderr.decode("utf-8", "replace")[:500],
                },
            )

    def strings(*keys: str) -> list[str]:
        for key in keys:
            value = payload.get(key)
            if isinstance(value, list):
                return [v for v in value if isinstance(v, str) and v.strip()]
        return []

    return JSONResponse(
        content={
            "domain": domain,
            "sources": sources,
            "emails": strings("emails"),
            "hosts": strings("hosts"),
            "ips": strings("ips", "ip_addresses"),
            "urls": strings("urls", "interesting_urls"),
        }
    )
