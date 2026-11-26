import os
import re
import sys

import oracledb


port, run, service, mode, *arguments = sys.argv[1:]
assert re.fullmatch(r'[A-F0-9]{12}', run)
port = int(port)
assert 1024 <= port <= 65535
owner = f'SP_PUMP_{run}'
limited = f'SP_READ_{run}'
targets = {kind: f'SP_{kind.upper()}_{run}' for kind in ('all', 'metadata', 'data')}
directory = f'SP_DUMP_{run}'
readonly = f'SP_DUMP_READ_{run}'
password = 'StackPortPump89Qa'
params = oracledb.ConnectParams(host='127.0.0.1', port=port, service_name=service, tcp_connect_timeout=4)
table = """CREATE TABLE proof (id NUMBER(38) PRIMARY KEY, raw_value RAW(3), title NVARCHAR2(5))"""


def connection(username):
    return oracledb.connect(user=username, password=password, params=params)


def setup():
    folder = os.environ['STACKPORT_ORACLE_PUMP_DIRECTORY_PATH']
    assert folder.startswith('/') or re.match(r'^[A-Za-z]:[\\/]', folder)
    folder = folder.replace("'", "''")
    with oracledb.connect(
        user='sys', password=os.environ['STACKPORT_ORACLE_SYS_PASSWORD'],
        params=params, mode=oracledb.AUTH_MODE_SYSDBA,
    ) as admin, admin.cursor() as cursor:
        cursor.execute("SELECT file_name FROM dba_data_files WHERE tablespace_name = 'SYSTEM' FETCH FIRST 1 ROW ONLY")
        system = cursor.fetchone()[0]
        separator = max(system.rfind('/'), system.rfind('\\'))
        assert separator > 0
        datafile = (system[:separator + 1] + f'pump_{run.lower()}.dbf').replace("'", "''")
        space = f'SP_PUMP_SPACE_{run}'
        cursor.execute(f"CREATE TABLESPACE {space} DATAFILE '{datafile}' SIZE 40M")
        for name in (owner, limited, *targets.values()):
            cursor.execute(f'CREATE USER {name} IDENTIFIED BY "{password}" DEFAULT TABLESPACE {space} QUOTA UNLIMITED ON {space}')
            cursor.execute(f'GRANT CREATE SESSION TO {name}')
            if name != limited:
                cursor.execute(f'GRANT CREATE TABLE, CREATE VIEW TO {name}')
        cursor.execute(f"CREATE DIRECTORY {directory} AS '{folder}'")
        cursor.execute(f"CREATE DIRECTORY {readonly} AS '{folder}'")
        cursor.execute(f'GRANT READ, WRITE ON DIRECTORY {directory} TO {owner}, {", ".join(targets.values())}')
        cursor.execute(f'GRANT READ ON DIRECTORY {readonly} TO {owner}, {limited}')

    with connection(owner) as db, db.cursor() as cursor:
        cursor.execute(table)
        cursor.execute(r"""INSERT INTO proof
            SELECT 12345678901234567890123456789012345678 - LEVEL + 1, HEXTORAW('00FF11'), UNISTR('\D55C')
            FROM dual CONNECT BY LEVEL <= 61""")
        cursor.execute("CREATE VIEW proof_view AS SELECT id FROM proof")
        db.commit()


def assert_filename(name):
    assert re.fullmatch(r'stackport-[a-f0-9]{32}\.dmp', name)


def protect(name, write):
    assert_filename(name)
    with connection(owner) as db, db.cursor() as cursor:
        if write:
            cursor.execute("""DECLARE f SYS.UTL_FILE.FILE_TYPE;
                BEGIN
                  f:=SYS.UTL_FILE.FOPEN(:dir_name,:file_name,'wb');
                  SYS.UTL_FILE.PUT_RAW(f,HEXTORAW('A100ECFF'),TRUE);
                  SYS.UTL_FILE.FCLOSE(f);
                END;""", dir_name=directory, file_name=name)
        else:
            marker = cursor.var(str, size=16)
            cursor.execute("""DECLARE f SYS.UTL_FILE.FILE_TYPE; value RAW(4);
                BEGIN
                  f:=SYS.UTL_FILE.FOPEN(:dir_name,:file_name,'rb');
                  SYS.UTL_FILE.GET_RAW(f,value,4);
                  SYS.UTL_FILE.FCLOSE(f);
                  :marker := RAWTOHEX(value);
                END;""", dir_name=directory, file_name=name, marker=marker)
            assert marker.getvalue() == 'A100ECFF'


def import_check(kind, name):
    assert_filename(name)
    target = targets[kind]
    with connection(target) as db, db.cursor() as cursor:
        db.call_timeout = 110_000
        if kind == 'data':
            cursor.execute(table)
        state = cursor.var(str, size=30)
        cursor.execute("""DECLARE h NUMBER; final_state VARCHAR2(30);
            BEGIN
              h:=SYS.DBMS_DATAPUMP.OPEN('IMPORT','SCHEMA',NULL,:job_name,'COMPATIBLE');
              SYS.DBMS_DATAPUMP.ADD_FILE(h,:file_name,:dir_name,filetype=>SYS.DBMS_DATAPUMP.KU$_FILE_TYPE_DUMP_FILE);
              SYS.DBMS_DATAPUMP.METADATA_FILTER(h,'SCHEMA_EXPR',:schema_filter);
              SYS.DBMS_DATAPUMP.METADATA_REMAP(h,'REMAP_SCHEMA',:origin,:target);
              IF :data_only = 1 THEN
                SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'INCLUDE_METADATA',0);
                SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'TABLE_EXISTS_ACTION','APPEND');
              ELSE
                SYS.DBMS_DATAPUMP.SET_PARAMETER(h,'TABLE_EXISTS_ACTION','SKIP');
              END IF;
              SYS.DBMS_DATAPUMP.START_JOB(h);
              SYS.DBMS_DATAPUMP.WAIT_FOR_JOB(h,final_state);
              :state := final_state;
            END;""", job_name=f'SP_IMP_{kind.upper()}_{run}', file_name=name, dir_name=directory,
                       schema_filter=f"IN ('{owner}')", origin=owner, target=target,
                       data_only=int(kind == 'data'), state=state)
        assert state.getvalue() == 'COMPLETED', state.getvalue()
        cursor.execute("SELECT COUNT(*) FROM proof")
        assert cursor.fetchone() == (0 if kind == 'metadata' else 61,)
        if kind != 'metadata':
            cursor.execute(r"""SELECT COUNT(*) FROM proof WHERE id=12345678901234567890123456789012345678
                AND raw_value=HEXTORAW('00FF11') AND title=UNISTR('\D55C')""")
            assert cursor.fetchone() == (1,)
        cursor.execute("SELECT COUNT(*) FROM user_views WHERE view_name='PROOF_VIEW'")
        assert cursor.fetchone() == (0 if kind == 'data' else 1,)


if mode == 'setup':
    setup()
elif mode == 'protect':
    protect(arguments[0], True)
elif mode == 'check-protected':
    protect(arguments[0], False)
elif mode == 'import':
    import_check(*arguments)
else:
    raise ValueError('Invalid Data Pump fixture operation')
