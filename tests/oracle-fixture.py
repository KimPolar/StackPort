import os
import re
import sys

import oracledb


port, run, service = sys.argv[1:]
assert re.fullmatch(r'[A-F0-9]{12}', run)
port = int(port)
assert 1024 <= port <= 65535
dsn = oracledb.ConnectParams(host='127.0.0.1', port=port, service_name=service, tcp_connect_timeout=4)
owner = f'SP_OWNER_{run}'
reader = f'SP_READER_{run}'
owner_password = 'StackPortOwner84Za'
reader_password = 'StackPortReader84Za'
sid = os.environ.get('STACKPORT_ORACLE_TEST_SID')

if sid:
    sid_params = oracledb.ConnectParams(host='127.0.0.1', port=port, sid=sid, server_type='dedicated', tcp_connect_timeout=4)
    sid_reader = f'C##SP_SID_{run}'
    with oracledb.connect(user='sys', password=os.environ['STACKPORT_ORACLE_SYS_PASSWORD'],
                          params=sid_params, mode=oracledb.AUTH_MODE_SYSDBA) as root:
        with root.cursor() as cur:
            cur.execute(f'CREATE USER {sid_reader} IDENTIFIED BY "{reader_password}"')
            cur.execute(f'GRANT CREATE SESSION TO {sid_reader} CONTAINER=CURRENT')

with oracledb.connect(user='sys', password=os.environ['STACKPORT_ORACLE_SYS_PASSWORD'],
                      params=dsn, mode=oracledb.AUTH_MODE_SYSDBA) as admin:
    with admin.cursor() as cur:
        cur.execute("SELECT file_name FROM dba_data_files WHERE tablespace_name = 'SYSTEM' ORDER BY file_id FETCH FIRST 1 ROW ONLY")
        system_file = cur.fetchone()[0]
        separator = max(system_file.rfind('/'), system_file.rfind('\\'))
        assert separator > 0
        datafile = (system_file[:separator + 1] + f'spfixture_{run.lower()}.dbf').replace("'", "''")
        tablespace = f'SP_FIXTURE_{run}'
        cur.execute(f"CREATE TABLESPACE {tablespace} DATAFILE '{datafile}' SIZE 20M")
        cur.execute(f'CREATE USER {owner} IDENTIFIED BY "{owner_password}" DEFAULT TABLESPACE {tablespace} QUOTA UNLIMITED ON {tablespace}')
        cur.execute(f'GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE MATERIALIZED VIEW, CREATE PROCEDURE TO {owner}')
        cur.execute(f'GRANT EXECUTE ON SYS.DBMS_SESSION TO {owner}')
        cur.execute(f'CREATE USER {reader} IDENTIFIED BY "{reader_password}"')
        cur.execute(f'GRANT CREATE SESSION TO {reader}')
        cur.execute(f'GRANT EXECUTE ON SYS.DBMS_SESSION TO {reader}')
        cur.execute(f'CREATE VIEW {reader}."Order Daily" AS SELECT 1 "X%_Y", 2 "X%XY", 3 "한글 정의" FROM dual')
        cur.execute(f'CREATE VIEW {reader}.wildcard_decoy AS SELECT 1 "X%XY" FROM dual')

