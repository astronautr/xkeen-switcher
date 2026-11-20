FROM node:24.18.0-alpine AS ui-build
WORKDIR /build/frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
COPY src/xk_switcher/static/ /build/src/xk_switcher/static/
RUN npm run build && npm run test:build

FROM python:3.12-alpine AS runtime
RUN apk add --no-cache openssh-client sshpass
WORKDIR /app
COPY src/ ./src/
COPY --from=ui-build /build/frontend/dist/ /app/ui-dist/
ENV PYTHONPATH=/app/src
ENV PYTHONUNBUFFERED=1
ENV XK_UI_DIST=/app/ui-dist
EXPOSE 8080
CMD ["python", "-m", "xk_switcher.app"]

FROM runtime AS test
RUN apk add --no-cache bash
COPY pyproject.toml ./
COPY tests/ ./tests/
COPY frontend/src/ ./frontend/src/
COPY frontend/tests/fixtures/ ./frontend/tests/fixtures/
COPY router/ ./router/
COPY scripts/install-routing-helper.sh scripts/set-password.sh scripts/dev-native.sh ./scripts/
RUN pip install --no-cache-dir '.[dev]'
CMD ["pytest"]

FROM runtime AS production
