import sys

from bson import Binary, Decimal128, Int64, ObjectId
from pymongo import MongoClient


port, ca_path, *action = sys.argv[1:]
options = {
    'port': int(port),
    'tls': True,
    'tlsCAFile': ca_path,
    'serverSelectionTimeoutMS': 2000,
    'directConnection': True,
}

if not action:
    with MongoClient('localhost', **options) as first_user:
        first_user.admin.command('createUser', 'stackport_fixture_admin',
                                 pwd='stackport-fixture-admin', roles=['root'])

with MongoClient('localhost', **options, username='stackport_fixture_admin',
                 password='stackport-fixture-admin', authSource='admin') as client:
    if action == ['recreate_edit_collection']:
        client.visible.drop_collection('edit_generation')
        client.visible.edit_generation.insert_one({'_id': 'seed', 'keep': True})
        sys.exit(0)
    if action:
        raise ValueError('Unexpected fixture action')
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
    client.visible.schema_samples.insert_many([
        {'name.with.dot': True, 'optional': None, 'events': [{'value': 1}, {'value': 2}, {'value': 'mixed-value'}]},
        {'name': {'with': {'dot': 'nested-value'}}, 'optional': Int64(7), 'events': [{'value': 'text'}]},
        {'events': []},
        {'oversized': 'x' * 70_000},
    ])
    client.admin.command('createUser', 'catalog_reader', pwd='stackport-mongo-catalog-test',
                         roles=[{'role': 'read', 'db': 'visible'}])
    client.visible.create_collection('edit_records', collation={'locale': 'en', 'strength': 2})
    client.visible.edit_records.insert_one({
        '_id': {'zone': 'west', 'number': Int64(7)},
        'title': 'Case', 'z': {'values': [{'precision': Int64(5)}, 'keep'], 'a.b': 'literal'},
        'exact': Int64(9223372036854775807),
    })
    client.visible.edit_generation.insert_one({'_id': 'seed', 'keep': True})
    client.admin.command('createUser', 'document_editor', pwd='stackport-mongo-edit-test',
                         roles=[{'role': 'readWrite', 'db': 'visible'}])
    client.admin.command('createUser', 'index_editor', pwd='stackport-mongo-index-test',
                         roles=[{'role': 'readWrite', 'db': 'visible'}, {'role': 'dbAdmin', 'db': 'visible'}])
