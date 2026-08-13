"""Purge TEST-prefixed and sold stock_items and unlink orphaned submissions."""
import asyncio, os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv
load_dotenv('/app/backend/.env')

async def main():
    client = AsyncIOMotorClient(os.environ['MONGO_URL'])
    db = client[os.environ['DB_NAME']]
    async for si in db.stock_items.find({}, {'id':1,'stock_number':1,'submission_id':1,'sold':1}):
        sn = si.get('stock_number') or ''
        if 'TEST' in sn.upper() or si.get('sold'):
            print('deleting', si['id'], sn, 'sold=', si.get('sold'))
            await db.stock_items.delete_one({'id': si['id']})
    async for sub in db.submissions.find({'stock_item_id': {'$exists': True}}, {'id':1,'stock_item_id':1,'stock_number':1}):
        sid = sub.get('stock_item_id')
        exists = await db.stock_items.find_one({'id': sid}, {'id':1})
        if not exists:
            print('unlinking sub', sub.get('id'), 'from missing stock', sid)
            await db.submissions.update_one({'id': sub['id']}, {'$unset': {'stock_item_id':'', 'stock_number':'', 'transferred_to_stock_at':'', 'transferred_to_stock_by':''}})
    async for sub in db.submissions.find({'stock_number': {'$regex':'STK-TEST','$options':'i'}}, {'id':1}):
        print('force-unlink TEST-flagged sub', sub['id'])
        await db.submissions.update_one({'id': sub['id']}, {'$unset': {'stock_item_id':'', 'stock_number':'', 'transferred_to_stock_at':'', 'transferred_to_stock_by':''}})
    print('remaining stock_items:', await db.stock_items.count_documents({}))

asyncio.run(main())
