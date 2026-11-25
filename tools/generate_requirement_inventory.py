"""Generate a conservative requirements inventory from the checked-in spec."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SPEC = ROOT / "StackPort_Functional_Spec_KO.md"
OUTPUT = ROOT / "docs" / "requirements.csv"

# Evidence covers only the stated subset, never the full requirement.
PARTIAL = {
    "SP-UI-001": "프로젝트 관리 메뉴에서 이름 변경·복제·보관·재활성화·삭제, 새 프로젝트와 연결 정의 복제",
    "SP-UI-002": "이름순 단일 데이터베이스 연결 목록·행별 엔진 표시·명세 9종 엔진 선택형 등록, 별도 SSH 그룹, SQLite 객체 탐색 및 PostgreSQL 서버 검색 결과에서 테이블·뷰 열기",
    "SP-UI-003": "연결별 SQL 다중 탭, Windows 터미널 탭 전환·고정·순서 변경·복제·최근 닫은 탭 다시 열기·고정하지 않은 탭 일괄 닫기, 터미널·RDP 세션 수 표시",
    "SP-UI-004": "두 도구의 좌우·상하 분할, 2×2 프리셋과 최대 네 영역의 개별 분할·크기 조절, 작업 상태를 유지하는 도구 교체·이동",
    "SP-UI-006": "탐색기에서 연결과 즐겨찾기·SQLite 객체 필터링, 연결된 PostgreSQL에 이름·스키마 객체 검색 제출 및 명령 팔레트 검색",
    "SP-UI-007": "Ctrl+Shift+P 명령 팔레트, 작업 도구·프로젝트·저장 연결·SQLite 객체 열기와 메모리 내 최근 명령 우선 표시",
    "SP-UI-008": "Windows 상단·단축키에서 SSH·RDP·PostgreSQL 주소와 SQLite 파일 경로 판별, 현재 프로젝트 저장 연결 재사용, 새 대상 양식 채우기와 SSH 등록",
    "SP-UI-009": "SQLite·PostgreSQL·SSH 연결과 SQLite·PostgreSQL 테이블·뷰를 개인 또는 프로젝트 범위로 고정, 검색·재시작 복원, 연결 확인 후 열기, 프로젝트 복제 시 연결 ID 재매핑",
    "SP-UI-011": "프로젝트·SQLite 작업, SFTP 전송·복사·폴더 생성·이름 변경·이동·삭제, SSH·PostgreSQL 연결 정의와 SSH 호스트 키 신뢰·교체의 로컬 기록",
    "SP-UI-012": "재시작 후 마지막 프로젝트·SQLite 연결·도구 배치·분할 크기·탐색기 상태 복원, 저장된 SSH 정의 다시 표시",
    "SP-UI-014": "쿼리 실행·중단·시간 초과·오류와 읽기 전용 표시, 하단 상태 표시줄에 터미널·RDP·SSH 터널 수와 PostgreSQL 연결 및 DB 실행 상태 표시",
    "SP-UI-019": "SQLite·PostgreSQL 탭·앱 닫기 시 탭별 초안 확인 및 개별 파일 저장, SFTP 편집기·앱 닫기 시 확인과 로컬 초안 보관",
    "SP-UI-015": "작업 공간의 라이트·다크·시스템 테마, 컴팩트 밀도, 분할·초안·터미널을 유지하는 집중 모드, 탐색기 펼치기·접기",
    "SP-UI-016": "작업 도구와 터미널 탭의 키보드 이동, 명령 팔레트 검색, 분할 창 크기 조절, Ctrl+Shift+F 터미널 출력 검색",
    "SP-CN-001": "프로젝트별 SQLite 파일, SSH·PostgreSQL·Redis 호스트·포트·사용자·이름·환경 저장과 Redis DB 번호·TLS 설정",
    "SP-CN-002": "SSH 연결의 DNS·TCP 단계 진단과 호스트 키 사전 조회; 인증·권한 검사는 미제공",
    "SP-CN-003": "SQLite 연결 정의 생성·삭제, SSH·PostgreSQL·Redis 연결 정의 생성·수정·삭제와 세션 열기·닫기, DBMS 9종과 SSH 연결의 설정 기반 복제",
    "SP-CN-005": "선택한 SSH·데이터베이스 연결의 버전형 JSON 내보내기, 검토한 파일에서 선택한 연결만 가져오기, DB 이름 변경·로컬 파일 연결과 일괄 등록",
    "SP-CN-007": "SSH 터미널의 일회성 암호 입력",
    "SP-CN-008": "Windows SSH 세션에서 키 파일 1~8개 선택과 암호화된 키의 터미널 암호 입력",
    "SP-CN-009": "Windows SSH 서버 대화형 인증과 다중 질문·서버 안내·응답 표시 정책",
    "SP-CN-010": "SSH 호스트 키 지문 확인·고정·변경 차단과 명시적 교체",
    "SP-CN-011": "PostgreSQL·MySQL 계열 TLS에서 시스템 신뢰 저장소·선택적 PEM CA를 사용해 서버 인증서 체인·호스트 이름·유효기간 검증, MySQL 계열 PEM 클라이언트 인증",
    "SP-CN-012": "PostgreSQL 사용자 이름과 세션별 암호 인증",
    "SP-CN-014": "SSH 연결 JSON에서 암호·개인 키·호스트 키 신뢰 정보 제외, DB 연결 JSON에서 암호·토큰·인증서·개인 키 경로 제외 및 가져오는 장치에서 필요한 파일 재선택",
    "SP-CN-015": "같은 프로젝트의 SSH 서버 최대 3개를 순서대로 경유해 SSH 터미널·SFTP 접속, 단계별 지문·인증·실패 표시",
    "SP-CN-017": "프로젝트별 로컬(-L)·동적 SOCKS5(-D)·원격(-R) TCP 전달 등록·수정·삭제·시작·중단과 선택적 SSH 경유",
    "SP-CN-018": "로컬 포트 충돌·예약, 원격 수신 거부·대상 연결 오류·SSH 단절, 실행 상태·접속 수·송수신량 표시",
    "SP-CN-023": "저장된 SSH·PostgreSQL 연결의 DEV/STAGING/PROD 구분·표시와 PROD 연결 전 확인",
    "SP-CN-024": "SSH 암호·대화형 인증 시도 제한과 지정 방식의 대체 인증 차단",
    "SP-TM-001": "Windows PowerShell·CMD 로컬 터미널과 셸별 바로 열기",
    "SP-TM-002": "Windows OpenSSH의 대화형 원격 셸과 SSH 경유 PTY의 입출력·크기 변경·종료 코드",
    "SP-TM-003": "Windows ConPTY와 xterm.js 기반 입력·출력·크기 조절",
    "SP-TM-005": "터미널 메모리 스크롤백, 탭별 일반 문자열 검색과 TXT·ANSI 출력 내보내기",
    "SP-TM-006": "터미널 키보드 입력과 선택·붙여넣기",
    "SP-TM-007": "여러 줄 붙여넣기 전 확인",
    "SP-TM-016": "비활성 터미널에 새 출력이 있으면 탭에 표시하고 확인 시 지움",
    "SP-TM-017": "로컬 터미널·앱 종료 시 실행 작업 확인",
    "SP-NW-001": "Windows 로컬 IPv4·IPv6 TCP 연결·UDP 바인딩과 주소·PID·프로세스명 조회, 도구 전환 후 포트 필터 유지",
    "SP-NW-002": "네트워크·SSH 연결 화면의 DNS·TCP 진단과 Windows Ping·경로 추적, 도구 전환 후 진단 상태 유지",
    "SP-NW-003": "Windows HTTP/HTTPS HEAD·GET, 최대 5회 가용성 측정, 상태 코드·헤더·경과 시간·TLS 정보",
    "SP-NW-007": "로컬 터널 루프백 독점 바인딩, SOCKS5 무인증 범위와 원격 수신 범위 확인, 원격 루프백 채널만 허용",
    "SP-FL-001": "저장된 SSH 연결과 공통 호스트 키 저장소로 SFTP 탐색 시작, 같은 프로젝트의 다단계 SSH 경유",
    "SP-FL-002": "로컬·SFTP 이중 패널, 이름 검색과 독립 정렬·방문 기록, 경로·상위/하위 폴더 이동과 새로고침, 좁은 창에서 패널 전환",
    "SP-FL-003": "SFTP 원격 폴더 생성, 일반 파일·폴더 이름 변경·이동, 일반 파일 복사와 단일 파일·빈 폴더 삭제",
    "SP-FL-004": "확인한 호스트 키로 SFTP v3 연결, 암호와 암호화된 개인 키 인증",
    "SP-FL-006": "SFTP의 단일 파일 업·다운로드, 진행 바이트·평균 속도·예상 잔여 시간 표시와 중단",
    "SP-FL-007": "SFTP 전송 실패·중단 시 임시 파일 정리, 완료 파일 게시와 수동 재시도",
    "SP-FL-008": "전송·복사·원격 이름 변경·이동에서 기존 대상 보존, 파일 크기·수정 시간 변경 감지",
    "SP-FL-009": "로컬·SFTP 항목의 유형·크기·수정 시각, 숨김 표시와 크기·시각 정렬, SFTP 권한·소유자/그룹 ID",
    "SP-FL-010": "SFTP 일반 파일·폴더의 Unix 권한·소유자 변경, 변경 전후 확인과 서버 거부·미지원 사유 표시",
    "SP-FL-011": "로컬·SFTP 파일의 UTF-8 원문, HEX 및 정적 PNG 미리보기, 전체를 읽은 JSON 들여쓰기·XML 구조·CSV 표와 원문 전환",
    "SP-FL-012": "최대 512 KiB SFTP UTF-8 편집기, SQL·JSON·XML 구문 강조, 줄 번호·커서 위치와 찾기·바꾸기, BOM·LF/CRLF 유지, 로컬 초안 보관",
    "SP-FL-013": "SFTP 텍스트 열기·편집, 검증한 원격 임시 파일에서 저장, 원본 해시 충돌 확인과 새 이름 저장",
    "SP-FL-014": "Windows .exe 외부 편집기에서 임시 UTF-8 초안 열기, 저장된 내용 감시와 가져오기, 원격 저장 확인 및 임시 파일 정리",
    "SP-FL-015": "현재 로컬·SFTP 폴더에서 각 파일 직접 선택, SHA-256(16 MiB), UTF-8 줄·HEX 차이(64 KiB), 변경 구간 선택 및 UTF-8 병합 결과 별도 저장",
    "SP-FL-016": "로컬·SFTP 하위 구조·크기·수정 시각과 미확인 상태, 선택한 쌍의 SHA-256 비교, 동기화 작업 미리보기",
    "SP-FL-017": "단방향·양방향 dry-run·실행, 검증 후 갱신과 단방향 삭제 반영, 제외·충돌 표시, 남은 작업 중단과 작업 기록",
    "SP-FL-018": "활성 Windows PowerShell의 드라이브 경로와 같은 저장된 SSH 연결의 OSC 7 경로를 파일 창별 선택으로 반영",
    "SP-FL-019": "SFTP 빈 폴더를 확인해 한 폴더씩 삭제하며 숨김 파일을 포함한 하위 항목을 보존",
    "SP-FL-021": "SFTP 업로드·원격 복사·편집본의 원격 SHA-256 검증, 다운로드의 수신 SHA-256과 원격 크기·수정 시간 검증",
    "SP-FL-022": "SSH 연결별 폴더 동기화 프로필 저장·삭제, 폴더와 옵션 불러오기 및 최신 목록으로 수동 실행 계획 생성",
    "SP-FL-023": "SFTP 전송·편집·파일 관리·권한 및 소유자 변경·동기화의 시작과 결과를 시각 및 연결 ID와 함께 로컬에 기록",
    "SP-FL-024": "SFTP 경로의 누락과 접근 거부, 새 폴더·파일 이름 충돌 및 전송 오류 표시",
    "SP-RG-001": "Windows 네이티브 RDP 실행, 열린 클라이언트 목록, 창·전체 화면·다중 모니터, 펼칠 수 있는 해상도·색 깊이 설정",
    "SP-RG-002": "사용자·도메인 및 관리 콘솔, Windows CredSSP 사용과 서버 인증 실패 시 연결 거부 설정",
    "SP-RG-003": "RDP의 클립보드·선택 드라이브·프린터·스마트카드 공유와 Windows 단축키 적용 설정",
    "SP-RG-004": "RDP 창 크기에 맞춘 해상도 조정·자동 재연결 및 클라이언트 연결 끊기 옵션",
    "SP-RG-018": "Windows RDP 클라이언트 설치 여부와 브라우저·비지원 OS의 사용 제한 표시",
    "SP-DB-001": "SQLite·PostgreSQL 조회·그리드 편집, MySQL·MariaDB·SQL Server·Oracle·Snowflake 객체 탐색·데이터 미리보기와 SQL 편집기 세션 권한 적용, MongoDB 컬렉션·문서 탐색과 세션별 문서 편집, Redis 단독 서버 키 탐색·타입별 편집. Snowflake 실제 계정 검증 대기",
    "SP-DB-004": "PostgreSQL·MySQL 계열·SQL Server 호스트·포트·DB·사용자와 환경, Oracle 호스트·포트·서비스 이름·SID·사용자와 환경, Snowflake 계정 호스트·데이터베이스·웨어하우스·역할·환경",
    "SP-DB-005": "PostgreSQL·MySQL 계열 TLS 서버 인증서 검증과 SSH 터널·점프 호스트, MySQL 계열 PEM 클라이언트 인증, MongoDB·SQL Server·Oracle 서버 인증서 검증과 선택적 PEM CA, Snowflake HTTPS 인증서 검증",
    "SP-DB-006": "PostgreSQL·MySQL 계열·SQL Server·Oracle 세션별 사용자 이름·암호 인증, SQL Server Windows 통합 인증 설정, Snowflake 세션별 PAT·OAuth 액세스 토큰",
    "SP-DB-007": "한 프로젝트에 여러 SQLite·PostgreSQL·MySQL 계열·SQL Server·Oracle·Snowflake 연결 정의",
    "SP-DB-009": "SQLite 테이블·뷰 목록, PostgreSQL·MySQL 계열·SQL Server·Oracle·Snowflake 스키마 및 테이블·뷰의 지연 조회와 접근 불가 표시, Oracle·Snowflake 구체화 뷰 표시",
    "SP-DB-010": "SQLite 테이블·뷰의 열·기본 키·외래 키·인덱스, PostgreSQL 테이블·파티션 테이블·뷰·구체화 뷰의 열·제약조건·인덱스·트리거·파티션, MySQL·MariaDB·SQL Server 열·인덱스·제약조건·양방향 외래 키, Oracle·Snowflake 열 타입·NULL·IDENTITY",
    "SP-DB-014": "SQLite 테이블·뷰의 생성 SQL 열람, PostgreSQL 뷰·인덱스·트리거·일부 속성 정의 열람·복사·저장, MySQL·MariaDB·Oracle·Snowflake 테이블·뷰 정의, SQL Server 일반 테이블 생성 SQL과 뷰 정의 열람·복사·저장. Snowflake 실제 계정 검증 대기",
    "SP-DB-017": "PostgreSQL 트리거의 생성 SQL로 실행 시점 확인 및 활성 상태 열람",
    "SP-DB-018": "SQLite 인덱스 구성과 고유·부분 여부, PostgreSQL 인덱스 구성·유효 상태·크기, MySQL·MariaDB 인덱스 열·식·순서·접두 길이·가시성·고유값 추정치, SQL Server 인덱스 키·순서·포함 열·필터·상태·파티션·추정 행 수 열람",
    "SP-DB-020": "PostgreSQL 현재 역할의 객체 단위 유효 권한과 행 수준 보안 설정 열람",
    "SP-DB-021": "PostgreSQL 데이터베이스·스키마에서 이름·종류·열 이름·객체 및 열 주석·지원 SQL 정의 검색. SQL Server·Oracle·Snowflake의 데이터베이스·스키마별 객체명·열명·종류 검색과 결과 이동. Snowflake 실제 계정 검증 대기",
    "SP-DB-022": "SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake 구조·데이터 조회 및 필터·정렬된 전체 결과 CSV·JSON 내보내기, PostgreSQL 조회 SQL, MySQL·MariaDB·SQL Server 참조 객체 구조 열기, SQL Server 일반 테이블·뷰와 Oracle·Snowflake 테이블·뷰 정의 열기·저장. Snowflake 실제 계정 검증 대기",
    "SP-DB-023": "PostgreSQL 연결의 버전·데이터베이스·사용자·인코딩·시간대와 서버 가동 시간·연결 수·누적 통계, MySQL·MariaDB 버전·문자셋·시간대·기본 스토리지와 연결·문장·트래픽·잠금 지표",
    "SP-DB-024": "PostgreSQL 독립 읽기 전용 모니터의 세션·실행 SQL·잠금 차단 PID·느린 실행 필터·지표와 pg_stat_statements 누적 통계, MySQL·MariaDB 세션·느린 실행·InnoDB 잠금 대기와 차단 세션",
    "SP-DB-025": "PostgreSQL 현재 DB 작업 세션과 MySQL·MariaDB 서버 세션의 권한 범위 실행 SQL·잠금 대기 조회",
    "SP-DB-026": "두 SQLite 연결에서 객체·열·외래 키·인덱스·트리거·정의 SQL 비교, 생성·삭제·뷰 재정의 초안",
    "SP-DB-028": "SQLite·PostgreSQL의 읽기 전용 SQL 연결, PostgreSQL 그리드의 SELECT·INSERT·UPDATE·DELETE 권한 확인과 편집 제한 안내",
    "SP-DB-029": "PostgreSQL 접속마다 독립적인 세션, 읽기 전용 쿼리 후 롤백과 세션 상태 정리",
    "SP-DT-001": "SQLite·PostgreSQL 100행, MySQL·MariaDB 50행 결과 페이지, PostgreSQL 열 페이지, SQL Server·Oracle 기본 키 기준 50행 페이지, Snowflake 첫 50행 미리보기",
    "SP-DT-002": "PostgreSQL 일반 힙 테이블 그리드에서 원문 텍스트·bytea HEX 페이지와 JSON·JSONB 들여쓰기·XML 트리·정적 PNG 보기",
    "SP-DT-003": "SQLite·PostgreSQL의 행 추가·삭제 및 다중 셀 수정, 탭 구분 복사·붙여넣기, 현재 페이지의 여러 행 수정 및 같은 열 채우기, MySQL·MariaDB 한 행의 다중 셀 수정",
    "SP-DT-004": "SQLite·PostgreSQL의 그리드 변경 미리보기·적용·취소와 초안 닫기 확인, 여러 행의 개별 변경 표시 및 전후 비교, MySQL 계열 한 행 전후 비교·적용·취소·초안 닫기 확인",
    "SP-DT-005": "SQLite·PostgreSQL 기본 키 검증과 키 없는 테이블 편집 차단, MySQL 계열 복합 기본 키의 InnoDB 테이블 편집",
    "SP-DT-006": "SQLite·PostgreSQL의 NULL·빈 문자열·숫자·기본값 구분과 자동 생성 키, 탭 구분 복사·붙여넣기의 NULL·빈 문자열 구분, SQLite의 열별 입력 형식과 PostgreSQL의 서버 타입 검증, MySQL 계열 NULL·빈 문자열·서버 기본값 구분",
    "SP-DT-007": "SQLite 문자열·정수·실수·NULL 셀 편집, PostgreSQL의 숫자·날짜·UUID·JSON 등 지원 타입 바인딩",
    "SP-DT-008": "PostgreSQL 일반 힙 테이블의 긴 텍스트·JSON·XML·bytea 부분 조회, 범위 내 구조·PNG 미리보기와 원본 새 파일 저장",
    "SP-DT-010": "SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake 테이블·뷰의 타입별 비교·기간·포함·NULL 필터, AND/OR, 매개변수 SQL 표시, 연결·객체별 조건 저장과 재적용. Snowflake 실제 계정 검증 대기",
    "SP-DT-011": "SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake 전체 결과를 대상으로 다중 열·방향·NULL 순서 정렬 및 초기화, 저장한 순서 복원. Snowflake 실제 계정 검증 대기",
    "SP-DT-013": "SQLite·PostgreSQL 연결·객체별 열 표시·왼쪽 고정·순서·폭·타입별 색상·숫자 자릿수·ISO 날짜 형식과 보기 프로필 저장, PostgreSQL 열 페이지에 고정 열 반복",
    "SP-DT-017": "MySQL·MariaDB 테이블·뷰 데이터의 처음·이전·다음 페이지 이동",
    "SP-DT-018": "SQLite 편집 셀의 문자열·정수·실수·NULL 형식별 입력",
    "SP-DT-020": "SQLite·PostgreSQL의 셀 변경과 PostgreSQL 다중 셀 행 변경의 시작·성공·실패 감사 기록, MySQL 계열 다중 셀 적용 시작·성공·실패·결과 미확정 기록",
    "SP-DT-021": "SQLite 행 전체 지문과 PostgreSQL 행 버전을 이용한 동시 수정 감지, MySQL 계열 조회 가능 열 지문과 구조 재확인",
    "SP-DT-022": "SQLite·PostgreSQL 다중 셀·행 수정의 트랜잭션·전체 롤백·저장 값 검증, 여러 행 붙여넣기 롤백 및 PostgreSQL 커밋 결과 미확정 표시, MySQL 계열 한 행 다중 셀 트랜잭션과 커밋 결과 미확정 표시",
    "SP-DT-024": "SQLite·PostgreSQL 제약·형식·충돌 실패 시 롤백과 오류 표시, MySQL 계열 제약·길이·경고·충돌 실패 시 롤백",
    "SP-SQ-001": "7개 관계형 엔진의 연결별 다중 SQL 탭, 방언별 구문 강조, 줄 번호·커서 위치, 찾기·바꾸기, 파일 열기, 메모리 초안과 닫기 확인",
    "SP-SQ-002": "현재 SQLite 연결의 main 스키마, 테이블·뷰·열·기본 함수와 키워드, 쿼리 별칭 및 CTE 이름 후보, Ctrl+Space·점 입력과 되돌리기",
    "SP-SQ-003": "SQLite 준비 단계의 문법·객체·타입·읽기 전용 진단과 문서 범위 이동, PostgreSQL 실행 전 서버 파싱 오류의 문서 위치 이동",
    "SP-SQ-004": "현재 SQLite 연결의 main 테이블·뷰·열 정보를 호버와 F12로 표시, 생성 SQL과 같은 쿼리 범위의 확인된 참조 위치로 이동",
    "SP-SQ-005": "SQLite 조회의 테이블 별칭과 유효 범위 참조 변경, SQLite의 실행 명령·결과 열 비교, SQL 서식 변경 및 되돌리기",
    "SP-SQ-006": "SQLite 문서 및 범위 서식·축약, 키워드 대소문자·들여쓰기·문장 사이 빈 줄 설정 저장",
    "SP-SQ-007": "SQLite 문서·선택 일괄 실행과 현재 문장, PostgreSQL 단일 조회와 스크립트의 문서·선택·현재 문장 및 SQL 루틴의 BEGIN ATOMIC 경계, MySQL 계열 스크립트 전체·현재·선택 실행과 DELIMITER 프로시저, SQL Server 전체·현재 배치·선택 실행과 GO 경계·반복 처리, Oracle SQL·PL/SQL 경계와 Snowflake 스크립팅 인용 경계를 처리하는 전체·현재·선택 실행",
    "SP-SQ-008": "SQLite 개별·일괄 조회 결과와 시간·페이지·내보내기, PostgreSQL 탭별 조회·계획과 스크립트 문장별 결과·영향 행·알림·시간·SQLSTATE·오류 위치와 전체 JSON 저장, MySQL 계열 문장·복수 결과 집합·시간·SQLSTATE·영향 행과 읽기 전용 결과 내보내기, SQL Server 복수 결과 집합·시간·오류 위치, Oracle 문장별 결과·오류·경고·DML 영향 행 수, Snowflake 문장별 결과·쿼리 ID·SQLSTATE와 DML 통계",
    "SP-SQ-009": "SQLite 조회 중단과 시간 초과, PostgreSQL 조회·스크립트의 검증 TLS 서버 취소·중단 확인·시간 제한과 스크립트 트랜잭션 정리, MySQL 계열 스크립트 서버 취소 확인·시간 제한·롤백 확인 및 읽기 전용 조회 중단, SQL Server 타임아웃·중단 응답 확인, Oracle 호출 사이 중단·소켓 시간 제한과 별도 실행 연결 종료로 트랜잭션 정리, Snowflake 비동기 실행 핸들 취소와 결과 수신 중단 구분",
    "SP-SQ-010": "SQLite 슬롯 감지와 형식·값 바인딩, SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake 프로젝트·SQL별 세트 저장·기본값·숨김 값 재입력, PostgreSQL 읽기 전용 조회·스크립트의 서버 타입 추론과 값·NULL 바인딩, 읽기 전용 값 수정, 스크립트 실행 전 번호 검증·정밀 소수·입력 오류 상세 숨기기, MySQL 계열 위치별 문자열·정수·실수·NULL 바인딩, SQL Server 번호별 타입 바인딩, Oracle 범위별 이름 감지와 타입 바인딩, Snowflake 단일 문장 위치별 타입 바인딩, SQL Server·Oracle·Snowflake 38자리 소수와 값·오류 상세 숨기기. Snowflake 실제 계정 검증 대기",
    "SP-SQ-011": "PostgreSQL·MySQL 계열 스크립트의 자동 커밋 선택·저장점·롤백 확인, SQL Server·Oracle 스크립트에서 COMMIT·ROLLBACK 실행과 종료 시 트랜잭션 정리, Snowflake 스크립트의 단일 SQL API 요청에서 명시적 트랜잭션 실행",
    "SP-SQ-012": "SQLite 테이블·뷰 드래그와 조인 관계 표시, 외래 키와 수동 열 조인, WHERE·GROUP BY·HAVING·ORDER BY·LIMIT, 새 탭에서 SQL 실행",
    "SP-SQ-013": "SQLite SQL 탭마다 조회 페이지 고정, 동일 페이지의 열·값·행 차이 표시, 저장 쿼리와 매개변수 재실행",
    "SP-SQ-014": "SQLite EXPLAIN QUERY PLAN과 PostgreSQL·MySQL·MariaDB의 예상 계획 및 실제 분석을 텍스트·단계 트리로 표시",
    "SP-SQ-015": "SQLite 스캔·조건 검색·임시 B-Tree, PostgreSQL·MySQL·MariaDB 스캔·조인·정렬·인덱스와 엔진별 비용·예상/실제 행 및 긴 리프 표시, PostgreSQL 행 오차 표시",
    "SP-SQ-016": "SQLite 조회·스캔·정렬·인덱스·가상 머신 지표와 비교, PostgreSQL 실행 계획·시간·버퍼와 pg_stat_statements 누적 실행·블록 통계",
    "SP-SQ-017": "관계형 엔진의 프로젝트별 템플릿·폴더·방언·즐겨찾기·검색과 선택 SQL 저장, 엔진별 매개변수 구문 안내, 연결별 최근 SQL과 새 탭 열기",
    "SP-SQ-018": "7개 관계형 엔진에서 1 MiB 이하 UTF-8·UTF-16 LE/BE·Windows-949·Windows-1252 SQL 파일을 새 탭에 열고 명시적으로 실행, 새 파일 저장 및 BOM·LF/CRLF 유지",
    "SP-SQ-022": "쓰기 가능한 관계형 SQL 편집기에서 선택한 실행 범위의 조건 없는 DML·DDL·대량 작업·동적 실행 식별, 줄 번호·반복·연결·환경 표시와 운영 확인. SQLite·PostgreSQL·MySQL 계열 읽기 전용 실행 보호",
    "SP-SQ-023": "관계형 SQL 편집기의 연결별 메모리 실행 기록, 현재 문장·배치 범위, 상태·시간·제공된 행 수, 가린 미리보기와 연결별 원문 보관 선택·삭제",
    "SP-MD-002": "SQLite·PostgreSQL 기본 키 및 외래 키 방향을 표시하는 읽기 전용 관계형 ERD",
    "SP-MD-006": "SQLite·PostgreSQL 스키마의 읽기 스냅샷에서 테이블·열·복합 외래 키를 추출하고 이름과 관계로 선택·필터",
    "SP-MD-015": "선택한 SQLite·PostgreSQL 테이블과 인접 관계 자동 배치, 60~150% 확대·축소",
    "SP-MD-016": "SQLite 테이블·뷰 열, 기본값·키·인덱스·트리거·외래 키와 제약을 담은 구조 문서 자동 생성",
    "SP-MD-019": "SQLite·PostgreSQL 외래 키를 따라 탐색하고 관계 없는 테이블 표시, SQLite의 미확인 참조 표시, PostgreSQL의 다른 스키마 직접 참조와 데이터 그리드 이동",
    "SP-MD-020": "SQLite 테이블·뷰 데이터 사전을 Markdown·HTML로 저장하고 생성 SQL의 주석·선언 타입 포함",
    "SP-SQ-025": "SQL 파일 BOM 자동 확인, UTF-8·UTF-16 LE/BE·Windows-949·Windows-1252 수동 선택과 무손실 변환, 표현할 수 없는 문자 경고, DB 연결 문자 전송과 분리",
    "SP-SQ-026": "PostgreSQL 연결당 단일 실행, 읽기 전용 트랜잭션, 결과 100행·24열 및 서버 문장 제한 8초",
    "SP-MG-001": "SQLite·PostgreSQL의 CSV·TSV·TXT 구분 텍스트, JSON 객체 배열과 StackPort 결과 JSON, 경로를 선택한 XML 레코드 가져오기",
    "SP-MG-002": "SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake 필터·정렬된 테이블·뷰 결과와 SQLite·PostgreSQL·MySQL·MariaDB SQL 전체 결과를 UTF-8 CSV·버전형 JSON으로 내보내기, PostgreSQL 스크립트의 문장별 전체 결과 JSON 저장. Snowflake 실제 계정 검증 대기",
    "SP-MG-004": "두 엔진에서 파일·형식·인코딩·구분자·헤더와 XML 레코드 경로 선택, JSON·XML 원본 열과 대상 열 매핑, 검증 미리보기",
    "SP-MG-005": "JSON 숫자 토큰과 중첩 값, XML 중첩 셀, SQL NULL·빈 문자열·생략 구분, SQLite 저장 타입 확인과 BLOB·bytea 복원, PostgreSQL 서버 타입 변환, SQL Server·Oracle·Snowflake 내보내기에서 큰 수·날짜·유니코드·바이너리·NULL 보존. Snowflake 실제 계정 검증 대기",
    "SP-MG-006": "SQLite·PostgreSQL 기존 테이블에 추가, 한 트랜잭션의 커밋·중복 키와 제약 오류 시 전체 롤백",
    "SP-MG-007": "인코딩, 구분 텍스트 따옴표·열 수, JSON 문법·중복 속성, XML DTD·처리 지시문·반복 필드, DB 타입·제약 위반 메시지 표시",
    "SP-MG-008": "SQLite·PostgreSQL·MySQL·MariaDB·SQL Server·Oracle·Snowflake CSV·JSON 내보내기 행 스트리밍과 진행 행 수, 중단·시간 제한, 완료 파일만 저장, PostgreSQL 스크립트 실행 중 JSON으로 행 기록 및 취소 시 임시 파일 정리. Snowflake 실제 계정 검증 대기",
    "SP-MG-013": "SQLite 기준·대상 스키마의 객체와 선언 속성 차이, 한쪽 객체 생성·삭제와 뷰 재정의 SQL 초안",
    "SP-MG-014": "SQLite 새 일반 테이블·뷰와 출력 열이 같은 뷰의 재정의를 선택 검토한 뒤 대상 백업과 트랜잭션 적용",
    "SP-MG-018": "SQLite 스키마 적용 후 선택 객체 정의·뷰 열·외래 키 검증, 적용 개수 및 백업 확인",
    "SP-MG-024": "SQLite 선택 객체 또는 전체 스키마의 열·키·관계·규칙과 생성 SQL 주석을 Markdown·HTML로 내보내기",
    "SP-MG-026": "SQLite·PostgreSQL 파일 가져오기에서 대상과 환경, 추가 예정 건수와 값 미리보기, 운영 확인 및 실패 시 전체 롤백",
    "SP-MG-028": "SQLite·MySQL·MariaDB CSV·JSON 내보내기의 행 수·파일 크기·보호 필드 보고, SQLite·PostgreSQL 파일 가져오기의 예상·저장 행 수와 대상 작업 기록",
    "SP-BK-001": "SQLite 전체 DB, PostgreSQL 전체 DB·스키마·일반 테이블의 구조와 데이터·구조만·데이터만 선택",
    "SP-BK-002": "SQLite 온라인 백업 API와 PostgreSQL pg_dump",
    "SP-BK-003": "SQLite 바이너리 파일과 PostgreSQL pg_dump 압축 아카이브",
    "SP-BK-005": "버전이 일치하는 pg_dump·pg_restore 탐색, 전체·스키마·일반 테이블 백업, 커스텀 아카이브 목차 확인 후 새 DB에 단일 트랜잭션 복원",
    "SP-BK-006": "SQLite WAL 포함 스냅샷과 무결성 검사",
    "SP-BK-011": "PostgreSQL 압축 아카이브와 SHA-256 표시, 작업마다 별도로 입력한 암호를 백업 도구에 메모리로 전달",
    "SP-BK-013": "SQLite 새 복원 경로·버전·행 수 미리보기, PostgreSQL 새 DB 이름과 권한·버전·목차·출처·SHA-256 확인 및 보존된 사본 승인",
    "SP-BK-014": "SQLite 백업·복원본 무결성 및 행 검증, PostgreSQL 아카이브 SHA-256과 새 DB 테이블 수 표시, 통합 테스트로 행·복합 외래 키·롤백 확인",
    "SP-BK-017": "PostgreSQL 백업의 로컬 파일 저장 경로와 복원할 서버·새 DB를 각각 표시하고 복원 시 CREATEDB 권한 확인",
    "SP-NS-009": "Redis 6.2 이상과 호환되는 단독 서버, ACL·암호 인증, 검증 TLS·일반 TCP와 논리 DB 선택",
    "SP-NS-010": "SCAN 커서와 서버 패턴·타입 필터, JSON 명령을 확인한 서버의 JSON 타입 필터, 허용 시 DB 전체 키 수와 선택한 키의 TTL·메모리 표시",
    "SP-NS-011": "String 교체, Hash 필드 저장, List 항목 교체, Set 멤버 추가, Sorted Set 점수 저장, Stream 메시지 추가, 지원 서버에서 64 KiB 이하 JSON 문서 조회·검토 후 교체, UTF-8·HEX 미리보기와 키 TTL 설정·해제",
    "SP-NS-012": "읽기 전용 명령 콘솔, Tab 명령 완성, RESP 응답 타입·HEX 표시, 연결별 최근 30건과 방향키 재입력, 변경·삭제·관리 명령 차단 사유",
    "SP-NS-013": "단독 서버의 채널·패턴 구독, UTF-8·HEX 수신 미리보기, 자동 재연결, 최근 100건 보관·지우기, 검토 후 UTF-8 발행",
    "SP-NS-014": "단독 서버의 메모리·클라이언트·초당 작업, DB별 키·만료 통계, 복제 역할·연결과 권한이 허용하는 최근 슬로로그 표시",
    "SP-NS-017": "접속 때 Redis 호환 주·부 버전과 Cluster 여부 확인, JSON.GET·JSON.SET 확인과 권한으로 명령 정보를 읽을 수 없는 상태 처리, 서버 지원 여부에 따른 JSON 필터·편집 UI",
    "SP-NS-018": "Redis 개별 키 또는 선택한 최대 50개 키의 전체 이름·연결·DB·건수 미리보기와 동시 변경 시 전체 중단, MongoDB 단일 문서 삭제 전 원본 검토·동시 변경 차단, DELETE 및 PROD 확인",
    "SP-ST-006": "프로젝트·연결 정의·즐겨찾기·작업 공간 배치 저장, 이전 배치 스냅샷 복원, 메타데이터 이관 전 검증 백업",
    "SP-ST-017": "SQLite 트랜잭션과 버전 비교로 여러 창의 작업 공간 배치 저장 충돌 감지",
    "SP-ST-011": "Windows 휴대형·표준·지정 데이터 경로 및 새 폴더로 검증 복사",
    "SP-ST-001": "화면 설정의 라이트·다크·시스템 테마와 기본·컴팩트 밀도, 재시작 뒤 선택 유지",
    "SP-ST-014": "Windows 작업 공간과 선택한 SSH 신뢰 파일을 검증하여 새 폴더에 백업",
    "SP-SEC-007": "Tauri 콘텐츠 보안 정책",
    "SP-SEC-008": "메타데이터·셀 변경 값 바인딩, 일반 SQL 읽기 전용 검사와 SSH 인자 분리·대상 검증",
    "SP-SEC-003": "SFTP 원격 삭제 및 SQLite 셀 변경의 영향·운영 확인, 쓰기 가능한 SQL 편집기의 실행 범위·연결·환경과 위험 유형 사전 표시",
    "SP-SEC-004": "SSH 호스트 키 지문 확인·변경 차단과 이력, 웹 TLS 인증서 검증, RDP 서버 인증 실패 시 연결 거부 설정",
    "SP-SEC-009": "작업 기록에서 SQL·행 데이터·경로·자격 증명 제외",
    "SP-SEC-011": "로컬 변경·백업·복원·DB 내보내기·편집, PostgreSQL·MySQL 계열·SQL Server·Oracle·Snowflake SQL 실행 결과와 PostgreSQL 스크립트 JSON 저장 결과, Redis 키와 MongoDB 문서 변경·삭제 및 결과 미확인, SFTP 파일 작업과 SSH 연결·키 이력 기록",
    "SP-SEC-015": "운영 SQL 실행에서 PostgreSQL·MySQL 계열 스크립트 및 SQL Server·Oracle·Snowflake의 식별된 변경에 PROD 확인. SQLite·PostgreSQL·MySQL 계열 그리드 변경, Redis 키·MongoDB 문서 변경, SFTP 삭제·원격 편집 저장에도 확인",
    "SP-NFR-001": "SQLite 작업을 별도 스레드에서 실행",
    "SP-NFR-002": "한 번에 최대 100행 표시",
    "SP-NFR-006": "v1~v4 작업 공간을 백업한 뒤 트랜잭션으로 v5 이관, 손상된 배치의 이전 스냅샷 복원",
    "SP-AT-025": "v1~v10 백업 후 v11 이관·이관 실패 시 원본 보존",
    "SP-AT-024": "SQLite 로컬 메타데이터 및 로컬 조회",
    "SP-AT-016": "SQLite 백업 격리 파일 복원과 PostgreSQL 앱에서 새 DB 복원, 행·복합 외래 키·SHA-256 확인 및 의존성 오류 롤백",
    "SP-NS-001": "MongoDB에서 계정에 공개된 데이터베이스·컬렉션·뷰·인덱스 조회",
    "SP-NS-002": "MongoDB 일반 컬렉션에서 JSON·트리·그리드로 단일 문서 삽입·복제·수정·삭제, 중첩 필드와 배열 편집, BSON 타입·필드 순서 보존과 원본/변경 검토, 문서 및 컬렉션의 동시 변경 차단",
    "SP-NS-003": "MongoDB 비교·논리 필터, 표시 필드, 정렬과 페이지 조회, 중첩 AND·OR와 BSON 값의 찾기 빌더, 컬렉션·뷰의 적용 필터 전체 일치 건수, BSON Canonical Extended JSON 표시",
    "SP-NS-004": "MongoDB 집계 단계 편집·순서 변경·활성 토글, 중간 및 전체 읽기 전용 미리보기, 프로젝트 저장·복제와 JSON 교환",
    "SP-NS-005": "MongoDB 컬렉션·뷰의 무작위 문서 표본, 중첩 필드·배열 경로별 등장 비율과 BSON 유형별 문서 수, 혼합 유형 필터",
    "SP-NS-006": "MongoDB 컬렉션의 인덱스 키·고유 여부·TTL 조회",
    "SP-AT-018": "실제 MongoDB 서버에서 제한 계정·TLS·BSON 문서 조회, 문서 편집 및 동시 변경 차단, 표본 스키마 분석, 단계별 집계 미리보기와 파이프라인 저장·교환, 실제 Redis 서버에서 ACL·TLS·논리 DB·SCAN, 여섯 타입 조회·편집, 바이너리 입력, TTL 설정·해제, 선택 삭제의 동시 변경 차단, Pub/Sub 구독·발행·재연결·결과 미확인 검증. Redis JSON 명령 감지·검토·동시 변경 응답은 RESP 테스트로 확인하며 모듈 활성 서버 검증 대기",
    "SP-AT-010": "SQLite·PostgreSQL의 기본 키 기반 다중 셀·행 미리보기·적용·취소·롤백·동시 수정 검사, PostgreSQL 행 수준 보안과 커밋 제약 오류에서 전체 롤백, MySQL·MariaDB 복합 키·미리보기·적용·취소·롤백·동시 변경 확인",
    "SP-AT-011": "SQLite 바인딩·실행 계획·페이지·취소·시간 초과, PostgreSQL 타입별 바인딩·예상/실제 계획·SSH 경유 서버 취소, MySQL·MariaDB 매개변수 계획·실제 분석·요청 중단 확인",
    "SP-AT-007": "Windows 로컬 CMD·PowerShell 입출력과 종료 정리",
    "SP-AT-001": "SSH 동일 알고리즘 키 변경 차단·명시적 재확인·교체 후 이전 키 차단",
    "SP-AT-002": "확인된 SSH 기반 SFTP 연결에서 UTF-8 원격 파일 편집·저장·재조회",
    "SP-AT-003": "SFTP 원본 변경 시 해시 충돌 감지, 편집 내용 유지와 새 원격 파일 또는 로컬 초안 보관",
    "SP-AT-006": "Windows에서 SSH 점프 경유 PostgreSQL·MySQL·MariaDB 연결, 터널 중단 안내와 동일 터널 재연결, SQL 초안 유지 및 실행",
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
            if requirement_id in {"SP-NS-001", "SP-NS-003", "SP-NS-006"}:
                evidence = "crates/stackport-core/src/mongo.rs; crates/stackport-core/src/mongo/query.rs; src/MongoWorkspace.tsx; tests/mongo-smoke.cjs"
                if requirement_id == "SP-NS-003":
                    evidence += "; crates/stackport-core/src/mongo/find_builder.rs; src/MongoFindBuilder.tsx"
            elif requirement_id == "SP-NS-002":
                evidence = "crates/stackport-core/src/mongo/document_edit.rs; crates/stackport-core/src/mongo/document_snapshot.rs; crates/stackport-core/src/mongo/document_structure.rs; src/MongoDocumentEditDialog.tsx; src/MongoDocumentStructure.tsx; tests/mongo-smoke.cjs"
            elif requirement_id == "SP-NS-004":
                evidence = "crates/stackport-core/src/mongo/pipeline.rs; crates/stackport-core/src/mongo/pipeline_store.rs; crates/stackport-core/tests/mongo_pipelines.rs; src/MongoPipeline.tsx; tests/mongo-smoke.cjs"
            elif requirement_id == "SP-NS-005":
                evidence = "crates/stackport-core/src/mongo/schema.rs; src/MongoSchemaAnalysis.tsx; tests/mongo-smoke.cjs"
            elif requirement_id.startswith("SP-NS-") or requirement_id == "SP-AT-018":
                evidence = "crates/stackport-core/src/redis.rs; crates/stackport-core/src/redis/keys.rs; src/RedisWorkspace.tsx; tests/redis-smoke.cjs"
            elif requirement_id in {"SP-BK-013", "SP-BK-014", "SP-AT-016"}:
                evidence = "crates/stackport-core/tests/restore.rs; tests/desktop-smoke.cjs; src/SqliteRestoreDialog.tsx; src-tauri/"
            elif requirement_id in {"SP-BK-005", "SP-BK-011", "SP-BK-017"}:
                evidence = "crates/stackport-core/src/postgres/backup.rs; src/PostgresBackupDialog.tsx; tests/postgres-smoke.cjs"
            elif requirement_id.startswith("SP-BK-"):
                evidence = "crates/stackport-core/tests/backup.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-DB-010", "SP-DB-014", "SP-DB-018"}:
                evidence = "crates/stackport-core/tests/schema.rs; tests/desktop-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-DB-017", "SP-DB-020"}:
                evidence = "tests/postgres-smoke.cjs"
            elif requirement_id in {"SP-DB-023", "SP-DB-024", "SP-DB-025"}:
                evidence = "crates/stackport-core/src/postgres/monitor.rs; crates/stackport-core/src/postgres/session.rs; src/PostgresServerMonitor.tsx; tests/postgres-smoke.cjs"
            elif requirement_id in {"SP-DT-002", "SP-DT-008"}:
                evidence = "crates/stackport-core/src/postgres/value.rs; crates/stackport-core/src/local_file.rs; crates/stackport-core/src/png_preview.rs; src/PostgresValueDialog.tsx; src/StructuredPreviewView.tsx; tests/postgres-smoke.cjs"
            elif requirement_id == "SP-DT-013":
                evidence = "src/GridColumnLayout.ts; src/GridColumnLayoutDialog.tsx; src/gridValuePresentation.ts; crates/stackport-core/src/postgres/grid_layout.rs; tests/grid-value-presentation.test.mjs; tests/desktop-smoke.cjs; tests/postgres-smoke.cjs"
            elif requirement_id == "SP-AT-006":
                evidence = "crates/stackport-core/src/ssh_tunnel/runtime.rs; crates/stackport-core/src/postgres/session.rs; src/PostgresWorkspace.tsx; tests/postgres-smoke.cjs"
            elif requirement_id in {"SP-DB-026", "SP-MG-013"}:
                evidence = "crates/stackport-core/src/schema_compare.rs; crates/stackport-core/tests/schema_compare.rs; src/SchemaComparisonDialog.tsx; src-tauri/src/main.rs; tests/sql-file-smoke.cjs"
            elif requirement_id in {"SP-MG-014", "SP-MG-018"}:
                evidence = "crates/stackport-core/src/schema_sync.rs; crates/stackport-core/tests/schema_sync.rs; src/SchemaComparisonDialog.tsx; src-tauri/src/main.rs; tests/sql-file-smoke.cjs"
            elif requirement_id in {"SP-MD-016", "SP-MD-020", "SP-MG-024"}:
                evidence = "crates/stackport-core/src/schema_document.rs; crates/stackport-core/tests/schema.rs; src/SchemaDocumentDialog.tsx; src-tauri/src/main.rs; tests/sql-file-smoke.cjs"
            elif requirement_id in {"SP-MG-001", "SP-MG-004", "SP-MG-006", "SP-MG-007", "SP-MG-026"}:
                evidence = "src/main.tsx; src/PostgresWorkspace.tsx"
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
            elif requirement_id == "SP-CN-015":
                evidence = "crates/stackport-core/src/ssh_transport.rs; crates/stackport-core/src/terminal/routed.rs; src/SshRouteDialog.tsx; src-tauri/src/main.rs; tests/sftp-smoke.cjs"
            elif requirement_id in {"SP-CN-017", "SP-CN-018", "SP-NW-007"}:
                evidence = "crates/stackport-core/src/ssh_tunnel.rs; crates/stackport-core/src/ssh_tunnel/runtime.rs; crates/stackport-core/tests/ssh_tunnel.rs; src/SshTunnelPanel.tsx; tests/ssh-tunnel-smoke.cjs"
            elif requirement_id == "SP-FL-001":
                evidence = "crates/stackport-core/src/ssh_transport.rs; crates/stackport-core/src/sftp.rs; src/SshRouteDialog.tsx; src-tauri/src/main.rs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-TM-002":
                evidence = "crates/stackport-core/src/ssh.rs; crates/stackport-core/src/terminal/routed.rs; src/TerminalWorkspace.tsx; tests/ssh-smoke.cjs; tests/sftp-smoke.cjs"
            elif requirement_id in {"SP-UI-001", "SP-UI-002", "SP-CN-001", "SP-CN-003", "SP-CN-023"}:
                evidence = "crates/stackport-core/tests/ssh_profiles.rs; crates/stackport-core/tests/workspace.rs; tests/ssh-smoke.cjs; src/; src-tauri/"
            elif requirement_id in {"SP-UI-012", "SP-ST-006", "SP-ST-017"}:
                evidence = "crates/stackport-core/src/workspace_resume.rs; crates/stackport-core/tests/workspace_resume.rs; tests/workspace-resume-smoke.cjs; src/WorkspaceResume.ts; src/main.tsx"
            elif requirement_id in {"SP-UI-015", "SP-ST-001"}:
                evidence = "src/appearance.ts; src/theme.css; src/styles.css; src/main.tsx; src/TerminalWorkspace.tsx; tests/appearance-smoke.cjs"
            elif requirement_id in {"SP-UI-006", "SP-UI-007", "SP-UI-016"}:
                evidence = "src/CommandPalette.tsx; src/WorkspaceNavigation.tsx; src/WorkspaceSplit.tsx; src/TerminalWorkspace.tsx; src/main.tsx; tests/desktop-smoke.cjs; tests/terminal-smoke.cjs"
            elif requirement_id == "SP-UI-004":
                evidence = "src/WorkspaceLayout.ts; src/WorkspaceSplit.tsx; src/main.tsx; tests/desktop-smoke.cjs; tests/terminal-smoke.cjs"
            elif requirement_id == "SP-UI-019":
                evidence = "src/WorkspaceExitDialog.tsx; src/SqlTabs.tsx; src/main.tsx; src/SftpEditorDialog.tsx; tests/sftp-smoke.cjs; tests/sql-file-smoke.cjs; tests/workspace-resume-smoke.cjs"
            elif requirement_id == "SP-UI-003":
                evidence = "src/SqlTabs.tsx; tests/sql-file-smoke.cjs; src/WorkspaceNavigation.tsx; src/TerminalWorkspace.tsx; src/TerminalTabDialog.tsx; tests/terminal-smoke.cjs; tests/ssh-smoke.cjs; tests/ssh-key-smoke.cjs; tests/rdp-smoke.cjs"
            elif requirement_id in {"SP-CN-005", "SP-CN-014"}:
                evidence = "crates/stackport-core/tests/ssh_exchange.rs; tests/ssh-profile-exchange-smoke.cjs; src/SshProfileExchange.tsx; crates/stackport-core/src/database_exchange.rs; crates/stackport-core/tests/database_exchange.rs; src/DatabaseProfileExchange.tsx; tests/desktop-smoke.cjs; src-tauri/"
            elif requirement_id == "SP-NW-001":
                evidence = "crates/stackport-core/tests/ports.rs; tests/ports-smoke.cjs; src/NetworkWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-NW-002":
                evidence = "crates/stackport-core/tests/network.rs; tests/ports-smoke.cjs; src/NetworkDiagnosticsPanel.tsx; src-tauri/"
            elif requirement_id == "SP-NW-003":
                evidence = "crates/stackport-core/tests/web_check.rs; tests/ports-smoke.cjs; src/WebDiagnosticResult.tsx; src-tauri/"
            elif requirement_id in {"SP-FL-006", "SP-FL-007", "SP-FL-021"}:
                evidence = "crates/stackport-core/src/sftp/download.rs; crates/stackport-core/src/sftp/upload.rs; crates/stackport-core/src/sftp/remote_stage.rs; crates/stackport-core/src/sftp/copy.rs; tests/sftp-smoke.cjs; src/SftpTransferStatus.tsx; src-tauri/"
            elif requirement_id == "SP-FL-010":
                evidence = "src/SftpPermissionsDialog.tsx; crates/stackport-core/src/sftp/permissions.rs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-011":
                evidence = "crates/stackport-core/src/sftp/preview.rs; crates/stackport-core/src/png_preview.rs; src/FilePreviewDialog.tsx; src/StructuredPreviewView.tsx; src/structuredFilePreview.ts; tests/structured-preview.test.mjs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-012":
                evidence = "src/CodeTextarea.tsx; src/editorSyntax.ts; src/SftpEditorDialog.tsx; crates/stackport-core/src/sftp/editor.rs; crates/stackport-core/tests/text_draft.rs; tests/editor-syntax.test.mjs; tests/sftp-smoke.cjs"
            elif requirement_id in {"SP-FL-013", "SP-AT-002", "SP-AT-003"}:
                evidence = "crates/stackport-core/src/sftp/editor.rs; crates/stackport-core/src/sftp/remote_stage.rs; crates/stackport-core/tests/text_draft.rs; tests/sftp-smoke.cjs; src/SftpEditorDialog.tsx"
            elif requirement_id == "SP-FL-014":
                evidence = "src/SftpExternalEditor.tsx; src/SftpEditorDialog.tsx; crates/stackport-core/src/sftp/editor/external.rs; tests/sftp-smoke.cjs"
            elif requirement_id in {"SP-FL-003", "SP-FL-024"}:
                evidence = "crates/stackport-core/src/sftp/mutation.rs; crates/stackport-core/src/sftp/copy.rs; crates/stackport-core/src/sftp/delete.rs; tests/sftp-smoke.cjs; src/SftpWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-FL-015":
                evidence = "src/FilePairCompareDialog.tsx; src/FileDifferenceDialog.tsx; src/FileMergeDialog.tsx; src/fileDifference.ts; src/FolderCompareDialog.tsx; crates/stackport-core/src/sftp/compare.rs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-016":
                evidence = "src/FolderCompareDialog.tsx; src/folderComparison.ts; src/FolderSyncPlanDialog.tsx; crates/stackport-core/src/sftp/folder_tree.rs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-017":
                evidence = "src/FolderSyncPlanDialog.tsx; src/folderSyncPlan.ts; crates/stackport-core/src/sftp/sync.rs; crates/stackport-core/src/sftp/sync_replace.rs; crates/stackport-core/src/sftp/sync_delete.rs; tests/folder-sync-plan.test.mjs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-018":
                evidence = "crates/stackport-core/src/terminal.rs; crates/stackport-core/tests/terminal.rs; src/terminalDirectory.ts; src/TerminalWorkspace.tsx; src/SftpWorkspace.tsx; tests/terminal-smoke.cjs; tests/sftp-smoke.cjs"
            elif requirement_id == "SP-FL-022":
                evidence = "crates/stackport-core/src/sftp/sync_profile.rs; crates/stackport-core/tests/migration.rs; src/FolderSyncProfilesDialog.tsx; src/FolderSyncPlanDialog.tsx; tests/sftp-smoke.cjs"
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
            elif requirement_id == "SP-SQ-001":
                evidence = "src/CodeTextarea.tsx; src/editorSyntax.ts; src/SqlTabs.tsx; src/SqlFileDialog.tsx; src/main.tsx; tests/editor-syntax.test.mjs; tests/sql-file-smoke.cjs; tests/sql-document-tabs.cjs; tests/workspace-resume-smoke.cjs"
            elif requirement_id == "SP-SQ-002":
                evidence = "crates/stackport-core/src/sql_completion.rs; src/sqlCompletion.ts; src/useEditorCompletion.ts; tests/sql-completion.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-003":
                evidence = "crates/stackport-core/src/sql_diagnostics.rs; crates/stackport-core/src/sql_statement.rs; src/SqlDiagnostics.tsx; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-004":
                evidence = "src/editorHover.tsx; src/sqlCompletion.ts; src/SqlDefinitionDialog.tsx; src/SqlSchemaDetails.tsx; crates/stackport-core/tests/schema.rs; tests/sql-completion.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-005":
                evidence = "src/sqlCompletion.ts; src/SqlAliasRenameDialog.tsx; crates/stackport-core/src/sql_refactor.rs; src/sqlFormatting.ts; tests/sql-completion.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-006":
                evidence = "src/sqlFormatting.ts; src/sqlFormatting.worker.ts; src/SqlFormatDialog.tsx; tests/sql-formatting.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id in {"SP-SQ-018", "SP-SQ-025"}:
                evidence = "crates/stackport-core/src/sql_file.rs; crates/stackport-core/tests/sql_file.rs; src/SqlFileDialog.tsx; src/SqlTabs.tsx; tests/sql-file-smoke.cjs; tests/sql-document-tabs.cjs"
            elif requirement_id == "SP-SQ-007":
                evidence = "src/main.tsx; crates/stackport-core/src/query.rs; crates/stackport-core/src/sql_statement.rs; crates/stackport-core/tests/sql_statement.rs; crates/stackport-core/tests/query_cancel.rs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-008":
                evidence = "src/main.tsx; crates/stackport-core/src/query.rs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-013":
                evidence = "src/main.tsx; src/SqlResultComparison.tsx; src/sqlResults.ts; tests/sql-results.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-012":
                evidence = "src/SqlQueryBuilderDialog.tsx; src/SqlBuilderClauses.tsx; src/sqlQueryBuilder.ts; tests/sql-query-builder.test.mjs; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-016":
                evidence = "crates/stackport-core/src/query.rs; crates/stackport-core/tests/table_query.rs; src/SqlQueryMetrics.tsx; tests/sql-file-smoke.cjs"
            elif requirement_id == "SP-SQ-017":
                evidence = "crates/stackport-core/src/sql_templates.rs; crates/stackport-core/tests/sql_templates.rs; src/SqlTemplateLibrary.tsx; src/SqlHistoryDialog.tsx; tests/sql-file-smoke.cjs; tests/postgres-smoke.cjs; tests/snowflake-editor-smoke.cjs"
            elif requirement_id == "SP-SQ-023":
                evidence = "src/main.tsx; src/sqlHistory.ts; src/SqlHistoryDialog.tsx; src/SqlTabs.tsx; crates/stackport-core/src/sql_risk.rs; tests/sql-history.test.mjs; tests/sql-file-smoke.cjs; tests/postgres-smoke.cjs; tests/mysql-smoke.cjs; tests/snowflake-editor-smoke.cjs"
            elif requirement_id in {"SP-MD-002", "SP-MD-006", "SP-MD-015", "SP-MD-019"}:
                evidence = "crates/stackport-core/src/schema_diagram.rs; crates/stackport-core/src/postgres/diagram.rs; crates/stackport-core/tests/schema.rs; src/sqlSchemaDiagram.ts; src/SqlSchemaDiagramDialog.tsx; src/PostgresSchemaDiagramDialog.tsx; tests/sql-schema-diagram.test.mjs; tests/sql-file-smoke.cjs; tests/postgres-smoke.cjs"
            elif requirement_id in {"SP-SQ-010", "SP-SQ-014", "SP-SQ-015", "SP-AT-011"}:
                evidence = "crates/stackport-core/tests/query_parameters.rs; crates/stackport-core/tests/query_cancel.rs; tests/desktop-smoke.cjs; src/SqlParameterFields.tsx; src/SqliteQueryPlan.tsx; src-tauri/"
            elif requirement_id == "SP-CN-008":
                evidence = "crates/stackport-core/src/ssh.rs; tests/ssh-key-smoke.cjs; src/TerminalWorkspace.tsx; src-tauri/"
            elif requirement_id == "SP-SEC-004":
                evidence = "crates/stackport-core/src/ssh.rs; crates/stackport-core/src/web_check/windows.rs; crates/stackport-core/src/rdp.rs; tests/ssh-smoke.cjs; tests/ports-smoke.cjs; tests/rdp-smoke.cjs"
            elif requirement_id == "SP-UI-008":
                evidence = "src/quickConnect.ts; src/QuickConnectDialog.tsx; src/main.tsx; src/TerminalWorkspace.tsx; src/RdpWorkspace.tsx; src/PostgresProfileDialog.tsx; tests/quick-connect.test.mjs; tests/desktop-smoke.cjs; tests/postgres-smoke.cjs"
            elif requirement_id in {"SP-CN-007", "SP-CN-009", "SP-CN-010", "SP-CN-024", "SP-SEC-008", "SP-AT-001"}:
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
            if requirement_id in {
                "SP-UI-002", "SP-UI-006", "SP-UI-011", "SP-CN-001", "SP-CN-003", "SP-CN-011", "SP-CN-012",
                "SP-CN-023", "SP-DB-001", "SP-DB-004", "SP-DB-005", "SP-DB-006", "SP-DB-007", "SP-DB-009",
                "SP-DB-010", "SP-DB-021", "SP-DB-022", "SP-DB-028", "SP-DB-029", "SP-DT-001",
                "SP-DT-006",
            }:
                evidence += "; crates/stackport-core/src/postgres/; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-UI-001", "SP-UI-002", "SP-UI-006"}:
                evidence += "; src/WorkspaceExplorer.tsx; src/workspaceExplorer.css"
                if requirement_id != "SP-UI-006":
                    evidence += "; tests/desktop-smoke.cjs"
            if requirement_id in {"SP-UI-006", "SP-UI-009", "SP-ST-006"}:
                evidence += "; src/workspaceFavorites.ts; crates/stackport-core/src/workspace_favorites.rs; crates/stackport-core/tests/workspace_favorites.rs; tests/workspace-resume-smoke.cjs"
                if requirement_id == "SP-UI-009":
                    evidence += "; src/WorkspaceExplorer.tsx; src/PostgresWorkspace.tsx; tests/desktop-smoke.cjs; tests/postgres-smoke.cjs"
            if requirement_id == "SP-UI-014":
                evidence += "; src/WorkspaceStatus.tsx; tests/terminal-smoke.cjs; tests/rdp-smoke.cjs; tests/ssh-tunnel-smoke.cjs"
            if requirement_id in {"SP-DT-003", "SP-DT-004", "SP-DT-006"}:
                evidence += "; crates/stackport-core/src/edit/row.rs; crates/stackport-core/src/postgres/edit/row.rs; src/RowChangeDialog.tsx"
            if requirement_id in {"SP-DT-003", "SP-DT-004", "SP-DT-006", "SP-DT-022"}:
                evidence += "; src/GridPasteDialog.tsx; crates/stackport-core/src/postgres/edit/row/paste.rs; tests/structured-preview.test.mjs; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-DT-003", "SP-DT-006"}:
                evidence += "; src/GridRowSelection.tsx; src/structuredFilePreview.ts"
            if requirement_id in {"SP-DT-003", "SP-DT-004", "SP-DT-018", "SP-DT-022", "SP-AT-010"}:
                evidence += "; crates/stackport-core/src/edit.rs; src/SqliteEditDialog.tsx"
            if requirement_id in {"SP-DT-003", "SP-DT-004", "SP-DT-022", "SP-AT-010"}:
                evidence += "; crates/stackport-core/src/postgres/edit/grid.rs; src/PostgresEditDialog.tsx"
            if requirement_id in {"SP-DB-010", "SP-DB-014", "SP-DB-017", "SP-DB-018", "SP-DB-020", "SP-DB-022"}:
                evidence += "; crates/stackport-core/src/postgres/catalog.rs; src/PostgresObjectStructure.tsx"
                if requirement_id in {"SP-DB-014", "SP-DB-018"}:
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-DB-010", "SP-DB-014", "SP-DB-018", "SP-DB-022"}:
                evidence += "; crates/stackport-core/src/mysql/structure.rs; src/MysqlObjectStructure.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DB-014", "SP-DB-022"}:
                evidence += "; src/ObjectDefinitionPanel.tsx; crates/stackport-core/src/sql_file.rs; tests/sql-server-smoke.cjs; tests/oracle-smoke.cjs; crates/stackport-core/src/snowflake/api/tests.rs"
                evidence += "; crates/stackport-core/src/sql_server/definition.rs; crates/stackport-core/src/sql_server/table_definition.sql"
            if requirement_id in {"SP-DB-010", "SP-DB-018", "SP-DB-022"}:
                evidence += "; crates/stackport-core/src/sql_server/structure.rs; src/SqlServerObjectStructure.tsx"
                if requirement_id != "SP-DB-022":
                    evidence += "; tests/sql-server-smoke.cjs"
            if requirement_id == "SP-DB-021":
                evidence += "; crates/stackport-core/src/postgres/search.rs; src/PostgresSearchDialog.tsx"
                evidence += "; crates/stackport-core/src/relational_object_search.rs; crates/stackport-core/src/snowflake/catalog.rs; src/RelationalWorkspace.tsx; tests/sql-server-smoke.cjs; tests/oracle-smoke.cjs"
            if requirement_id in {"SP-DB-024", "SP-SQ-016"}:
                evidence += "; crates/stackport-core/src/postgres/statement_stats.rs; src/PostgresStatementStats.tsx"
            if requirement_id in {"SP-DB-023", "SP-DB-024", "SP-DB-025"}:
                evidence += "; crates/stackport-core/src/mysql/monitor.rs; src/MysqlServerMonitor.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DT-010", "SP-DT-011"}:
                evidence += "; crates/stackport-core/src/table_query.rs; crates/stackport-core/src/postgres/session.rs; src/PostgresWorkspace.tsx; tests/postgres-smoke.cjs"
                evidence += "; crates/stackport-core/src/table_query_presets.rs; src/TableQueryPresetsDialog.tsx"
            if requirement_id in {"SP-DT-001", "SP-DT-010", "SP-DT-011", "SP-DT-017"}:
                evidence += "; crates/stackport-core/src/mysql.rs; crates/stackport-core/src/mysql/grid.rs; src/MysqlWorkspace.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DT-001", "SP-DT-010", "SP-DT-011"}:
                evidence += "; src/RelationalWorkspace.tsx; crates/stackport-core/src/snowflake/catalog.rs; tests/sql-server-smoke.cjs; tests/oracle-smoke.cjs"
            if requirement_id in {
                "SP-DB-001", "SP-DB-028", "SP-DT-003", "SP-DT-004", "SP-DT-005", "SP-DT-006", "SP-DT-007",
                "SP-DT-020", "SP-DT-021", "SP-DT-022", "SP-DT-024", "SP-SEC-015", "SP-AT-010",
            }:
                evidence += "; crates/stackport-core/src/postgres/edit.rs; src/PostgresEditDialog.tsx"
                if requirement_id not in {"SP-DB-001", "SP-DB-028", "SP-DT-006"}:
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-CN-001", "SP-CN-003", "SP-UI-011", "SP-AT-025"}:
                evidence += "; crates/stackport-core/tests/postgres_profiles.rs"
            if requirement_id == "SP-CN-003":
                evidence += "; src/profileActions.ts; tests/profile-actions.test.mjs; tests/desktop-smoke.cjs"
            if requirement_id in {
                "SP-UI-014", "SP-UI-019", "SP-SQ-001", "SP-SQ-003", "SP-SQ-007", "SP-SQ-008", "SP-SQ-009",
                "SP-SQ-018", "SP-SQ-022", "SP-SQ-025", "SP-SQ-026",
            }:
                evidence += "; crates/stackport-core/src/postgres/sql.rs; src/PostgresSqlWorkspace.tsx; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-SQ-010", "SP-AT-011"}:
                evidence += "; crates/stackport-core/src/postgres/parameters.rs; src/PostgresParameterDialog.tsx; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-SQ-022", "SP-SEC-003", "SP-SEC-015"}:
                evidence += "; crates/stackport-core/src/sql_risk.rs; src/SqlRiskReview.tsx; tests/sql-server-smoke.cjs; tests/snowflake-editor-smoke.cjs"
            if requirement_id in {"SP-SQ-014", "SP-SQ-015", "SP-SQ-016", "SP-AT-011"}:
                evidence += "; crates/stackport-core/src/postgres/plan.rs; src/PostgresQueryPlan.tsx"
                if requirement_id != "SP-AT-011":
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-DB-022", "SP-MG-002", "SP-MG-005", "SP-MG-008", "SP-SEC-011"}:
                evidence += "; crates/stackport-core/src/postgres/export.rs; src/PostgresResultExport.tsx"
                if requirement_id != "SP-DB-022":
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-SQ-008", "SP-MG-002", "SP-MG-008", "SP-SEC-011"}:
                evidence += "; crates/stackport-core/src/postgres/sql/script/export_io.rs; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-DB-022", "SP-SQ-008", "SP-MG-002", "SP-MG-008", "SP-MG-028", "SP-SEC-011"}:
                evidence += "; crates/stackport-core/src/mysql/export.rs; src/MysqlResultExport.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DB-022", "SP-MG-002", "SP-MG-005", "SP-MG-008", "SP-SEC-011"}:
                evidence += "; crates/stackport-core/src/sql_server/export.rs; crates/stackport-core/src/oracle/export.rs; crates/stackport-core/src/snowflake/export.rs; crates/stackport-core/src/snowflake/export/stream.rs; src/ResultExportDialog.tsx"
                if "tests/sql-server-smoke.cjs" not in evidence:
                    evidence += "; tests/sql-server-smoke.cjs"
                if "tests/oracle-smoke.cjs" not in evidence:
                    evidence += "; tests/oracle-smoke.cjs"
                for path in ("crates/stackport-core/src/snowflake/api/tests.rs", "tests/snowflake-smoke.cjs"):
                    if path not in evidence:
                        evidence += f"; {path}"
            if requirement_id in {"SP-MG-001", "SP-MG-004", "SP-MG-005", "SP-MG-006", "SP-MG-007", "SP-MG-026", "SP-MG-028"}:
                evidence += "; src/GridPasteDialog.tsx; src/structuredFilePreview.ts; crates/stackport-core/src/edit/row.rs; crates/stackport-core/src/postgres/edit/row/paste.rs; crates/stackport-core/tests/edit.rs; tests/structured-preview.test.mjs"
                if requirement_id not in {"SP-MG-005", "SP-MG-028"}:
                    evidence += "; tests/desktop-smoke.cjs"
                if requirement_id != "SP-MG-005":
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-MG-001", "SP-MG-004", "SP-MG-005", "SP-MG-007"}:
                evidence += "; crates/stackport-core/src/json_import.rs; crates/stackport-core/tests/json_import.rs; src/xmlGridImport.ts"
                if requirement_id == "SP-MG-005":
                    evidence += "; tests/desktop-smoke.cjs"
            if requirement_id in {"SP-BK-001", "SP-BK-002", "SP-BK-003", "SP-BK-014", "SP-AT-016"}:
                evidence += "; crates/stackport-core/src/postgres/backup.rs; src/PostgresBackupDialog.tsx; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-BK-005", "SP-BK-013", "SP-BK-014", "SP-BK-017", "SP-AT-016"}:
                evidence += "; crates/stackport-core/src/postgres/restore.rs; src/PostgresRestoreDialog.tsx"
                if requirement_id == "SP-BK-013":
                    evidence += "; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-UI-002", "SP-CN-001", "SP-CN-003", "SP-DB-001"}:
                evidence += "; src/RedisProfileDialog.tsx; crates/stackport-core/tests/redis_profiles.rs; tests/redis-smoke.cjs"
            if requirement_id in {"SP-UI-002", "SP-DB-001", "SP-DB-005", "SP-AT-018"}:
                evidence += "; crates/stackport-core/src/mongo.rs; src/MongoProfileDialog.tsx; tests/mongo-smoke.cjs"
            if requirement_id in {"SP-DB-001", "SP-NS-018", "SP-SEC-011", "SP-SEC-015", "SP-AT-018"}:
                evidence += "; crates/stackport-core/src/mongo/document_edit.rs; src/MongoDocumentEditDialog.tsx"
                if requirement_id in {"SP-NS-018", "SP-SEC-011", "SP-SEC-015"}:
                    evidence += "; tests/mongo-smoke.cjs"
            if requirement_id in {"SP-UI-002", "SP-DB-001", "SP-DB-004", "SP-DB-005", "SP-DB-006", "SP-DB-007", "SP-DB-009", "SP-DB-010"}:
                evidence += "; crates/stackport-core/src/sql_server.rs; crates/stackport-core/src/sql_server/catalog.rs; src/RelationalWorkspace.tsx; tests/sql-server-smoke.cjs"
                evidence += "; crates/stackport-core/src/oracle.rs; crates/stackport-core/src/oracle/catalog.rs; src/OracleProfileDialog.tsx; tests/oracle-smoke.cjs"
                evidence += "; crates/stackport-core/src/snowflake.rs; crates/stackport-core/src/snowflake/api/tests.rs; src/SnowflakeProfileDialog.tsx; tests/snowflake-smoke.cjs"
            if requirement_id in {"SP-UI-002", "SP-DB-001", "SP-DB-004", "SP-DB-005", "SP-DB-006", "SP-DB-007", "SP-DB-009", "SP-DB-010", "SP-DB-022"}:
                evidence += "; crates/stackport-core/src/mysql.rs; crates/stackport-core/tests/mysql_profiles.rs; src/MysqlWorkspace.tsx; tests/mysql-smoke.cjs"
            if requirement_id == "SP-AT-006":
                evidence += "; crates/stackport-core/src/mysql.rs; src/MysqlWorkspace.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-CN-011", "SP-DB-005"}:
                evidence += "; crates/stackport-core/src/mysql/tls.rs; src/MysqlProfileDialog.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-SQ-014", "SP-SQ-015", "SP-AT-011"}:
                evidence += "; crates/stackport-core/src/mysql/plan.rs; src/MysqlQueryPlan.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DT-003", "SP-DT-004", "SP-DT-005", "SP-DT-006", "SP-DT-020", "SP-DT-021", "SP-DT-022", "SP-DT-024", "SP-SEC-015", "SP-AT-010"}:
                evidence += "; crates/stackport-core/src/mysql/edit.rs; src/MysqlGridEditDialog.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-SQ-001", "SP-SQ-007", "SP-SQ-008", "SP-SQ-009", "SP-SQ-010", "SP-SQ-014"}:
                evidence += "; crates/stackport-core/src/mysql/sql.rs; src/MysqlSqlWorkspace.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-SQ-007", "SP-SQ-008", "SP-SQ-009", "SP-SQ-010", "SP-SQ-011", "SP-SEC-011", "SP-SEC-015"}:
                evidence += "; crates/stackport-core/src/postgres/sql/script.rs; src/PostgresScriptResults.tsx; tests/postgres-smoke.cjs"
            if requirement_id in {"SP-DB-001", "SP-SQ-007", "SP-SQ-008", "SP-SQ-009", "SP-SQ-010", "SP-SQ-011", "SP-SEC-011", "SP-SEC-015"}:
                evidence += "; crates/stackport-core/src/mysql/sql/script.rs; crates/stackport-core/src/mysql/sql/execution.rs; src/MysqlScriptResults.tsx; tests/mysql-smoke.cjs"
            if requirement_id in {"SP-DB-001", "SP-SQ-001", "SP-SQ-007", "SP-SQ-008", "SP-SQ-009", "SP-SQ-011", "SP-SEC-011"}:
                evidence += "; crates/stackport-core/src/sql_server/query.rs; src/SqlServerSqlWorkspace.tsx; tests/sql-server-smoke.cjs"
                evidence += "; crates/stackport-core/src/oracle/query.rs; src/RelationalScriptWorkspace.tsx; tests/oracle-smoke.cjs"
                evidence += "; crates/stackport-core/src/snowflake/query.rs; crates/stackport-core/src/snowflake/api/tests/sql_editor.rs; tests/snowflake-editor-smoke.cjs"
            if requirement_id == "SP-SQ-010":
                evidence += "; crates/stackport-core/src/sql_parameter_sets.rs; src/SqlParameterSets.tsx; crates/stackport-core/tests/query_parameters.rs"
            if requirement_id == "SP-SQ-010":
                evidence += "; crates/stackport-core/src/sql_server/query/parameters.rs; src/SqlParameterFields.tsx; tests/sql-server-smoke.cjs"
                evidence += "; crates/stackport-core/src/oracle/query/parameters.rs; src/RelationalScriptWorkspace.tsx; tests/oracle-smoke.cjs"
                evidence += "; crates/stackport-core/src/snowflake/query/parameters.rs; crates/stackport-core/src/snowflake/api/tests/sql_editor.rs; tests/snowflake-editor-smoke.cjs"
            if requirement_id in {"SP-NS-011", "SP-NS-018", "SP-SEC-011", "SP-SEC-015", "SP-AT-018"}:
                evidence += "; crates/stackport-core/src/redis/edit.rs; src/RedisEditDialog.tsx"
                if requirement_id in {"SP-SEC-011", "SP-SEC-015"}:
                    evidence += "; tests/redis-smoke.cjs"
            if requirement_id in {"SP-NS-010", "SP-NS-011", "SP-NS-017", "SP-AT-018"}:
                evidence += "; crates/stackport-core/src/redis/json.rs"
            if requirement_id == "SP-NS-014":
                evidence += "; crates/stackport-core/src/redis/monitor.rs; src/RedisServerMonitor.tsx"
            if requirement_id == "SP-NS-012":
                evidence += "; crates/stackport-core/src/redis/console.rs; src/RedisConsoleDialog.tsx"
            if requirement_id in {"SP-NS-013", "SP-AT-018"}:
                evidence += "; crates/stackport-core/src/redis/pubsub.rs; src/RedisPubSubDialog.tsx"
        writer.writerow([requirement_id, title, detail, "partial" if subset else "not_started", subset, evidence])
print(f"{len(items)} requirements written to {OUTPUT}")
