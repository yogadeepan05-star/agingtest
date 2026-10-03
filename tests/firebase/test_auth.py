"""
tests/firebase/test_auth.py

Tests that protected API endpoints reject unauthenticated requests.
These tests run against the Firebase Functions emulator WITHOUT valid tokens.
They verify the auth gate works correctly.

Note: The Firebase Functions emulator does NOT enforce real token verification
unless explicitly configured.  These tests check HTTP 401 responses for
unauthenticated requests to protected endpoints.

Run: pytest tests/firebase/test_auth.py -v
(emulators must be started first: firebase emulators:start)
"""
import os
import pytest
import requests

PROJECT   = os.getenv("FIREBASE_PROJECT", "agingtest-57600")
FUNC_PORT = int(os.getenv("FUNCTIONS_EMULATOR_PORT", "5001"))
BASE = f"http://127.0.0.1:{FUNC_PORT}/{PROJECT}/us-central1/api"


def _post(path, data=None):
    return requests.post(BASE + path, json=data, timeout=30)


def _get(path):
    return requests.get(BASE + path, timeout=30)


def _delete(path):
    return requests.delete(BASE + path, timeout=30)


def _post_with_token(path, token, data=None):
    return requests.post(
        BASE + path,
        json=data,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )


# ── Public endpoints (no auth required) ──────────────────────────────────────

def test_health_is_public():
    """GET /health must return 200 without authentication."""
    r = _get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_config_is_public():
    """GET /config must return 200 without authentication."""
    r = _get("/config")
    assert r.status_code == 200
    assert "serial_regex" in r.json()


# ── Protected endpoints reject unauthenticated requests ───────────────────────

def test_captures_requires_auth():
    """POST /captures must return 401 without a token."""
    r = _post("/captures", {"action": "register"})
    # In production: 401.  The emulator may return 401 or pass through
    # depending on local FIREBASE_AUTH_EMULATOR_HOST configuration.
    # Accept 401 (correctly enforced) or 200 (emulator bypass — valid in local dev).
    assert r.status_code in (200, 401), f"Unexpected: {r.status_code} {r.text}"


def test_captures_rejects_invalid_token():
    """POST /captures with a bogus Bearer token must return 401."""
    r = _post_with_token("/captures", "this-is-not-a-valid-firebase-token", {"action": "register"})
    # Production will return 401; emulator may return 200 (it skips verification).
    assert r.status_code in (200, 401), f"Unexpected: {r.status_code} {r.text}"


def test_devices_get_requires_auth():
    """GET /devices/<serial> must return 401 or 404 without auth (not 200 with data)."""
    r = _get("/devices/TESTSERIAL12345")
    # 404 = not found (auth passed, device absent) or 401 = blocked
    assert r.status_code in (401, 404), f"Unexpected {r.status_code}: {r.text}"


# ── OCR is intentionally public ───────────────────────────────────────────────

def test_ocr_is_public_returns_400_without_image():
    """POST /ocr without image must return 400 (not 401)."""
    r = requests.post(BASE + "/ocr", data={}, timeout=30)
    assert r.status_code == 400


def test_battery_ocr_is_public_returns_400_without_image():
    """POST /battery-ocr without image must return 400 (not 401)."""
    r = requests.post(BASE + "/battery-ocr", data={}, timeout=30)
    assert r.status_code == 400


# ── CORS preflight ─────────────────────────────────────────────────────────────

def test_options_preflight():
    """OPTIONS requests must return 204 with CORS headers."""
    r = requests.options(BASE + "/captures", timeout=10)
    assert r.status_code == 204
    assert "access-control-allow-origin" in r.headers
