"""Generate a conservative requirements inventory from the checked-in spec."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "StackPort_Functional_Spec_KO.md"
OUTPUT = ROOT / "docs" / "requirements.csv"

# Evidence covers only the stated subset, never the full requirement.
PARTIAL = {
    "SP-UI-001": "프로젝트 생성·이름 변경·삭제",
    "SP-UI-002": "프로젝트별 SQLite 테이블·뷰 탐색",
    "SP-UI-014": "읽기 전용·실행 중·오류 표시",
    "SP-UI-019": "연결별 SQL 초안을 실행 중 메모리에 유지",
    "SP-CN-001": "프로젝트별 로컬 SQLite 파일 연결 정의",
    "SP-CN-003": "SQLite 연결 정의 생성·삭제",
    "SP-DB-001": "SQLite 읽기 전용 어댑터",
    "SP-DB-007": "한 프로젝트에 여러 SQLite 연결 정의",
    "SP-DB-009": "SQLite 테이블·뷰 목록",
    "SP-DB-010": "SQLite 테이블·뷰와 열·기본 키·외래 키·인덱스 열람",
    "SP-DB-014": "SQLite 테이블·뷰의 생성 SQL 열람",
    "SP-DB-018": "SQLite 인덱스 구성과 고유·부분 여부 열람",
    "SP-DB-022": "SQLite 객체의 구조·데이터 조회",
    "SP-DB-028": "읽기 전용 연결과 쓰기 차단",
    "SP-DT-001": "100행 단위 결과 페이지",
    "SP-DT-006": "결과의 NULL 표시",
    "SP-SQ-001": "단일 SQL 입력 영역과 메모리 초안",
    "SP-SQ-007": "단일 읽기 전용 SQL 실행",
    "SP-BK-001": "SQLite 전체 데이터베이스 백업",
    "SP-BK-002": "SQLite 온라인 백업 API",
    "SP-BK-003": "복원 가능한 SQLite 바이너리 파일",
    "SP-BK-006": "SQLite WAL 포함 스냅샷과 무결성 검사",
    "SP-BK-014": "백업 무결성 검사와 복원 테스트 상태 구분",
    "SP-ST-006": "프로젝트와 연결 정의 저장",
    "SP-SEC-007": "Tauri 콘텐츠 보안 정책",
    "SP-SEC-008": "메타데이터의 SQL 바인딩과 SQLite 읽기 전용 검사",
    "SP-NFR-001": "SQLite 작업을 별도 스레드에서 실행",
    "SP-NFR-002": "한 번에 최대 100행 표시",
    "SP-AT-024": "SQLite 로컬 메타데이터 및 로컬 조회",
    "SP-AT-016": "SQLite 백업 파일의 데이터·객체 재조회와 무결성 검사",
}

items = {}
for line in SPEC.read_text(encoding="utf-8").splitlines():
    bullet = re.match(r"^- \*\*(SP-[A-Z]+-\d{3})\s+([^:]+):\*\*\s*(.*)", line)
    table = re.match(r"^\|\s*(SP-(?:NFR|AT)-\d{3})\s*\|\s*([^|]+)\|\s*([^|]+)\|", line)
    match = bullet or table
    if match:
        requirement_id, title, detail = (part.strip() for part in match.groups())
        if requirement_id in items:
            raise ValueError(f"중복 요구사항 ID: {requirement_id}")
        items[requirement_id] = (title, detail)

referenced = set(re.findall(r"SP-[A-Z]+-\d{3}", SPEC.read_text(encoding="utf-8")))
if not items or set(PARTIAL) - items.keys() or referenced != items.keys():
    raise ValueError(f"명세 ID 확인 실패. 누락: {sorted(referenced - items.keys())}")

with OUTPUT.open("w", encoding="utf-8-sig", newline="") as target:
    writer = csv.writer(target)
    writer.writerow(["id", "title", "requirement", "status", "implemented_subset", "evidence"])
    for requirement_id, (title, detail) in items.items():
        subset = PARTIAL.get(requirement_id, "")
        evidence = ""
        if subset:
            if requirement_id.startswith("SP-BK-") or requirement_id == "SP-AT-016":
                evidence = "crates/stackport-core/tests/backup.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-DB-010", "SP-DB-014", "SP-DB-018", "SP-DB-022"}:
                evidence = "crates/stackport-core/tests/schema.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            else:
                evidence = "crates/stackport-core/tests/workspace.rs; src/; src-tauri/"
        writer.writerow([requirement_id, title, detail, "partial" if subset else "not_started", subset, evidence])
print(f"{len(items)} requirements written to {OUTPUT}")
