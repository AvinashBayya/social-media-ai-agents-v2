# theHarvester CLI + a thin FastAPI wrapper.
#
# theHarvester is GPL and runs here as its own process behind HTTP. Nothing is
# linked into Sentinel — see app.py's module note for why that distinction is
# the whole reason this container exists rather than a subprocess call.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      fastapi==0.115.6 \
      "uvicorn[standard]==0.34.0" \
      pydantic==2.10.4 \
      theHarvester

WORKDIR /app
COPY app.py .

EXPOSE 5002
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "5002"]
