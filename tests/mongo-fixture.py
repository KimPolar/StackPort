import sys

from bson import Binary, Decimal128, Int64, ObjectId
from pymongo import MongoClient


port, ca_path = sys.argv[1:]
options = {
    'port': int(port),
    'tls': True,
    'tlsCAFile': ca_path,
    'serverSelectionTimeoutMS': 2000,
    'directConnection': True,
}

with MongoClient('localhost', **options) as first_user:
    first_user.admin.command('createUser', 'stackport_fixture_admin',
                             pwd='stackport-fixture-admin', roles=['root'])

with MongoClient('localhost', **options, username='stackport_fixture_admin',
                 password='stackport-fixture-admin', authSource='admin') as client:
    client.private.data.insert_one({'private': True})
    records = client.visible.records
    records.insert_many({
        '_id': ObjectId(f'{rank + 1:024x}'),
        'rank': rank,
        'title': f'문서 {rank}',
        'exact': Int64(9223372036854775807),
        'decimal': Decimal128('123.4500'),
        'payload': Binary(b'\x00\xff'),
        **({'large': 'x' * 70_000} if rank == 22 else {}),
    } for rank in range(23))
    records.create_index([('rank', -1)], name='rank_desc')
    records.create_index('expires', name='expiry', expireAfterSeconds=600)
    client.visible.command('create', 'recent_records', viewOn='records',
                           pipeline=[{'$match': {'rank': {'$gte': 20}}}])
    client.admin.command('createUser', 'catalog_reader', pwd='stackport-mongo-catalog-test',
                         roles=[{'role': 'read', 'db': 'visible'}])
