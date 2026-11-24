"""Generate a conservative requirements inventory from the checked-in spec."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "StackPort_Functional_Spec_KO.md"
OUTPUT = ROOT / "docs" / "requirements.csv"

# Evidence covers only the stated subset, never the full requirement.
PARTIAL = {
    "SP-UI-001": "프로젝트 생성·이름 변경·복제·보관·재활성화·삭제와 연결 정의 복제",
    "SP-UI-002": "도구를 전환해도 유지되는 프로젝트 탐색기에서 SQLite 테이블·뷰와 SSH 연결 탐색",
    "SP-UI-003": "여러 Windows 터미널 탭 열기·전환·닫기, 도구 전환 후 열린 터미널·RDP 세션 표시",
    "SP-UI-004": "두 도구의 좌우·상하 분할, 2×2 프리셋과 최대 네 영역의 개별 분할·크기 조절, 작업 상태를 유지하는 도구 교체·이동",
    "SP-UI-006": "명령 팔레트에서 도구·프로젝트·현재 프로젝트 연결·선택한 SQLite 연결의 테이블과 뷰 검색",
    "SP-UI-007": "Ctrl+Shift+P 명령 팔레트, 작업 도구·프로젝트·저장 연결·SQLite 객체 열기와 메모리 내 최근 명령 우선 표시",
    "SP-UI-008": "Windows SSH 호스트·포트·사용자 빠른 연결",
    "SP-UI-011": "프로젝트·SQLite 작업, SFTP 전송·복사·폴더 생성·이름 변경·이동·삭제, SSH 연결 정의와 호스트 키 신뢰·교체의 로컬 기록",
    "SP-UI-012": "재시작 후 마지막 프로젝트·SQLite 연결·도구 배치·분할 크기·탐색기 상태 복원, 저장된 SSH 정의 다시 표시",
    "SP-UI-014": "읽기 전용·실행 중·중단·시간 초과·오류 표시",
    "SP-UI-019": "연결별 SQL 초안을 실행 중 메모리에 유지",
    "SP-UI-016": "작업 도구와 터미널 탭의 키보드 이동, 명령 팔레트 검색, 분할 창 크기 조절, Ctrl+Shift+F 터미널 출력 검색",
    "SP-CN-001": "프로젝트별 SQLite 파일과 SSH 호스트·포트·사용자·이름·환경 저장",
    "SP-CN-002": "SSH 연결의 DNS·TCP 단계 진단과 호스트 키 사전 조회; 인증·권한 검사는 미제공",
    "SP-CN-003": "SQLite 연결 정의 생성·삭제, SSH 연결 정의 생성·수정·삭제와 세션 열기·닫기",
    "SP-CN-005": "선택한 SSH 연결을 자격 증명 없이 버전형 JSON으로 내보내고 미리보기 후 가져오기",
    "SP-CN-007": "SSH 터미널의 일회성 암호 입력",
    "SP-CN-008": "Windows SSH 세션에서 키 파일 1~8개 선택과 암호화된 키의 터미널 암호 입력",
    "SP-CN-009": "Windows SSH 서버 대화형 인증과 다중 질문·서버 안내·응답 표시 정책",
    "SP-CN-010": "SSH 호스트 키 지문 확인·고정·변경 차단과 명시적 교체",
    "SP-CN-014": "SSH 연결 JSON에 암호·개인 키·호스트 키 신뢰 정보 제외",
    "SP-CN-023": "저장된 SSH 연결의 DEV/STAGING/PROD 구분·표시와 PROD 연결 전 확인",
    "SP-CN-024": "SSH 암호·대화형 인증 시도 제한과 지정 방식의 대체 인증 차단",
    "SP-TM-001": "Windows PowerShell·CMD 로컬 터미널과 셸별 바로 열기",
    "SP-TM-002": "Windows OpenSSH의 대화형 원격 셸 입출력",
    "SP-TM-003": "Windows ConPTY와 xterm.js 기반 입력·출력·크기 조절",
    "SP-TM-005": "터미널 메모리 스크롤백, 탭별 일반 문자열 검색과 TXT·ANSI 출력 내보내기",
    "SP-TM-006": "터미널 키보드 입력과 선택·붙여넣기",
    "SP-TM-007": "여러 줄 붙여넣기 전 확인",
    "SP-TM-016": "비활성 터미널에 새 출력이 있으면 탭에 표시하고 확인 시 지움",
    "SP-TM-017": "로컬 터미널·앱 종료 시 실행 작업 확인",
    "SP-NW-001": "Windows 로컬 IPv4·IPv6 TCP 연결·UDP 바인딩과 주소·PID·프로세스명 조회, 도구 전환 후 포트 필터 유지",
    "SP-NW-002": "네트워크·SSH 연결 화면의 DNS·TCP 진단과 Windows Ping·경로 추적, 도구 전환 후 진단 상태 유지",
    "SP-NW-003": "Windows HTTP/HTTPS HEAD·GET, 최대 5회 가용성 측정, 상태 코드·헤더·경과 시간·TLS 정보",
    "SP-FL-001": "현재 프로젝트의 저장된 SSH 연결과 동일한 호스트 키 저장소로 SFTP 탐색 시작",
    "SP-FL-002": "로컬·SFTP 이중 패널의 파일 목록, 경로·하위/상위 폴더 이동과 새로고침, 좁은 창에서 경로를 유지하는 패널 전환",
    "SP-FL-003": "SFTP 원격 폴더 생성, 일반 파일·폴더 이름 변경·이동, 일반 파일 복사와 단일 파일·빈 폴더 삭제",
    "SP-FL-004": "확인한 호스트 키로 SFTP v3 연결, 암호와 암호화된 개인 키 인증",
    "SP-FL-006": "SFTP의 단일 파일 업·다운로드, 진행 바이트·평균 속도·예상 잔여 시간 표시와 중단",
    "SP-FL-007": "SFTP 전송 실패·중단 시 임시 파일 정리, 완료 파일 게시와 수동 재시도",
    "SP-FL-008": "전송·복사·원격 이름 변경·이동에서 기존 대상 보존, 파일 크기·수정 시간 변경 감지",
    "SP-FL-009": "로컬·SFTP 항목의 유형·크기·수정 시간과 숨김 표시, SFTP의 권한·소유자/그룹 ID",
    "SP-FL-011": "로컬·SFTP 파일의 UTF-8 원문(HTML·XML·JSON·CSV 포함), HEX 및 제한된 정적 PNG 미리보기",
    "SP-FL-012": "최대 512 KiB SFTP UTF-8 편집기, BOM·LF/CRLF 유지, Ctrl+S와 저장하지 않은 변경 확인",
    "SP-FL-013": "SFTP 텍스트 열기·편집, 검증한 원격 임시 파일에서 저장, 원본 해시 충돌 확인과 새 이름 저장",
    "SP-FL-019": "SFTP 빈 폴더를 확인해 한 폴더씩 삭제하며 숨김 파일을 포함한 하위 항목을 보존",
    "SP-FL-021": "SFTP 업로드·원격 복사·편집본의 원격 SHA-256 검증, 다운로드의 수신 SHA-256과 원격 크기·수정 시간 검증",
    "SP-FL-023": "SFTP 전송·복사·편집·원격 폴더 생성·이름 변경·이동·삭제의 시작과 결과를 시각 및 연결 ID와 함께 로컬에 기록",
    "SP-FL-024": "SFTP 경로의 누락과 접근 거부, 새 폴더·파일 이름 충돌 및 전송 오류 표시",
    "SP-RG-001": "Windows 네이티브 RDP 실행, 열린 클라이언트 목록, 창·전체 화면·다중 모니터, 펼칠 수 있는 해상도·색 깊이 설정",
    "SP-RG-002": "사용자·도메인 및 관리 콘솔, Windows CredSSP 사용과 서버 인증 실패 시 연결 거부 설정",
    "SP-RG-003": "RDP의 클립보드·선택 드라이브·프린터·스마트카드 공유와 Windows 단축키 적용 설정",
    "SP-RG-004": "RDP 창 크기에 맞춘 해상도 조정·자동 재연결 및 클라이언트 연결 끊기 옵션",
    "SP-RG-018": "Windows RDP 클라이언트 설치 여부와 브라우저·비지원 OS의 사용 제한 표시",
    "SP-DB-001": "SQLite 읽기 전용 어댑터",
    "SP-DB-007": "한 프로젝트에 여러 SQLite 연결 정의",
    "SP-DB-009": "SQLite 테이블·뷰 목록",
    "SP-DB-010": "SQLite 테이블·뷰와 열·기본 키·외래 키·인덱스 열람",
    "SP-DB-014": "SQLite 테이블·뷰의 생성 SQL 열람",
    "SP-DB-018": "SQLite 인덱스 구성과 고유·부분 여부 열람",
    "SP-DB-022": "SQLite 객체의 구조·데이터 조회와 전체 결과 CSV·JSON 내보내기",
    "SP-DB-028": "읽기 전용 연결과 쓰기 차단",
    "SP-DT-001": "100행 단위 결과 페이지",
    "SP-DT-003": "기본 키로 식별한 SQLite 단일 셀 수정",
    "SP-DT-004": "단일 셀 이전·변경 값 미리보기와 취소",
    "SP-DT-005": "SQLite 기본 키 검증과 키 없는 테이블 편집 차단",
    "SP-DT-006": "NULL·빈 문자열·숫자 구분 및 단일 셀 입력",
    "SP-DT-007": "SQLite 문자열·정수·실수·NULL 셀 편집",
    "SP-DT-010": "SQLite 테이블·뷰의 비교·범위·포함·NULL 필터, AND/OR, 매개변수 SQL 표시",
    "SP-DT-011": "SQLite 전체 결과를 대상으로 다중 열·방향·NULL 순서 정렬 및 초기화",
    "SP-DT-018": "SQLite 단일 셀의 기본 형식별 입력",
    "SP-DT-020": "단일 셀 변경의 시작·성공·실패 감사 기록",
    "SP-DT-021": "SQLite 행 전체 지문을 이용한 동시 수정 감지",
    "SP-DT-022": "SQLite 단일 셀 트랜잭션·롤백과 저장 값 검증",
    "SP-DT-024": "SQLite 제약·형식·충돌 실패 시 롤백과 오류 표시",
    "SP-SQ-001": "접을 수 있는 단일 SQL 편집기와 SQLite 객체 탐색 중 유지되는 연결별 메모리 초안",
    "SP-SQ-007": "단일 읽기 전용 SQL 실행",
    "SP-SQ-009": "SQLite 조회 중단과 시간 초과, 완료 여부 표시",
    "SP-SQ-010": "SQLite 매개변수 슬롯 감지와 형식 지정·값 바인딩, 입력 숨기기",
    "SP-SQ-014": "SQLite EXPLAIN QUERY PLAN 텍스트와 단계 트리",
    "SP-SQ-015": "SQLite 실행 계획에서 스캔·조건 검색·임시 B-Tree 구분",
    "SP-MG-002": "SQLite 테이블과 SQL 전체 결과를 UTF-8 CSV·버전형 JSON으로 내보내기",
    "SP-MG-005": "CSV에서 숫자·문자열·NULL·BLOB 구분, JSON에서 SQLite 저장 타입 보존",
    "SP-MG-008": "SQLite CSV·JSON 행 스트리밍·진행 행 수 표시·중단 및 시간 제한",
    "SP-MG-028": "SQLite CSV·JSON 내보내기의 행 수·파일 크기·CSV 보호 필드 수 보고와 작업 기록",
    "SP-BK-001": "SQLite 전체 데이터베이스 백업",
    "SP-BK-002": "SQLite 온라인 백업 API",
    "SP-BK-003": "복원 가능한 SQLite 바이너리 파일",
    "SP-BK-006": "SQLite WAL 포함 스냅샷과 무결성 검사",
    "SP-BK-013": "독립된 SQLite 백업의 새 복원 경로·버전·객체/행 수·SHA-256 미리보기",
    "SP-BK-014": "SQLite 백업 검사와 별도 복원본을 열어 무결성·객체/행 수·SHA-256 검증",
    "SP-ST-006": "프로젝트와 연결 정의, 작업 공간 배치 저장 및 손상된 배치의 이전 스냅샷 복원",
    "SP-ST-017": "SQLite 트랜잭션과 버전 비교로 여러 창의 작업 공간 배치 저장 충돌 감지",
    "SP-ST-011": "Windows 휴대형·표준·지정 데이터 경로 및 새 폴더로 검증 복사",
    "SP-ST-014": "Windows 작업 공간과 선택한 SSH 신뢰 파일을 검증하여 새 폴더에 백업",
    "SP-SEC-007": "Tauri 콘텐츠 보안 정책",
    "SP-SEC-008": "메타데이터·셀 변경 값 바인딩, 일반 SQL 읽기 전용 검사와 SSH 인자 분리·대상 검증",
    "SP-SEC-003": "SFTP 원격 삭제 시 연결·경로·영향과 PROD 확인, SQLite 운영 환경 셀 변경의 미리보기와 확인",
    "SP-SEC-004": "SSH 호스트 키 지문 확인·변경 차단과 이력, 웹 TLS 인증서 검증, RDP 서버 인증 실패 시 연결 거부 설정",
    "SP-SEC-009": "작업 기록에서 SQL·행 데이터·경로·자격 증명 제외",
    "SP-SEC-011": "로컬 변경·백업·복원·CSV 및 JSON 내보내기·셀 편집, SFTP 전송·복사·폴더 생성·이름 변경·이동·삭제, SSH 연결 정의와 키 신뢰·교체 이력 기록",
    "SP-SEC-015": "SQLite PROD 단일 셀 변경, SFTP PROD 삭제·편집본 원래 경로 저장 시 추가 확인",
    "SP-NFR-001": "SQLite 작업을 별도 스레드에서 실행",
    "SP-NFR-002": "한 번에 최대 100행 표시",
    "SP-NFR-006": "v1~v4 작업 공간을 백업한 뒤 트랜잭션으로 v5 이관, 손상된 배치의 이전 스냅샷 복원",
    "SP-AT-025": "v1~v4 백업 후 v5 이관·이관 실패 시 원본 보존",
    "SP-AT-024": "SQLite 로컬 메타데이터 및 로컬 조회",
    "SP-AT-016": "실제 SQLite 백업을 별도 파일로 복원해 행 수·객체·무결성·SHA-256 검증",
    "SP-AT-010": "SQLite 기본 키 기반 단일 셀 미리보기·적용·롤백·행 충돌 검사",
    "SP-AT-011": "SQLite 바인딩 쿼리와 실행 계획, 페이지 이동·취소·시간 초과 확인",
    "SP-AT-007": "Windows 로컬 CMD·PowerShell 입출력과 종료 정리",
    "SP-AT-001": "SSH 동일 알고리즘 키 변경 차단·명시적 재확인·교체 후 이전 키 차단",
    "SP-AT-002": "확인된 SSH 기반 SFTP 연결에서 UTF-8 원격 파일 편집·저장·재조회",
    "SP-AT-003": "SFTP 원본 변경 시 해시 충돌 감지, 편집 내용 유지와 새 이름 저장 선택",
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
            if requirement_id in {"SP-BK-013", "SP-BK-014", "SP-AT-016"}:
                evidence = "crates/stackport-core/tests/restore.rs; tests/desktop-smoke.cjs; src/SqliteRestoreDialog.tsx; src-tauri/"
            elif requirement_id.startswith("SP-BK-"):
                evidence = "crates/stackport-core/tests/backup.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-DB-010", "SP-DB-014", "SP-DB-018"}:
                evidence = "crates/stackport-core/tests/schema.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id == "SP-DB-022" or requirement_id.startswith("SP-MG-"):
                evidence = "crates/stackport-core/tests/schema.rs; crates/stackport-core/tests/result_export.rs; tests/desktop-smoke.cjs; src/ResultExportDialog.tsx; src-tauri/"
            elif requirement_id in {"SP-UI-011", "SP-SEC-011", "SP-FL-023"}:
                evidence = "crates/stackport-core/tests/audit.rs; crates/stackport-core/src/sftp/audit.rs; tests/sftp-smoke.cjs; tests/ssh-smoke.cjs; src/main.tsx"
            elif requirement_id == "SP-SEC-009":
                evidence = "crates/stackport-core/tests/audit.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id == "SP-AT-025":
                evidence = "crates/stackport-core/tests/migration.rs"
            elif requirement_id == "SP-NFR-006":
                evidence = "crates/stackport-core/tests/migration.rs; crates/stackport-core/tests/workspace_resume.rs"
            elif requirement_id in {"SP-ST-011", "SP-ST-014"}:
                evidence = "src-tauri/src/data_location.rs; tests/portable-smoke.cjs; crates/stackport-core/tests/workspace_copy.rs; tests/desktop-smoke.cjs"
            elif requirement_id in {"SP-UI-001", "SP-UI-002", "SP-CN-001", "SP-CN-003", "SP-CN-023"}:
                evidence = "crates/stackport-core/tests/ssh_profiles.rs; crates/stackport-core/tests/workspace.rs; tests/ssh-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-UI-012", "SP-ST-006", "SP-ST-017"}:
                evidence = "crates/stackport-core/src/workspace_resume.rs; crates/stackport-core/tests/workspace_resume.rs; tests/workspace-resume-smoke.cjs; src/WorkspaceResume.ts; src/main.tsx"
            elif requirement_id in {"SP-UI-006", "SP-UI-007", "SP-UI-016"}:
                evidence = "src/CommandPalette.tsx; src/WorkspaceNavigation.tsx; src/WorkspaceSplit.tsx; src/TerminalWorkspace.tsx; src/main.tsx; tests/desktop-smoke.cjs; tests/terminal-smoke.cjs"
            elif requirement_id == "SP-UI-004":
                evidence = "src/WorkspaceLayout.ts; src/WorkspaceSplit.tsx; src/main.tsx; tests/desktop-smoke.cjs; tests/terminal-smoke.cjs"
            elif requirement_id == "SP-UI-003":
                evidence = "src/WorkspaceNavigation.tsx; src/TerminalWorkspace.tsx; tests/desktop-smoke.cjs; tests/terminal-smoke.cjs; tests/rdp-smoke.cjs"
            elif requirement_id in {"SP-CN-005", "SP-CN-014"}:
                evidence = "crates/stackport-core/tests/ssh_exchange.rs; tests/ssh-profile-exchange-smoke.cjs; src/SshProfileExchange.tsx; src-tauri/"
            elif requirement_id == "SP-NW-001":
                evidence = "crates/stackport-core/tests/ports.rs; tests/ports-smoke.cjs; src/NetworkWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-NW-002":
                evidence = "crates/stackport-core/tests/network.rs; tests/ports-smoke.cjs; src/NetworkDiagnosticsPanel.tsx; src-tauri/"
            elif requirement_id == "SP-NW-003":
                evidence = "crates/stackport-core/tests/web_check.rs; tests/ports-smoke.cjs; src/WebDiagnosticResult.tsx; src-tauri/"
            elif requirement_id in {"SP-FL-006", "SP-FL-007", "SP-FL-021"}:
                evidence = "crates/stackport-core/src/sftp/download.rs; crates/stackport-core/src/sftp/upload.rs; crates/stackport-core/src/sftp/remote_stage.rs; crates/stackport-core/src/sftp/copy.rs; tests/sftp-smoke.cjs; src/SftpTransferStatus.tsx; src-tauri/"
            elif requirement_id == "SP-FL-011":
                evidence = "crates/stackport-core/src/sftp/preview.rs; tests/sftp-smoke.cjs; src/FilePreviewDialog.tsx; src-tauri/"
            elif requirement_id in {"SP-FL-012", "SP-FL-013", "SP-AT-002", "SP-AT-003"}:
                evidence = "crates/stackport-core/src/sftp/editor.rs; crates/stackport-core/src/sftp/remote_stage.rs; tests/sftp-smoke.cjs; src/SftpEditorDialog.tsx"
            elif requirement_id in {"SP-FL-003", "SP-FL-024"}:
                evidence = "crates/stackport-core/src/sftp/mutation.rs; crates/stackport-core/src/sftp/copy.rs; crates/stackport-core/src/sftp/delete.rs; tests/sftp-smoke.cjs; src/SftpWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-FL-019":
                evidence = "crates/stackport-core/src/sftp/delete.rs; tests/sftp-smoke.cjs; src/SftpDeleteDialog.tsx"
            elif requirement_id == "SP-FL-008":
                evidence = "crates/stackport-core/src/sftp/mutation.rs; crates/stackport-core/src/sftp/download.rs; crates/stackport-core/src/sftp/remote_stage.rs; tests/sftp-smoke.cjs"
            elif requirement_id.startswith("SP-FL-"):
                evidence = "crates/stackport-core/src/sftp.rs; tests/sftp-smoke.cjs; src/SftpWorkspace.tsx; src-tauri/"
            elif requirement_id in {"SP-RG-001", "SP-RG-002", "SP-RG-003", "SP-RG-004", "SP-RG-018"}:
                evidence = "crates/stackport-core/src/rdp.rs; tests/rdp-smoke.cjs; src/RdpWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-CN-002":
                evidence = "crates/stackport-core/tests/network.rs; crates/stackport-core/src/network.rs; tests/ssh-smoke.cjs; src/TerminalWorkspace.tsx; src-tauri/"
            elif requirement_id in {"SP-UI-014", "SP-SQ-009"}:
                evidence = "crates/stackport-core/tests/query_cancel.rs; crates/stackport-core/src/query.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-SQ-010", "SP-SQ-014", "SP-SQ-015", "SP-AT-011"}:
                evidence = "crates/stackport-core/tests/query_parameters.rs; crates/stackport-core/tests/query_cancel.rs; tests/desktop-smoke.cjs; src/SqlParameterFields.tsx; src/SqliteQueryPlan.tsx; src-tauri/"
            elif requirement_id == "SP-CN-008":
                evidence = "crates/stackport-core/src/ssh.rs; tests/ssh-key-smoke.cjs; src/TerminalWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-SEC-004":
                evidence = "crates/stackport-core/src/ssh.rs; crates/stackport-core/src/web_check/windows.rs; crates/stackport-core/src/rdp.rs; tests/ssh-smoke.cjs; tests/ports-smoke.cjs; tests/rdp-smoke.cjs"
            elif requirement_id in {"SP-UI-008", "SP-CN-007", "SP-CN-009", "SP-CN-010", "SP-CN-024", "SP-TM-002", "SP-SEC-008", "SP-AT-001"}:
                evidence = "crates/stackport-core/src/ssh.rs; tests/ssh-smoke.cjs; src/TerminalWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-TM-005":
                evidence = "crates/stackport-core/tests/terminal_output.rs; tests/terminal-smoke.cjs; src/TerminalOutputDialog.tsx; src/TerminalWorkspace.tsx"
            elif requirement_id.startswith("SP-TM-") or requirement_id in {"SP-UI-003", "SP-UI-016", "SP-AT-007"}:
                evidence = "crates/stackport-core/tests/terminal.rs; tests/terminal-smoke.cjs; src/TerminalWorkspace.tsx; src-tauri/"
            elif requirement_id in {"SP-DT-010", "SP-DT-011"}:
                evidence = "crates/stackport-core/tests/table_query.rs; tests/desktop-smoke.cjs; src/TableQueryControls.tsx; src-tauri/"
            elif requirement_id in {"SP-SEC-003", "SP-SEC-015"}:
                evidence = "crates/stackport-core/tests/edit.rs; crates/stackport-core/src/sftp/delete.rs; crates/stackport-core/src/sftp/editor.rs; tests/desktop-smoke.cjs; tests/sftp-smoke.cjs; src/SftpDeleteDialog.tsx; src/SftpEditorDialog.tsx"
            elif (requirement_id.startswith("SP-DT-") and requirement_id != "SP-DT-001") or requirement_id == "SP-AT-010":
                evidence = "crates/stackport-core/tests/edit.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            else:
                evidence = "crates/stackport-core/tests/workspace.rs; src/; src-tauri/"
        writer.writerow([requirement_id, title, detail, "partial" if subset else "not_started", subset, evidence])
print(f"{len(items)} requirements written to {OUTPUT}")
