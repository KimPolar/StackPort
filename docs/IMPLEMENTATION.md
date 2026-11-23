# 구현 현황과 경계

기준 명세는 `StackPort_Functional_Spec_KO.md`입니다. `requirements.csv`는 명세의 SP 요구사항과 수용 테스트를 기계적으로 추출한 목록입니다. `partial`은 일부 동작만 존재한다는 의미이며 해당 요구사항이나 수용 테스트가 완료되었다는 뜻이 아닙니다. 목록은 `python tools/generate_requirement_inventory.py`로 다시 생성합니다.

## 구성

React/TypeScript 화면은 Tauri 명령을 통해 Rust 코어를 호출합니다. 네트워크·파일 처리와 장시간 SQL은 웹 UI에서 직접 수행하지 않고 별도 작업 스레드로 넘깁니다. 브라우저에는 네이티브 명령이나 임의 TCP 프록시를 제공하지 않습니다. 게이트웨이 인증 및 접근 제어는 아직 구현하지 않았습니다.

Windows 로컬 터미널은 ConPTY와 xterm.js를 사용하며 PowerShell(`-NoProfile`) 또는 CMD(`/D`) 세션을 별도 탭으로 엽니다. 입력·출력은 StackPort가 파일이나 감사 기록에 저장하지 않지만 셸과 실행 프로그램의 자체 기록은 별도입니다. 화면을 숨겨도 세션을 유지하며 출력 대기열은 유한한 크기로 제한하고 밀리면 프로세스에 역압을 적용합니다. 창 크기는 PTY에 전달하고, 여러 줄 붙여넣기 및 탭·앱 종료 시 확인합니다. Windows 작업 개체에 연결된 프로세스는 탭이나 앱을 닫을 때 정리합니다. Windows 10 1809 이상의 ConPTY가 필요하며 WSL·사용자 지정 셸, 재연결, 명령 기록 관리와 다른 OS 검증은 아직 없습니다.

각 터미널 탭의 현재 화면과 최대 10,000줄 메모리 스크롤백을 일반 문자열로 검색할 수 있습니다. 이전·다음 이동, 대소문자 구분과 `Ctrl+Shift+F`를 지원합니다. 검색어는 해당 탭에만 보관하고 검색을 닫거나 탭이 종료되면 지웁니다. 정규식 검색, 출력의 디스크 저장과 이미 스크롤백에서 밀려난 내용의 복구는 제공하지 않습니다.

