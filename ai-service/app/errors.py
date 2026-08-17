from fastapi import Request
from fastapi.responses import JSONResponse


class AIServiceError(Exception):
    status_code = 500

    def __init__(self, message: str):
        self.message = message
        super().__init__(message)


class ModelNotLoadedError(AIServiceError):
    status_code = 503


class NotImplementedYet(AIServiceError):
    status_code = 501


class InvalidInput(AIServiceError):
    status_code = 400


class UpstreamError(AIServiceError):
    status_code = 502


async def ai_service_error_handler(request: Request, exc: AIServiceError) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": type(exc).__name__, "cause": exc.message},
    )


async def unhandled_error_handler(request: Request, exc: Exception) -> JSONResponse:
    # Belt-and-braces: a bug or an unanticipated input must still surface as a
    # typed JSON envelope, never a bare "Internal Server Error" text response —
    # that would be a silent failure mode the no-fabrication rule forbids.
    return JSONResponse(
        status_code=500,
        content={"error": type(exc).__name__, "cause": str(exc)},
    )


def register_exception_handlers(app) -> None:
    app.add_exception_handler(AIServiceError, ai_service_error_handler)
    app.add_exception_handler(Exception, unhandled_error_handler)
