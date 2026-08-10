"""One-shot script to seed a stale priced submission for dave that
will get swept by the auto-expiry logic on the next
/api/stats/deal-outcomes/list read. Used by the frontend playwright
test in iteration_50 so the amber chip shows up. Cleanup uses the
same reference prefix.
"""
import asyncio
import os
import uuid
import sys
from datetime import datetime, timedelta, timezone

from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")


async def seed():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    dealer = await db.users.find_one({"email": "dave@fourbuy.co.za"}, {"_id": 0})
    if not dealer:
        print("dealer not found")
        return
    sub_id = str(uuid.uuid4())
    created_iso = (datetime.now(timezone.utc) - timedelta(days=45)).isoformat()
    priced_iso = (datetime.now(timezone.utc) - timedelta(days=40)).isoformat()
    doc = {
        "id": sub_id,
        "reference": f"TEST-EXP-{sub_id[:6].upper()}",
        "dealer_id": dealer.get("id"),
        "dealership_id": dealer.get("dealership_id"),
        "dealer_name": "TEST dealer",
        "submitted_by_name": "TEST auto-expiry",
        "status": "priced",
        "created_at": created_iso,
        "submitted_at": created_iso,
        "priced_at": priced_iso,
        "make_name": "Toyota",
        "model_name": "Auto Expiry Test",
        "derivative_name": "TEST-EXP",
        "year": 2020,
        "mileage": 45000,
        "colour": "White",
        "price": 250000,
        "dealer_offer_zar": None,
        "photos": {},
        "deal": {},
    }
    await db.submissions.insert_one(doc)
    print(f"SEEDED_ID={sub_id}")
    print(f"SEEDED_REF={doc['reference']}")
    client.close()


async def cleanup():
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]
    r = await db.submissions.delete_many({"reference": {"$regex": "^TEST-EXP-"}})
    print(f"DELETED={r.deleted_count}")
    client.close()


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "cleanup":
        asyncio.run(cleanup())
    else:
        asyncio.run(seed())