Windows SSH는 시스템 OpenSSH의 `ssh-keyscan`으로 대상의 공개 키 후보를 조회합니다. 이 조회 자체는 서버를 인증하지 않으므로 사용자가 별도의 경로로 SHA-256 지문을 비교해 하나를 선택해야 합니다. 확인한 키는 앱 데이터의 별도 `ssh-trust.sqlite`에 호스트·포트별로 저장하며 암호와 개인 키는 저장하지 않습니다. 실제 접속에서는 선택한 키만 들어 있는 임시 파일과 [OpenSSH의 엄격한 호스트 키 검사](https://man.openbsd.org/ssh_config#StrictHostKeyChecking)를 사용합니다. 개인·시스템 SSH 설정은 읽지 않으며 프록시·포워딩을 자동 실행하지 않습니다. 키가 달라지면 인증 전에 차단되고, 별도 재조회와 `교체` 확인 후에만 기존 키를 원자적으로 교체합니다. 신뢰·교체 이력은 호스트·포트·이전/새 지문과 함께 같은 트랜잭션에 기록하며 작업 기록 화면에서 조회할 수 있습니다. 저장소의 변조 방지와 자동 백업은 아직 없습니다. 정상 종료 시 임시 키 파일은 삭제되지만 앱이 강제 종료되면 공개 키만 포함된 파일이 남을 수 있습니다.

SSH는 현재 Windows OpenSSH와 영문 호스트/IP·영문 사용자 이름만 지원합니다. 호스트 키는 Ed25519, ECDSA 및 RSA-SHA2를 지원하며 서버 인증서는 아직 지원하지 않습니다. 프로젝트별 연결 정의에 이름·호스트·포트·사용자·환경을 저장하고 수정·삭제할 수 있습니다. 동시 수정은 버전으로 감지하고 연결 시 확인한 정의가 바뀌었으면 접속을 중단합니다. 저장된 `PROD` 연결은 서버 측에서 `PROD` 입력을 확인하고 터미널에 환경을 표시합니다. 직접 입력한 임시 연결은 환경 미지정이며 저장된 연결의 운영 환경 확인이 적용되지 않으므로 전체 호스트에 대한 접근 정책이 아닙니다. 연결 정의 삭제와 호스트 키 교체는 이미 열린 세션을 종료하지 않습니다. 암호는 터미널에서 직접 입력하고 암호 인증 프롬프트는 한 번으로 제한합니다. 자동 인증은 기본 키와 에이전트를 OpenSSH에 맡깁니다. 세션에서 키 파일 하나를 지정하면 해당 키만 허용하고 암호·대화형 인증으로 전환하지 않습니다. 암호화된 키의 암호는 터미널에 직접 입력하며 키 경로와 암호는 저장하지 않습니다. OpenSSH의 경로 확장을 피하기 위해 키 경로의 `%`와 `${...}`는 거절합니다. 에이전트에 등록된 공개 키 파일 사용은 OpenSSH에 의존하며 별도 실서버 검증이 필요합니다. 여러 키 동시 선택, ProxyJump·터널·SFTP, 자동 재연결과 다른 OS 검증은 아직 없습니다. 사용자 지정 SSH 설정은 보안 정책을 우회하지 않도록 적용하지 않습니다.

SSH 연결 화면의 선택적 네트워크 진단은 DNS 결과와 TCP 연결 성공·거부·시간 초과를 구분하고 시도한 주소별 결과를 표시합니다. 최대 8개 주소를 대상으로 DNS 4초, TCP 전체 4초와 주소별 1초를 적용합니다. 연결은 즉시 닫고 데이터를 전송하지 않으며 호스트 키·SSH 핸드셰이크·인증·서버 권한을 검사하지 않습니다. 서버에 접속 시도 기록이 남을 수 있습니다. OS의 DNS 조회는 중단할 수 없으므로 시간 초과 뒤에도 최대 4개의 조회 스레드가 남을 수 있습니다. 이 한도에 도달하면 추가 조회를 시작하지 않고 이전 조회가 진행 중이라고 표시합니다. 진단 요청은 동시에 최대 4개로 제한합니다. ping·경로 추적과 다른 프로토콜의 진단은 아직 없습니다.

선택한 SSH 연결은 자격 증명과 호스트 키 신뢰 기록 없이 JSON 파일로 교환할 수 있습니다. 내보내기는 선택 시점 이후 정의가 변경되면 중단하며 기존 파일을 덮어쓰지 않습니다. 가져오기는 파일을 검증하고 선택한 항목만 새 ID로 원자적으로 추가합니다. 미리보기 이후 파일이 변경되면 재확인이 필요하고 같은 이름의 기존 연결은 수정하지 않습니다. 가져오기와 내보내기는 작업 기록에 남기되 파일 경로와 연결 값은 기록하지 않습니다.

로컬 메타데이터는 SQLite 트랜잭션, 외래 키, 스키마 버전을 사용합니다. 버전 1·2에서 3으로 이관하기 전 원본과 같은 폴더에 SQLite 스냅샷을 생성하고 무결성과 버전을 검사합니다. 이관 실패 시 원본 트랜잭션을 롤백하고 백업을 보존합니다. 지원하지 않는 버전이나 비어 있지 않은 미버전 파일은 변경하지 않고 거절합니다. 백업을 통한 자동 복구는 아직 구현하지 않았습니다. SSH 연결 정의의 동시 수정은 감지하여 거절하며 자동 병합하지 않습니다. 프로젝트 삭제는 연결 정의도 삭제하지만 원본 DB 파일과 열린 SSH 세션은 건드리지 않습니다. 자격 증명 모델과 보안 저장소는 아직 없습니다.

프로젝트·연결 정의 변경은 메타데이터와 감사 이벤트를 같은 트랜잭션에 저장합니다. SQLite 백업과 셀 변경은 시작과 완료·실패를 별도 이벤트로 기록합니다. 작업이 성공한 뒤 완료 기록이 실패하면 작업 성공과 기록 실패를 함께 표시합니다. 이벤트에는 ID, UTC 시각, 로컬 사용자 표시, 작업 종류, 대상 ID, 환경, 결과, 정책과 영향 개수를 저장하며 SQL, 행 값, 파일 경로와 자격 증명은 저장하지 않습니다. 개별 OS 사용자 식별, 변조 방지와 보존 기간 설정은 아직 없습니다. 앱이 작업 완료와 기록 저장 사이에 비정상 종료되면 시작 이벤트만 남을 수 있습니다.

SQLite SQL 조회는 기존 파일을 읽기 전용으로 열고 `query_only`와 SQLite authorizer를 함께 사용합니다. 임의 SQL의 첨부·PRAGMA·쓰기와 확장 로딩은 거부합니다. 요청별 연결은 작업 종료 시 닫힙니다. 중단 요청은 해당 SQLite 연결에 인터럽트를 보내며 실행 결과로 중단·시간 초과·완료를 구분합니다. 10초 제한은 SQLite 진행 콜백에서 확인하므로 긴 단일 연산·파일 I/O·잠금 대기 중에는 실제 중단이 지연될 수 있습니다. SQL과 원본 행은 로그에 기록하지 않으며 초안은 현재 프로세스의 메모리에만 둡니다. 결과는 한 번에 최대 100행을 반환하고 추가 행 존재 여부를 별도로 표시합니다. OFFSET 페이지는 조회 중 원본이 바뀌거나 순서가 불안정하면 중복·누락될 수 있습니다.

단일 셀 변경은 별도의 수명 5분인 메모리 편집 세션에서 현재 행을 다시 읽고 전체 행의 SHA-256 지문을 보관합니다. 미리보기와 적용 시 행·구조·파일 식별을 다시 확인하고 `BEGIN IMMEDIATE` 트랜잭션에서 값과 다른 열을 검증합니다. 제약 위반이나 SQLite의 형식 변환은 롤백하며, 커밋 결과가 불명확하면 재시도 전에 재조회를 안내합니다. 기본 키가 없거나 NULL/BLOB 기본 키인 행, 트리거·생성/숨김 열이 있는 테이블, 가상 테이블, 키·고유 열, BLOB·긴 값은 편집하지 않습니다. `PROD`는 별도 텍스트 확인이 필요합니다. 편집 계획과 값은 로그에 저장하지 않고 세션 종료·만료 시 가능한 범위에서 메모리를 지웁니다. 여러 셀의 일괄 편집, 행 추가·삭제와 자동 되돌리기는 아직 없습니다.

테이블·뷰의 열, 복합 기본 키, 생성 열, 인덱스, 외래 키 및 생성 SQL을 확인할 수 있습니다. 구조 조회는 별도의 읽기 전용 연결에서 허용 목록에 있는 메타데이터 PRAGMA만 실행하며 객체 이름은 바인딩합니다. 일반 SQL 입력에는 이 권한을 부여하지 않습니다. 표시한 구조는 조회 시점의 값입니다.

SQLite 백업은 온라인 백업 API를 사용해 WAL을 포함한 일관된 스냅샷을 대상 폴더의 임시 파일에 만듭니다. 독립 파일로 전환한 뒤 `integrity_check`를 통과하면 동기화하고 기존 파일을 교체하지 않는 방식으로 저장합니다. 실패 시 최종 경로에 불완전한 파일을 게시하지 않습니다. 백업은 암호화되지 않으며 무결성 검사는 사용자가 별도 환경에서 수행하는 복원 테스트와 구분합니다.

## 현재 증거

- `crates/stackport-core/tests/workspace.rs`: 실제 임시 SQLite 파일을 사용해 프로젝트 지속성·삭제, 객체 조회, 페이지 경계, 쓰기·첨부 거부, 유효하지 않은 파일, 새 스키마 버전 보존 및 큰 텍스트 표시를 검사합니다.
- `crates/stackport-core/tests/backup.rs`: WAL 스냅샷을 독립 DB로 열어 데이터와 인덱스를 검사하고, 덮어쓰기 및 실패 시 부분 파일 생성을 방지하는지 검사합니다.
- `crates/stackport-core/tests/schema.rs`: 복합 키·생성 열·표현식 인덱스·외래 키와 이름 바인딩, 일반 쿼리의 메타데이터 PRAGMA 차단을 검사합니다.
- `crates/stackport-core/tests/migration.rs`: 이전 형식 백업·이관, 이관 실패 시 원본 보존과 동시 초기화·이관을 검사합니다.
- `crates/stackport-core/tests/ssh_profiles.rs`: SSH 연결 정의의 저장·검증, 동시 수정 충돌, 감사 기록의 원자성과 프로젝트 삭제를 검사합니다.
- `crates/stackport-core/tests/ssh_exchange.rs`: 선택한 연결의 교환, 형식·크기 검증, 파일 변경 감지, 덮어쓰기 방지와 가져오기 롤백을 검사합니다.
- `crates/stackport-core/tests/network.rs`와 `crates/stackport-core/src/network.rs` 단위 테스트: 로컬 DNS·TCP 단계 구분, 데이터 미전송, 연결 실패와 DNS 시간 초과 시 동시성 제한을 검사합니다.
- `crates/stackport-core/tests/audit.rs`: 감사 기록과 메타데이터 변경의 원자성, 백업 완료 기록 실패, 개인정보 제외와 안정적인 페이지 이동을 검사합니다.
- `crates/stackport-core/tests/edit.rs`: 미리보기의 비변경, 운영 환경 확인, 동시 변경·파일 교체·구조 변경 충돌, 트랜잭션 롤백과 감사 실패를 실제 파일로 검사합니다.
- `crates/stackport-core/tests/query_cancel.rs`와 `crates/stackport-core/src/query.rs` 단위 테스트: 실행 전·실행 중 중단, 시간 초과, 요청 재사용 방지와 독립 조회를 검사합니다.
- `crates/stackport-core/tests/terminal.rs`: 실제 Windows CMD 입출력·크기 변경·종료 코드, 하위 프로세스 종료와 입출력이 막힌 상태에서의 종료를 검사합니다.
- `crates/stackport-core/src/ssh.rs` 단위 테스트: 대상 검증, 지문 선택·만료, 신뢰 키의 동시 변경 차단, 이력 저장 실패 시 롤백과 손상된 저장소 거부를 검사합니다.
- `tests/desktop-smoke.cjs`: 독립된 테스트 앱과 실제 SQLite 파일에 연결하여 조회 중단·재조회, 단일 셀 미리보기·적용·동시 수정 차단, 운영 환경 확인, 백업 생성·재조회 및 작업 기록을 검사합니다.
- `tests/terminal-smoke.cjs`: 격리된 Windows 앱에서 PowerShell·CMD와 한글 입력·24비트 색상 출력, 탭별 스크롤백 검색, 탭 전환·키보드 이동, 여러 줄 붙여넣기 거부와 창 종료 확인을 검사합니다. 실제 IME 조합 입력과 스크린 리더 사용성은 별도 검증이 필요합니다.
- `tests/ssh-smoke.cjs`: 루프백 SSH 서버에서 DNS·TCP 진단과 인증 미시도, 지문 대조, 암호 로그인·재접속, 인증 재시도 제한, 키 변경 차단·명시적 교체·이전 키 차단, 저장된 운영 연결의 확인과 정의 변경 충돌 및 신뢰 기록을 검사합니다. 다른 SSH 서버·인증 방식은 별도 검증이 필요합니다.
- `tests/ssh-key-smoke.cjs`: 합성 암호화 RSA 키와 루프백 SSH 서버에서 지문 고정, 키 암호 입력, 지정 키 실패 시 암호 인증 차단, 저장된 운영 연결 및 자격 증명 비저장을 검사합니다.
- `tests/ssh-profile-exchange-smoke.cjs`: 격리된 앱에서 선택 내보내기, 덮어쓰기 방지, 파일 변경 후 재확인, 선택 가져오기와 작업 기록을 검사합니다.
- `npm run build`: 프런트엔드 타입 검사와 배포용 번들 생성.
- `cargo check --manifest-path src-tauri/Cargo.toml`: 네이티브 명령과 Tauri 호스트 컴파일 검사.

이 검사는 원격 프로토콜이나 명세의 전체 E2E 수용 테스트를 대체하지 않습니다. 서명된 설치 파일, 실제 원격 서버, 장애 복구, 다중 OS, 접근성 및 보안 경계 전체에 대한 검증이 추가로 필요합니다.

GitHub Actions의 Windows 릴리즈 작업은 `main` 푸시와 수동 실행마다 빌드·테스트 후 SemVer 태그, 실행 파일과 SHA-256 체크섬을 게시합니다. 버전 계산과 파일 반영은 `tools/release-version.mjs`에서 수행하며 `tests/release-version.test.mjs`가 버전 증가, 실제 Git 태그와 재시도 충돌을 검사합니다. 실행들은 최대 100개까지 대기열에 보관하고 순서대로 처리합니다. 한 실행의 실패는 릴리즈를 게시하지 않으며 실패 지점에 따라 같은 실행의 태그나 초안이 남을 수 있습니다. 재시도 시 해당 실행이 만든 태그·초안만 이어서 사용하고 기존 파일이 다르면 덮어쓰지 않습니다. 자동으로 `main`을 수정하지 않으므로 소스의 버전 필드는 기준 버전이며 EXE에는 해당 실행에서 계산한 릴리즈 버전을 적용합니다.

## SSH 연결 교환 형식

현재 형식은 UTF-8 JSON이며 `format`은 `stackport.ssh-profiles`, `version`은 숫자 `1`입니다. 파일 하나에 연결을 1~200개, 최대 1 MiB까지 담습니다. 각 연결은 `name`, `host`, `port`, `username`, `environment`만 포함하며 `environment`는 `DEV`, `STAGING`, `PROD` 중 하나입니다. 알 수 없는 필드와 지원하지 않는 버전은 거절합니다. 예를 들면 다음과 같습니다.

```json
{
  "format": "stackport.ssh-profiles",
  "version": 1,
  "profiles": [
    { "name": "개발 서버", "host": "server.example.com", "port": 22, "username": "alice", "environment": "DEV" }
  ]
}
```

자격 증명, 프로젝트 ID, 연결 ID, 호스트 키 신뢰 정보는 교환하지 않습니다. 가져온 서버의 키가 이 장치에 신뢰되어 있지 않으면 처음 접속할 때 별도로 확인해야 합니다. 파일은 암호화되지 않으며 호스트와 사용자 이름이 포함됩니다.

### Windows 데스크톱 E2E 실행

테스트는 디버깅 포트를 열고 테스트 DB와 로컬 셸을 사용하므로 테스트용 앱 데이터, WebView 및 사용자 프로필만 사용해야 합니다. 기존 사용자의 앱이나 데이터를 대상으로 실행하지 마세요. 아래 환경 변수는 테스트 전용 PowerShell 창에서 설정하고, 테스트 후 그 창을 닫으세요. Playwright Node 패키지와 Python이 별도로 필요합니다(예: `npm install --no-save playwright`). Node 모듈 경로는 `STACKPORT_PLAYWRIGHT_PATH`, Python 실행 파일은 `STACKPORT_TEST_PYTHON`으로 지정할 수 있습니다.

```powershell
$testRoot = Join-Path $env:TEMP ('stackport-e2e-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:STACKPORT_TEST_DATABASE = Join-Path $testRoot 'fixture.sqlite'
python tests/create_desktop_fixture.py $env:STACKPORT_TEST_DATABASE
npm run build
cargo build --features custom-protocol --manifest-path src-tauri/Cargo.toml
$env:STACKPORT_DATA_DIR = Join-Path $testRoot 'workspace'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testRoot 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9331 --disable-background-networking'
$env:USERPROFILE = Join-Path $testRoot 'profile'
$env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
$env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
New-Item -ItemType Directory -Force -Path $env:APPDATA, $env:LOCALAPPDATA | Out-Null
Write-Output $testRoot
& '.\src-tauri\target\debug\stackport.exe'
```

앱이 열리면 다른 터미널에서 위에 출력된 테스트 폴더를 사용해 다음을 실행합니다.

```powershell
$env:STACKPORT_TEST_DATABASE = '<출력된 테스트 폴더>\fixture.sqlite'
node tests/desktop-smoke.cjs
```

SSH 검사는 같은 격리 앱에서 테스트 전용 루프백 서버를 시작합니다. Node 24와 개발 의존성 `ssh2`가 필요하며, 아래 경로는 위에서 만든 테스트 폴더여야 합니다.

```powershell
$env:STACKPORT_TEST_ROOT = '<출력된 테스트 폴더>'
node tests/ssh-smoke.cjs
```

키 인증 검사는 격리된 테스트 폴더에 합성 개인 키를 만들고 해당 파일의 Windows 권한을 제한합니다. 기존 사용자의 키나 프로필을 대상으로 실행하지 마세요.

```powershell
$env:STACKPORT_TEST_ROOT = '<출력된 테스트 폴더>'
node tests/ssh-key-smoke.cjs
```

연결 교환 검사는 같은 방식으로 실행하되, 파일 경로와 선택 결과를 격리된 테스트 폴더에 기록합니다.

```powershell
$env:STACKPORT_TEST_ROOT = '<출력된 테스트 폴더>'
node tests/ssh-profile-exchange-smoke.cjs
```

같은 격리 앱에서 터미널 검사를 실행하려면 테스트 앱 프로세스가 하나뿐인지 확인하고 PID를 지정합니다. 이 검사는 종료 확인을 검증한 뒤 앱을 닫습니다.

```powershell
$testExe = (Resolve-Path -LiteralPath 'src-tauri\target\debug\stackport.exe').Path
$testProcesses = @(Get-Process -Name stackport | Where-Object { $_.Path -eq $testExe })
if ($testProcesses.Count -ne 1) { throw '격리된 테스트 앱 하나만 실행하세요.' }
$env:STACKPORT_TEST_WINDOW_PID = [string]$testProcesses[0].Id
node tests/terminal-smoke.cjs
```

테스트 후 앱을 종료하고 임시 폴더를 삭제합니다. 앱 개발 시 이 디버깅 포트는 기본으로 열리지 않습니다.

## 다음 구현 경계

1. 저장 파일의 자동 복구와 다중 창 충돌, SQL 초안 복구와 사용자 선택형 민감 데이터 보호를 구현합니다.
2. SSH 인증 방식·세션 수명주기를 확장하고, 확인된 호스트 키 정책을 SSH 터널·SFTP에도 적용합니다. 별도 자격 증명 저장소와 프로토콜별 기능 감지를 추가합니다.
3. SQLite 편집을 다중 셀·행 변경과 복구 가능한 작업으로 확장하고 다른 DB 어댑터를 개별 지원 매트릭스와 실제 서버 테스트에 연결합니다.
4. 파일 전송, 원격 화면, 모델링, 이관·백업, 자동화, BI, AI, 협업과 게이트웨이를 명세의 각 SP ID 및 수용 테스트에 연결합니다. 미구현 기능은 지원되는 것처럼 표시하지 않습니다.
