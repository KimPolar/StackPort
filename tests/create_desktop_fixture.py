"""Create a new SQLite fixture for the opt-in desktop smoke test."""
import sqlite3
import sys
from pathlib import Path

if len(sys.argv) != 2:
    raise SystemExit("Usage: python tests/create_desktop_fixture.py <new-file.sqlite>")

path = Path(sys.argv[1]).resolve()
path.parent.mkdir(parents=True, exist_ok=True)
if path.exists():
    raise SystemExit(f"Refusing to replace an existing file: {path}")
with sqlite3.connect(path) as db:
    db.execute("CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT, note TEXT)")
    db.executemany(
        "INSERT INTO people VALUES (?, ?, ?)",
        ((i, f"사용자 {i}", None if i % 2 else "테스트") for i in range(1, 206)),
    )
print(path)
