"""Seed an isolated Windows PostgreSQL fixture through its bundled libpq."""

import ctypes
import os
import sys
from pathlib import Path


def seed_fixture(bin_path: Path, seed_path: Path) -> None:
    with os.add_dll_directory(bin_path):
        pg = ctypes.CDLL(str(bin_path / "libpq.dll"))
        pg.PQconnectdb.argtypes = [ctypes.c_char_p]
        pg.PQconnectdb.restype = ctypes.c_void_p
        pg.PQstatus.argtypes = [ctypes.c_void_p]
        pg.PQexec.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
        pg.PQexec.restype = ctypes.c_void_p
        pg.PQresultStatus.argtypes = [ctypes.c_void_p]
        pg.PQerrorMessage.argtypes = [ctypes.c_void_p]
        pg.PQerrorMessage.restype = ctypes.c_char_p
        pg.PQclear.argtypes = [ctypes.c_void_p]
        pg.PQclear.restype = None
        pg.PQfinish.argtypes = [ctypes.c_void_p]
        pg.PQfinish.restype = None

        connection = pg.PQconnectdb(b"")
        if not connection:
            raise RuntimeError("Cannot allocate the PostgreSQL fixture connection")
        try:
            if pg.PQstatus(connection) != 0:
                raise RuntimeError(pg.PQerrorMessage(connection).decode("utf-8", errors="replace"))
            statements = (
                seed_path.read_bytes(),
                b"CREATE DATABASE fixture_latin ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0",
            )
            if os.environ.get("STACKPORT_POSTGRES_TOOLS_DIR"):
                statements += (b"CREATE DATABASE fixture_backup_restore TEMPLATE template0",)
            for sql in statements:
                result = pg.PQexec(connection, sql)
                try:
                    if not result or pg.PQresultStatus(result) != 1:
                        raise RuntimeError(pg.PQerrorMessage(connection).decode("utf-8", errors="replace"))
                finally:
                    if result:
                        pg.PQclear(result)
        finally:
            pg.PQfinish(connection)


if __name__ == "__main__":
    seed_fixture(Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve())
