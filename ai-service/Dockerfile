FROM nvidia/cuda:12.1.1-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

RUN apt-get update && apt-get install -y --no-install-recommends \
        python3.11 \
        python3.11-distutils \
        python3-pip \
        ffmpeg \
        tesseract-ocr \
        tesseract-ocr-hin \
        tesseract-ocr-tam \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3.11 /usr/bin/python3 \
    && ln -sf /usr/bin/python3.11 /usr/bin/python

WORKDIR /app

COPY requirements.txt .
# torch does not force CUDA at runtime; resolved_device() falls back to CPU when
# torch.cuda.is_available() is False, so this image also runs on CPU-only hosts.
RUN pip install --upgrade pip && pip install -r requirements.txt
# Best-effort: c2pa-python is a compiled wheel and may not have a build for every
# target platform. Its import is guarded in app/forensics.py, so a failure here
# must not fail the image build — the reader just reports "reader_unavailable".
RUN pip install c2pa-python || echo "c2pa-python install failed — c2pa reader will report reader_unavailable"

COPY models/ ./models/
COPY app/ ./app/

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
