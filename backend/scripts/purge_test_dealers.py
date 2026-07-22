#!/usr/bin/env python3
"""
One-off cleanup: remove every dealership + its users + submissions +
reward/redemption/report_order artefacts EXCEPT for:

  * Ford Bryanston (real customer)
  * Mini Test Motors (our standing testing_agent dealer — minitest@example.com)
  * All admin users (role="admin")

Before deleting anything we snapshot the affected docs to
`/app/memory/deleted_dealers_backup.json` so the operation is reversible.
"""
import asyncio
import json
import os
import sys
from datetime import datetime
from pathlib import Path

from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient

load_dotenv()

KEEP_DEALERSHIP_NAMES = {"Ford Bryanston", "Mini Test Motors"}
BACKUP_PATH = Path("/app/memory/deleted_dealers_backup.json")


def _default(o):
    if isinstance(o, datetime):
        return o.isoformat()
    if isinstance(o, bytes):
        return o.decode("utf-8", errors="replace")
    return str(o)


async def main() -> int:
    client = AsyncIOMotorClient(os.environ["MONGO_URL"])
    db = client[os.environ.get("DB_NAME", "fourbuy")]

    # --- Figure out which dealership IDs to KEEP ---
    keep_ids: set[str] = set()
    async for d in db.dealerships.find({"name": {"$in": list(KEEP_DEALERSHIP_NAMES)}}):
        keep_ids.add(d["id"])

    if not keep_ids:
        print("ABORT: could not find any of the keep-dealerships:", KEEP_DEALERSHIP_NAMES)
        return 1
    print(f"Keeping dealership IDs: {keep_ids}")

    # --- Snapshot everything we're about to delete ---
    to_del_dealerships = await db.dealerships.find(
        {"id": {"$nin": list(keep_ids)}}, {"_id": 0}
    ).to_list(None)
    del_dealership_ids = [d["id"] for d in to_del_dealerships]
    to_del_users = await db.users.find(
        {"role": "dealer", "dealership_id": {"$in": del_dealership_ids}},
        {"_id": 0},
    ).to_list(None)
    del_user_ids = [u["id"] for u in to_del_users]
    to_del_subs = await db.submissions.find(
        {"dealership_id": {"$in": del_dealership_ids}}, {"_id": 0}
    ).to_list(None)
    del_sub_ids = [s["id"] for s in to_del_subs]
    to_del_ledger = await db.reward_ledger.find(
        {"user_id": {"$in": del_user_ids}}, {"_id": 0}
    ).to_list(None)
    to_del_redemptions = await db.reward_redemptions.find(
        {"user_id": {"$in": del_user_ids}}, {"_id": 0}
    ).to_list(None)
    to_del_report_orders = await db.report_orders.find(
        {"submission_id": {"$in": del_sub_ids}}, {"_id": 0}
    ).to_list(None)

    backup = {
        "snapshotted_at": datetime.utcnow().isoformat() + "Z",
        "kept_dealership_ids": sorted(keep_ids),
        "dealerships": to_del_dealerships,
        "users": to_del_users,
        "submissions": to_del_subs,
        "reward_ledger": to_del_ledger,
        "reward_redemptions": to_del_redemptions,
        "report_orders": to_del_report_orders,
    }
    BACKUP_PATH.parent.mkdir(parents=True, exist_ok=True)
    BACKUP_PATH.write_text(json.dumps(backup, default=_default, indent=2))
    print(f"snapshot saved to {BACKUP_PATH}")

    print("--- About to delete ---")
    print(f"  dealerships:        {len(to_del_dealerships)}")
    print(f"  dealer users:       {len(to_del_users)}")
    print(f"  submissions:        {len(to_del_subs)}")
    print(f"  reward_ledger rows: {len(to_del_ledger)}")
    print(f"  reward_redemptions: {len(to_del_redemptions)}")
    print(f"  report_orders:      {len(to_del_report_orders)}")

    # --- Delete in dependency order ---
    r = await db.report_orders.delete_many({"submission_id": {"$in": del_sub_ids}})
    print(f"deleted report_orders:   {r.deleted_count}")
    r = await db.reward_ledger.delete_many({"user_id": {"$in": del_user_ids}})
    print(f"deleted reward_ledger:   {r.deleted_count}")
    r = await db.reward_redemptions.delete_many({"user_id": {"$in": del_user_ids}})
    print(f"deleted reward_redemps:  {r.deleted_count}")
    r = await db.submissions.delete_many({"dealership_id": {"$in": del_dealership_ids}})
    print(f"deleted submissions:     {r.deleted_count}")
    r = await db.users.delete_many(
        {"role": "dealer", "dealership_id": {"$in": del_dealership_ids}}
    )
    print(f"deleted dealer users:    {r.deleted_count}")
    r = await db.dealerships.delete_many({"id": {"$in": del_dealership_ids}})
    print(f"deleted dealerships:     {r.deleted_count}")

    # Also drop any orphan dealer users that somehow have no dealership_id set.
    r = await db.users.delete_many(
        {"role": "dealer", "$or": [{"dealership_id": None}, {"dealership_id": {"$exists": False}}]}
    )
    if r.deleted_count:
        print(f"deleted orphan users:    {r.deleted_count}")

    # --- Confirm the after state ---
    print("--- After ---")
    print(f"  dealerships:        {await db.dealerships.count_documents({})}")
    print(f"  users (admin):      {await db.users.count_documents({'role': 'admin'})}")
    print(f"  users (dealer):     {await db.users.count_documents({'role': 'dealer'})}")
    print(f"  submissions:        {await db.submissions.count_documents({})}")
    print(f"  reward_ledger:      {await db.reward_ledger.count_documents({})}")
    print(f"  reward_redemptions: {await db.reward_redemptions.count_documents({})}")
    print(f"  report_orders:      {await db.report_orders.count_documents({})}")

    async for d in db.dealerships.find({}, {"_id": 0, "name": 1, "id": 1}):
        u = await db.users.count_documents({"dealership_id": d["id"]})
        s = await db.submissions.count_documents({"dealership_id": d["id"]})
        print(f"  {d['name']:30s} users={u} subs={s}")

    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
