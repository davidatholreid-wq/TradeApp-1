"""One-time migration: rename recon categories to the new enum.

Run once after deploying the updated RECON_CATEGORIES list. Idempotent —
running it more than once will simply find no more docs to update.

Mapping:
    Body Panels   -> Bodywork
    Interior      -> Interior / Trim

All other current categories (Tyres, Windscreen, Mechanical) are kept
as-is. The new categories "Rims" and "Valet" don't need to be migrated
because they didn't exist previously.
"""

import asyncio
import os
import sys

# Add /app/backend to import path so we can reuse the shared db handle
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from server import db  # noqa: E402


MAPPING = {
    "Body Panels": "Bodywork",
    "Interior": "Interior / Trim",
}


async def migrate_suppliers():
    updated = 0
    async for doc in db.suppliers.find({}, {"_id": 0, "id": 1, "categories": 1}):
        cats = doc.get("categories") or []
        new_cats = []
        changed = False
        for c in cats:
            mapped = MAPPING.get(c, c)
            if mapped != c:
                changed = True
            if mapped not in new_cats:
                new_cats.append(mapped)
        if changed:
            await db.suppliers.update_one(
                {"id": doc["id"]},
                {"$set": {"categories": new_cats}},
            )
            updated += 1
    print(f"suppliers: renamed categories on {updated} doc(s)")


async def migrate_submissions():
    """Update submission.reconditioning_items[].category AND any embedded
    supplier snapshot's categories[] to the new enum."""
    updated = 0
    async for sub in db.submissions.find(
        {"reconditioning_items": {"$exists": True, "$ne": []}},
        {"_id": 0, "id": 1, "reconditioning_items": 1},
    ):
        items = sub.get("reconditioning_items") or []
        changed = False
        for it in items:
            # Line-item category
            cat = it.get("category")
            if cat in MAPPING:
                it["category"] = MAPPING[cat]
                changed = True
            # Embedded supplier snapshot (categories were captured at
            # assignment time in the previous rounds — safe to leave
            # untouched since we only display the supplier's name/phone
            # from the snapshot; but rename them anyway for consistency).
            sup = it.get("supplier") or None
            if sup and isinstance(sup.get("categories"), list):
                new_sup_cats = []
                sup_changed = False
                for c in sup["categories"]:
                    mapped = MAPPING.get(c, c)
                    if mapped != c:
                        sup_changed = True
                    if mapped not in new_sup_cats:
                        new_sup_cats.append(mapped)
                if sup_changed:
                    sup["categories"] = new_sup_cats
                    changed = True
        if changed:
            await db.submissions.update_one(
                {"id": sub["id"]},
                {"$set": {"reconditioning_items": items}},
            )
            updated += 1
    print(f"submissions: renamed recon categories on {updated} doc(s)")


async def main():
    print(f"Running recon-category migration ({MAPPING})...")
    await migrate_suppliers()
    await migrate_submissions()
    print("done.")


if __name__ == "__main__":
    asyncio.run(main())
