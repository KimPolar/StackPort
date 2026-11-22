# 구현 현황과 경계

기준 명세는 `StackPort_Functional_Spec_KO.md`입니다. `requirements.csv`는 명세의 SP 요구사항과 수용 테스트를 기계적으로 추출한 목록입니다. `partial`은 일부 동작만 존재한다는 의미이며 해당 요구사항이나 수용 테스트가 완료되었다는 뜻이 아닙니다. 목록은 `python tools/generate_requirement_inventory.py`로 다시 생성합니다.

## 구성

React/TypeScript 화면은 Tauri 명령을 통해 Rust 코어를 호출합니다. 네트워크·파일 처리와 장시간 SQL은 웹 UI에서 직접 수행하지 않고 별도 작업 스레드로 넘깁니다. 브라우저에는 네이티브 명령이나 임의 TCP 프록시를 제공하지 않습니다. 게이트웨이 인증 및 접근 제어는 아직 구현하지 않았습니다.

로컬 메타데이터는 SQLite 트랜잭션, 외래 키, 스키마 버전을 사용합니다. 지원 버전보다 새로운 파일은 변경하지 않고 열기를 거절합니다. 마이그레이션 백업·복구와 여러 인스턴스의 충돌 해결은 아직 구현하지 않았습니다. 프로젝트 삭제는 연결 정의도 삭제하지만 원본 DB 파일은 건드리지 않습니다. 자격 증명 모델과 보안 저장소는 아직 없습니다.

SQLite 어댑터는 기존 파일만 읽기 전용으로 열고 `query_only`와 SQLite authorizer를 함께 사용합니다. 첨부·PRAGMA·쓰기와 확장 로딩은 거부합니다. 요청별 연결은 작업 종료 시 닫힙니다. SQL과 원본 행은 로그에 기록하지 않으며 초안은 현재 프로세스의 메모리에만 둡니다. 결과는 한 번에 최대 100행을 반환하고 추가 행 존재 여부를 별도로 표시합니다. OFFSET 페이지는 조회 중 원본이 바뀌거나 순서가 불안정하면 중복·누락될 수 있습니다.

SQLite 백업은 온라인 백업 API를 사용해 WAL을 포함한 일관된 스냅샷을 대상 폴더의 임시 파일에 만듭니다. 독립 파일로 전환한 뒤 `integrity_check`를 통과하면 동기화하고 기존 파일을 교체하지 않는 방식으로 저장합니다. 실패 시 최종 경로에 불완전한 파일을 게시하지 않습니다. 백업은 암호화되지 않으며 무결성 검사는 사용자가 별도 환경에서 수행하는 복원 테스트와 구분합니다.

## 현재 증거

- `crates/stackport-core/tests/workspace.rs`: 실제 임시 SQLite 파일을 사용해 프로젝트 지속성·삭제, 객체 조회, 페이지 경계, 쓰기·첨부 거부, 유효하지 않은 파일, 새 스키마 버전 보존 및 큰 텍스트 표시를 검사합니다.
- `crates/stackport-core/tests/backup.rs`: WAL 스냅샷을 독립 DB로 열어 데이터와 인덱스를 검사하고, 덮어쓰기 및 실패 시 부분 파일 생성을 방지하는지 검사합니다.
- `tests/desktop-smoke.cjs`: 독립된 테스트 앱과 실제 SQLite 파일에 연결하여 프로젝트 생성부터 3개 결과 페이지, 쓰기 거부, 백업 생성 및 백업 파일 재조회를 검사합니다.
- `npm run build`: 프런트엔드 타입 검사와 배포용 번들 생성.
- `cargo check --manifest-path src-tauri/Cargo.toml`: 네이티브 명령과 Tauri 호스트 컴파일 검사.

이 검사는 원격 프로토콜이나 명세의 전체 E2E 수용 테스트를 대체하지 않습니다. 서명된 설치 파일, 실제 원격 서버, 장애 복구, 다중 OS, 접근성 및 보안 경계 전체에 대한 검증이 추가로 필요합니다.

### Windows 데스크톱 E2E 실행

테스트는 디버깅 포트를 열기 때문에 테스트용 앱 데이터와 WebView 프로필만 사용해야 합니다. 기존 사용자의 앱이나 데이터를 대상으로 실행하지 마세요. Playwright Node 패키지가 별도로 필요합니다(예: `npm install --no-save playwright`). Node 모듈 경로를 직접 지정하려면 `STACKPORT_PLAYWRIGHT_PATH`를 설정할 수 있습니다.

```powershell
$testRoot = Join-Path $env:TEMP ('stackport-e2e-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $testRoot | Out-Null
$env:STACKPORT_TEST_DATABASE = Join-Path $testRoot 'fixture.sqlite'
python tests/create_desktop_fixture.py $env:STACKPORT_TEST_DATABASE
$env:STACKPORT_DATA_DIR = Join-Path $testRoot 'workspace'
$env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $testRoot 'webview'
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-port=9331 --disable-background-networking'
Write-Output $testRoot
npm run build
cargo run --features custom-protocol --manifest-path src-tauri/Cargo.toml
```

앱이 열리면 다른 터미널에서 위에 출력된 테스트 폴더를 사용해 다음을 실행합니다.

```powershell
$env:STACKPORT_TEST_DATABASE = '<출력된 테스트 폴더>\fixture.sqlite'
node tests/desktop-smoke.cjs
```

테스트 후 앱을 종료하고 임시 폴더를 삭제합니다. 앱 개발 시 이 디버깅 포트는 기본으로 열리지 않습니다.

## 다음 구현 경계

1. 저장 파일의 원자적 백업·마이그레이션, 다중 창 충돌, SQL 초안 복구와 사용자 선택형 민감 데이터 보호를 구현합니다.
2. 프로토콜별 연결 수명주기·오류·기능 감지와 별도 자격 증명 저장소를 추가합니다. SSH 호스트 키 확인과 변경 차단은 실제 SSH/SFTP 경로보다 먼저 완성하고 검증합니다.
3. SQLite 변경 작업은 대상·변경 미리보기, 트랜잭션, 충돌 감지, 실행 후 검증을 갖춘 뒤 활성화합니다. 이후 다른 DB 어댑터를 개별 지원 매트릭스와 실제 서버 테스트에 연결합니다.
4. 파일 전송, 원격 화면, 모델링, 이관·백업, 자동화, BI, AI, 협업과 게이트웨이를 명세의 각 SP ID 및 수용 테스트에 연결합니다. 미구현 기능은 지원되는 것처럼 표시하지 않습니다.
