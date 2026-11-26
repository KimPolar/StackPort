import sys
import re
from datetime import datetime, timezone
from time import monotonic, sleep
from uuid import uuid4

from bson import Binary, Decimal128, Int64, ObjectId
from pymongo import MongoClient
from pymongo.errors import OperationFailure


port, ca_path, *action = sys.argv[1:]
options = {
    'port': int(port),
    'tls': True,
    'tlsCAFile': ca_path,
    'serverSelectionTimeoutMS': 2000,
    'directConnection': True,
}

if not action or action == ['initialize_replica']:
    with MongoClient('localhost', **options) as first_user:
        if action:
            first_user.admin.command('replSetInitiate', {
                '_id': 'stackport_fixture', 'members': [{'_id': 0, 'host': f'localhost:{port}'}],
            })
            deadline = monotonic() + 15
            while not first_user.admin.command('hello').get('isWritablePrimary'):
                assert monotonic() < deadline, 'The fixture did not elect a primary'
                sleep(0.1)
            action = []
        first_user.admin.command('createUser', 'stackport_fixture_admin',
                                 pwd='stackport-fixture-admin', roles=['root'])

with MongoClient('localhost', **options, username='stackport_fixture_admin',
                 password='stackport-fixture-admin', authSource='admin') as client:
    if action == ['recreate_edit_collection']:
        client.visible.drop_collection('edit_generation')
        client.visible.edit_generation.insert_one({'_id': 'seed', 'keep': True})
        sys.exit(0)
    if action == ['recreate_import_collection']:
        client.visible.drop_collection('transfer_replaced')
        client.visible.transfer_replaced.insert_one({'_id': 'replacement'})
        sys.exit(0)
    if action == ['occupy_restore_destination']:
        client.visible.archive_race.insert_one({'_id': 'other-client', 'keep': True})
        sys.exit(0)
    if len(action) == 2 and action[0] == 'occupy_restore_database':
        assert re.fullmatch('restore_race_[0-9a-f]{32}', action[1])
        client[action[1]].readings.insert_one({'_id': 'other-client', 'keep': True})
        sys.exit(0)
    if action == ['recreate_validation_collection']:
        client.namespace_new.drop_collection('validated_items')
        client.namespace_new.create_collection('validated_items')
        sys.exit(0)
    if action == ['create_view_source']:
        client.namespace_new.create_collection('temporary_view_source')
        sys.exit(0)
    if action == ['drop_view_source']:
        client.namespace_new.drop_collection('temporary_view_source')
        sys.exit(0)
    if action == ['create_drop_target']:
        db = client.namespace_new
        db.drop_target.insert_many([{'_id': 'first', 'qty': 1}, {'_id': 'second', 'qty': 2}])
        db.drop_target.create_index('qty', name='qty_idx')
        db.drop_origin.insert_one({'_id': 'keep'})
        db.create_collection('on_drop_direct', viewOn='drop_target', pipeline=[])
        db.create_collection('on_drop_indirect', viewOn='on_drop_direct', pipeline=[])
        db.create_collection('on_drop_lookup', viewOn='drop_origin', pipeline=[
            {'$facet': {'join': [{'$lookup': {'from': 'drop_target', 'pipeline': [], 'as': 'joined'}}]}},
        ])
        try:
            db.command('drop', 'drop_target', collectionUUID=Binary.from_uuid(uuid4()))
            raise AssertionError('MongoDB accepted a drop with the wrong collection UUID')
        except OperationFailure as error:
            assert error.code == 361, error
        sys.exit(0)
    if action == ['add_drop_dependency']:
        client.namespace_new.create_collection('on_drop_new', viewOn='drop_target', pipeline=[])
        sys.exit(0)
    if action == ['recreate_drop_target']:
        client.namespace_new.drop_collection('drop_target')
        client.namespace_new.drop_target.insert_one({'_id': 'replacement'})
        sys.exit(0)
    if action == ['create_rename_source']:
        db = client.namespace_new
        db.rename_source.insert_one({'_id': 'original', 'qty': 2})
        db.rename_source.create_index('qty', name='qty_idx')
        db.rename_taken.insert_one({'_id': 'keep-target'})
        db.create_collection('uses_rename_source', viewOn='rename_source', pipeline=[])
        db.create_collection('uses_rename_destination', viewOn='rename_destination', pipeline=[])
        try:
            client.admin.command('renameCollection', 'namespace_new.rename_source',
                                 to='namespace_new.rename_destination',
                                 dropTarget=False, collectionUUID=Binary.from_uuid(uuid4()))
            raise AssertionError('MongoDB accepted a rename with the wrong collection UUID')
        except OperationFailure as error:
            assert error.code == 361, error
        sys.exit(0)
    if action == ['occupy_rename_destination']:
        client.namespace_new.rename_destination.insert_one({'_id': 'late-target'})
        sys.exit(0)
    if action == ['clear_rename_destination']:
        client.namespace_new.drop_collection('rename_destination')
        sys.exit(0)
    if action == ['add_rename_dependency']:
        client.namespace_new.create_collection('uses_rename_destination_late',
                                              viewOn='rename_destination', pipeline=[])
        sys.exit(0)
    if action == ['recreate_rename_source']:
        db = client.namespace_new
        db.drop_collection('rename_source')
        db.rename_source.insert_one({'_id': 'replacement', 'qty': 3})
        db.rename_source.create_index('qty', name='qty_idx')
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
    client.visible.export_special.insert_one({
        '_id': 'csv', 'formula': '=1+1', 'array': [{'n': Int64(-9007199254740993)}],
        'meta': {'label': '쉼표, "인용"\n다음 줄'},
    })
    client.visible.export_ambiguous.insert_one({'_id': 'ambiguous', 'value': {'$numberLong': '3'}})
    client.visible.export_batches.insert_many({'_id': index} for index in range(130))
    client.visible.transfer_target.insert_one({'_id': 'taken', 'marker': 'original'})
    client.visible.create_collection('transfer_replaced')
    client.visible.create_collection('transfer_csv')
    client.visible.create_collection('transfer_validated', validator={'qty': {'$gte': 0}},
                                     validationAction='error', validationLevel='strict')
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
                         roles=[{'role': 'readWrite', 'db': 'visible'}, {'role': 'dbAdmin', 'db': 'visible'},
                                {'role': 'readWrite', 'db': 'namespace_new'}, {'role': 'dbAdmin', 'db': 'namespace_new'}])
    source = client.archive_data
    source.readings.insert_many([{'_id': 1, 'reading': Int64(9223372036854775807)}, {'_id': 2, 'reading': Int64(8)}])
    source.readings.create_index('reading', name='reading_idx')
    source.create_collection('empty')
    source.create_collection('selected_readings', viewOn='readings', pipeline=[{'$match': {'_id': 1}}])
    source.create_collection('selected_projection', viewOn='selected_readings', pipeline=[{'$project': {'reading': 1}}])
    source.create_collection('telemetry', timeseries={'timeField': 'instant', 'metaField': 'station'})
    source.create_collection('empty_telemetry', timeseries={'timeField': 'instant', 'metaField': 'station'})
    source.telemetry.insert_many([
        {'_id': number, 'instant': datetime(2026, 1, 1, number, tzinfo=timezone.utc), 'station': station}
        for number, station in enumerate(['Seoul', 'Busan', 'Seoul'])
    ])
    client.admin.command('createUser', 'archive_restorer', pwd='stackport-mongo-archive-test',
                         roles=['restore', 'readWriteAnyDatabase', 'dbAdminAnyDatabase'])