with oracledb.connect(user=owner, password=owner_password, params=dsn) as connection:
    with connection.cursor() as cur:
        cur.execute('CREATE TABLE hidden_data (id NUMBER, "X%_Y" NUMBER)')
        cur.execute('CREATE TABLE "Execution Fixture" (id NUMBER PRIMARY KEY)')
        cur.execute(f'GRANT SELECT, INSERT ON "Execution Fixture" TO {reader}')
        cur.execute('''
            CREATE TABLE "Order Daily" (
                tenant NUMBER(3,0) NOT NULL,
                id NUMBER(20,0) NOT NULL,
                exact_value NUMBER(30,6) NOT NULL,
                payload RAW(256),
                title VARCHAR2(2000 BYTE),
                logged_at TIMESTAMP(6),
                long_note CLOB,
                attachments BLOB,
                PRIMARY KEY (tenant, id)
            )
        ''')
        cur.execute(r'''
            INSERT INTO "Order Daily"
            SELECT 1, 9223372036854775808 - LEVEL, 123456789012345678901234.567891,
                CASE WHEN LEVEL = 61 THEN HEXTORAW('00FFA1') END,
                CASE WHEN LEVEL = 61 THEN REPLACE(RPAD('a', 255, 'a'), 'a', TO_CHAR(UNISTR('\D55C'))) ||
                    TO_CHAR(UNISTR('\D83D\DE80')) || 'next' ELSE 'row ' || TO_CHAR(LEVEL) END,
                TIMESTAMP '2026-09-18 04:12:33.123456',
                CASE WHEN LEVEL = 61 THEN TO_CLOB(RPAD('a', 700, 'a')) END,
                CASE WHEN LEVEL = 61 THEN TO_BLOB(HEXTORAW('00FF11')) END
            FROM dual CONNECT BY LEVEL <= 61
        ''')
        cur.execute('CREATE VIEW "Recent View" AS SELECT tenant, id FROM "Order Daily" WHERE id > 9223372036854775805')
        cur.execute('''
            CREATE MATERIALIZED VIEW "Daily Summary" BUILD IMMEDIATE REFRESH COMPLETE ON DEMAND AS
            SELECT tenant, COUNT(*) row_count FROM "Order Daily" GROUP BY tenant
        ''')
        extra_columns = ', '.join(f'extra_{i} NUMBER(4,0)' for i in range(1, 67))
        cur.execute(f'''
            CREATE TABLE "Export Fixture" (
                id NUMBER(4,0) PRIMARY KEY, note CLOB, amount NUMBER(38,6), bytes RAW(32),
                payload BLOB, recorded TIMESTAMP(9) WITH TIME ZONE, utc_at TIMESTAMP(9) WITH LOCAL TIME ZONE,
                elapsed INTERVAL DAY(2) TO SECOND(9), national NCLOB, {extra_columns}
            )
        ''')
        cur.execute('''
            INSERT INTO "Export Fixture" (id, note, amount, bytes, payload, recorded, utc_at, elapsed, national, extra_66)
            SELECT LEVEL, CASE LEVEL WHEN 1 THEN TO_CLOB('=SUM(1,2)') WHEN 2 THEN EMPTY_CLOB() END,
                -12345678901234567890123456789012.345678,
                CASE WHEN LEVEL = 1 THEN HEXTORAW('00FF11') END,
                CASE WHEN LEVEL = 2 THEN EMPTY_BLOB() END,
                TO_TIMESTAMP_TZ('2026-09-18T04:12:33.123456789 Asia/Seoul', 'YYYY-MM-DD"T"HH24:MI:SS.FF9 TZR'),
                TO_TIMESTAMP_TZ('2026-09-18T04:12:33.123456789 +09:00', 'YYYY-MM-DD"T"HH24:MI:SS.FF9 TZH:TZM'),
                INTERVAL '2 03:04:05.123456789' DAY TO SECOND(9),
                NULL, LEVEL * 2
            FROM dual CONNECT BY LEVEL <= 121
        ''')
        cur.setinputsizes(note=oracledb.DB_TYPE_CLOB, national=oracledb.DB_TYPE_NCLOB, payload=oracledb.DB_TYPE_BLOB)
        cur.execute('UPDATE "Export Fixture" SET note = :note, national = :national, payload = :payload WHERE id = 121',
                    note='a' * 21844 + '🚀' + '한' * 20000 + '\n끝', national='국' * 23000 + '🚀終',
                    payload=bytes(range(256)) * 280)
        cur.execute('''
            CREATE FUNCTION fixture_pause(n NUMBER) RETURN NUMBER AS
            BEGIN
                IF n = 113 THEN SYS.DBMS_SESSION.SLEEP(4); END IF;
                RETURN n;
            END;
        ''')
        cur.execute('CREATE VIEW "Late Export" AS SELECT id, fixture_pause(id) paused FROM "Export Fixture"')
        cur.execute('CREATE VIEW "Oversize Export" AS SELECT RPAD(TO_CLOB(\'a\'), 33554433, \'a\') large_note FROM dual')
        cur.execute('CREATE VIEW "Unsupported Export" AS SELECT BFILENAME(\'STACKPORT_UNCONFIGURED\', \'example\') file_ref FROM dual')
        names = ['Order Daily', 'Recent View', 'Daily Summary', 'Export Fixture', 'Late Export', 'Oversize Export', 'Unsupported Export']
        if int(connection.version.split('.')[0]) >= 23:
            cur.execute('''
                CREATE VIEW "Native Scalars" AS SELECT TRUE enabled, TO_BINARY_DOUBLE(1.25) ratio,
                    JSON('{"n":12345678901234567890123456789012345678,"s":"한글","a":[null,true]}') document,
                    JSON('null') json_null, CAST(NULL AS JSON) sql_null FROM dual
            ''')
            names.append('Native Scalars')
        for name in names:
            cur.execute(f'GRANT SELECT ON "{name}" TO {reader}')
        cur.execute("SELECT object_id FROM user_objects WHERE object_name = 'HIDDEN_DATA' AND object_type = 'TABLE'")
        print(cur.fetchone()[0])
