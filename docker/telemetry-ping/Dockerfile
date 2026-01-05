FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

ENV PORT=8080
CMD exec gunicorn --bind :$PORT --workers 1 --threads 2 --timeout 30 main:app
