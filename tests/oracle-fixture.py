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
        cur.execute(f"CREATE TABLESPACE {tablespace} DATAFILE '{datafile}' SIZE 12M")
        cur.execute(f'CREATE USER {owner} IDENTIFIED BY "{owner_password}" DEFAULT TABLESPACE {tablespace} QUOTA UNLIMITED ON {tablespace}')
        cur.execute(f'GRANT CREATE SESSION, CREATE TABLE, CREATE VIEW, CREATE MATERIALIZED VIEW TO {owner}')
        cur.execute(f'CREATE USER {reader} IDENTIFIED BY "{reader_password}"')
        cur.execute(f'GRANT CREATE SESSION TO {reader}')

with oracledb.connect(user=owner, password=owner_password, params=dsn) as connection:
    with connection.cursor() as cur:
        cur.execute('CREATE TABLE hidden_data (id NUMBER)')
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
        for name in ('Order Daily', 'Recent View', 'Daily Summary'):
            cur.execute(f'GRANT SELECT ON "{name}" TO {reader}')
        cur.execute("SELECT object_id FROM user_objects WHERE object_name = 'HIDDEN_DATA' AND object_type = 'TABLE'")
        print(cur.fetchone()[0])
