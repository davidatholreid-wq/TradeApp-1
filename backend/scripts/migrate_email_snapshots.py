"""Migrate dealer/user email snapshots from @fourbuy.co.za → @tradeapp.co.za
inside submissions + drafts. Idempotent — safe to re-run."""
import asyncio
import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")


async def main() -> None:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ["DB_NAME"]]

    collections = ["submissions", "drafts"]
    fields = [
        "dealer_email",
        "submitted_by_email",
        "created_by_email",
        "email",
    ]
    total = 0
    for coll in collections:
        for field in fields:
            cursor = db[coll].find(
                {field: {"$regex": r"@fourbuy\.co\.za$", "$options": "i"}},
                {"id": 1, field: 1},
            )
            async for doc in cursor:
                old = doc.get(field)
                if not isinstance(old, str):
                    continue
                new = old.replace("@fourbuy.co.za", "@tradeapp.co.za")
                if new != old:
                    await db[coll].update_one({"_id": doc["_id"]}, {"$set": {field: new}})
                    total += 1
    print(f"Updated {total} email snapshots across submissions/drafts.")


if __name__ == "__main__":
    asyncio.run(main())
