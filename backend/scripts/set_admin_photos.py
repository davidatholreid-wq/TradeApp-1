"""One-shot script — upload the user-supplied cover and profile photos for
the admin account to Cloudinary and persist the resulting secure URLs on the
admin's user document.

Usage (from /app/backend):
    python scripts/set_admin_photos.py

Idempotent: safe to re-run. Uses fixed Cloudinary `public_id`s under
`fourbuy/admin/<user_id>/` so re-runs OVERWRITE the same asset rather than
piling up duplicates.
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
import sys
from pathlib import Path

# Ensure server module (which loads dotenv + configures Cloudinary at import
# time) is importable from this scripts/ location.
BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from dotenv import load_dotenv
load_dotenv(BACKEND_DIR / ".env")

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from server import upload_image_to_cloudinary  # noqa: E402


ADMIN_EMAIL = os.environ.get("ADMIN_PHOTOS_EMAIL", "admin@fourbuy.co.za")
FRONTEND_ASSETS = BACKEND_DIR.parent / "frontend" / "assets" / "profile"
COVER_PATH = FRONTEND_ASSETS / "cover.jpeg"
PROFILE_PATH = FRONTEND_ASSETS / "profile.jpeg"


def _to_data_url(path: Path) -> str:
    """Convert a local image file to a base64 `data:` URL suitable for
    passing to `upload_image_to_cloudinary`."""
    mime, _ = mimetypes.guess_type(path.name)
    if not mime:
        mime = "image/jpeg"
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


async def main() -> None:
    mongo_url = os.environ.get("MONGO_URL")
    db_name = os.environ.get("DB_NAME") or os.environ.get("MONGO_DB_NAME") or "fourbuy"
    if not mongo_url:
        raise SystemExit("MONGO_URL not set in backend/.env")

    if not COVER_PATH.exists() or not PROFILE_PATH.exists():
        raise SystemExit(
            f"Missing local asset(s): cover={COVER_PATH.exists()} profile={PROFILE_PATH.exists()}"
        )

    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]

    admin = await db.users.find_one({"email": ADMIN_EMAIL})
    if not admin:
        raise SystemExit(f"Admin user not found: {ADMIN_EMAIL}")

    user_id = admin["id"]
    folder = f"fourbuy/admin/{user_id}"

    print(f"→ Uploading photos for admin {ADMIN_EMAIL} (id={user_id})")
    print(f"   cover:   {COVER_PATH} ({COVER_PATH.stat().st_size / 1024:.1f} KB)")
    print(f"   profile: {PROFILE_PATH} ({PROFILE_PATH.stat().st_size / 1024:.1f} KB)")

    cover_url = upload_image_to_cloudinary(
        _to_data_url(COVER_PATH), folder=folder, public_id="cover_photo",
    )
    profile_url = upload_image_to_cloudinary(
        _to_data_url(PROFILE_PATH), folder=folder, public_id="profile_pic",
    )

    if not cover_url or not profile_url:
        raise SystemExit("Cloudinary upload failed — see server logs")

    print("← Cloudinary URLs received:")
    print(f"   cover:   {cover_url[:90]}...")
    print(f"   profile: {profile_url[:90]}...")

    await db.users.update_one(
        {"id": user_id},
        {"$set": {"cover_photo": cover_url, "profile_pic": profile_url}},
    )
    print(f"✓ Persisted on users.{user_id}")

    client.close()


if __name__ == "__main__":
    asyncio.run(main())
