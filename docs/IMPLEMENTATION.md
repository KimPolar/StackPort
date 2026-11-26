# 구현 현황과 경계

기준 명세는 `StackPort_Functional_Spec_KO.md`입니다. `requirements.csv`는 명세의 SP 요구사항과 수용 테스트를 기계적으로 추출한 목록입니다. `partial`은 일부 동작만 존재한다는 의미이며 해당 요구사항이나 수용 테스트가 완료되었다는 뜻이 아닙니다. 목록은 `python tools/generate_requirement_inventory.py`로 다시 생성합니다.

## 구성

React/TypeScript 화면은 Tauri 명령을 통해 Rust 코어를 호출합니다. 네트워크·파일 처리와 장시간 SQL은 웹 UI에서 직접 수행하지 않고 별도 작업 스레드로 넘깁니다. 브라우저에는 네이티브 명령이나 임의 TCP 프록시를 제공하지 않습니다. 게이트웨이 인증 및 접근 제어는 아직 구현하지 않았습니다.

**MongoDB**는 탐색기의 **데이터베이스 연결 추가**에서 등록합니다. URI·사용자·인증 데이터베이스·환경·선택한 PEM CA 경로를 작업 공간 메타데이터에 저장합니다. 암호는 접속할 때 입력하고, 운영 연결에는 `PROD` 확인이 필요합니다. TLS가 기본이며, 별도 CA를 지정하지 않으면 Rust 드라이버의 기본 신뢰 루트를 사용합니다. `mongodb+srv` 형식도 등록할 수 있으며 TLS가 필요합니다. [MongoDB Rust 드라이버 TLS](https://www.mongodb.com/docs/drivers/rust/current/security/tls/)

MongoDB 작업 공간은 계정 권한 안에서 데이터베이스·컬렉션·뷰를 검색합니다. 문서는 필터·표시 필드·정렬을 서버에 전달해 20개씩 읽고, BSON 타입을 보존하는 Canonical Extended JSON으로 표시합니다. BSON과 표시 문자열 모두 문서당 64 KiB까지 미리 볼 수 있고, 페이지의 표시 문자열 합계는 384 KiB까지입니다. 큰 문서는 표시 필드를 줄여 다시 조회할 수 있습니다. 컬렉션 인덱스는 64개까지 키 순서·고유 여부·TTL·숨김 상태를 읽습니다. [MongoDB Rust 드라이버 데이터베이스와 컬렉션](https://www.mongodb.com/docs/drivers/rust/current/database-collection/)

**문서 → 문서 내보내기**는 적용된 필터·표시 필드·정렬로 컬렉션이나 뷰의 전체 결과를 다시 읽습니다. UTF-8 JSON은 Canonical Extended JSON 배열입니다. 각 문서를 BSON으로 되돌려 원본 바이트와 일치하는지 확인하며, 변환 결과가 일치하지 않으면 파일 저장을 중단합니다. CSV는 한 줄에 한 필드 경로를 지정하고 점으로 하위 필드나 배열 위치를 선택합니다. 누락된 값과 BSON null은 `\N`으로 쓰고, 문자열 수식 보호 옵션과 CSV의 BSON 타입 손실을 표시합니다. 문서는 나눠 읽고 진행 건수를 표시합니다. 파일 준비 중 작업을 취소하거나 5분 제한을 넘기면 부분 결과를 저장하지 않습니다. 기존 파일은 보존됩니다. 감사 기록에는 연결, 대상, 형식과 결과를 남깁니다. [MongoDB Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)

Windows 앱과 TLS를 적용한 MongoDB 8.0.38에서 읽기 전용 계정으로 컬렉션·뷰를 내보냈습니다. 화면의 페이지와 문서 크기 한도를 넘는 전체 결과, BSON 타입 왕복, CSV 필드 순서와 수식 보호, 취소·변환 오류·기존 파일 충돌을 확인했습니다.

문서 편집을 허용한 연결에서 **문서 → 문서 가져오기**를 열면 기존 일반 컬렉션에 문서를 추가할 수 있습니다. UTF-8 JSON 객체·배열과 JSON Lines를 파일당 32 MiB, 1,000개 문서까지 읽고, 처음 세 문서의 Canonical Extended JSON과 건수를 검토합니다. 파일에 `_id`가 없으면 검토할 때 새 ObjectId를 만듭니다. 확인은 같은 연결에서 5분 동안 한 번 사용할 수 있으며 적용 전에 파일 해시를 다시 검사합니다. 각 쓰기에 검토한 컬렉션 UUID를 보내고 `PROD` 연결은 적용할 때 환경을 확인합니다. [MongoDB Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/) · [MongoDB insert 명령](https://www.mongodb.com/docs/manual/reference/command/insert/)

CSV도 같은 가져오기 화면에서 엽니다. UTF-8 쉼표 구분 파일의 첫 행을 머리글로 선택할 수 있고, 64개까지의 열을 대상 필드에 매핑합니다. 각 열은 문자열, Int32, Int64, Double, Decimal128, 불리언, RFC 3339 날짜, Extended JSON 중 하나로 읽거나 건너뜁니다. 따옴표 안의 쉼표·따옴표·줄바꿈과 빈 문자열은 보존합니다. 따옴표 없는 `\N`은 BSON null입니다. 텍스트 값 `'=`처럼 내보낼 때 추가한 수식 보호 문자도 파일에 있는 그대로 읽습니다. 점이 있는 이름은 점을 포함한 단일 필드 이름입니다. 열을 읽은 뒤 파일이 바뀌면 열을 다시 읽어야 합니다. [CSV 형식](https://www.rfc-editor.org/rfc/rfc4180) · [MongoDB Extended JSON](https://www.mongodb.com/docs/manual/reference/mongodb-extended-json/)

독립 서버와 복제 세트에서 내보낸 CSV의 줄바꿈·따옴표·큰 정수·null을 다시 읽었습니다. 머리글 없는 파일의 타입 변환, 중복 매핑과 열 확인 이후 바뀐 파일의 거절, Windows 화면의 대상 이름 변경·열 제외와 가져온 문서 재조회를 확인했습니다.

서버가 복제 세트나 샤드 라우터를 보고하면 하나의 트랜잭션으로 추가합니다. 독립 서버에서 문서를 여러 개 가져올 때는 첫 오류 전까지 저장된 문서가 유지됨을 확인합니다. 결과에 확인된 저장 건수와 오류 위치 또는 결과 미확인 상태를 표시합니다. 작업 기록에는 대상과 결과를 남깁니다. [MongoDB 트랜잭션](https://www.mongodb.com/docs/drivers/rust/current/crud/transactions/)

Windows 앱과 TLS MongoDB 8.0.38 독립 서버 및 단일 노드 복제 세트에서 BSON과 큰 문서의 내보내기→가져오기→다시 내보내기 바이트 일치, 파일·컬렉션 교체 차단, 읽기 전용 계정 거부, 오류 위치와 두 번째 묶음 실패 시 롤백 여부를 확인했습니다. 복제 세트 검사는 `STACKPORT_MONGO_REPLICA=1`로 실행합니다.

데이터베이스 목록의 **백업**에서 일반 데이터베이스 전체 또는 일반 컬렉션 하나를 `mongodump` gzip 아카이브로 로컬에 저장합니다. 같은 버전의 `mongodump.exe`와 `mongorestore.exe`가 있는 MongoDB Database Tools 폴더를 선택합니다. Windows의 로컬 명명된 파이프로 도구에 연결 설정을 전달합니다. 앱은 아카이브의 네임스페이스별 레코드 수·체크섬과 파일 SHA-256을 검사한 뒤 새 파일로 저장합니다. 백업에는 oplog가 포함되지 않아 동시 쓰기가 있으면 컬렉션별 시점이 다를 수 있습니다. [MongoDB mongodump](https://www.mongodb.com/docs/database-tools/mongodump/)

컬렉션·뷰 관리를 허용한 연결에서는 **백업·복원**에서 아카이브에 담긴 일반 컬렉션 하나를 골라 새 이름으로 복원합니다. 아카이브와 대상 서버는 MongoDB 8.0 이상에서 주·부 버전이 같아야 하며, 설치된 도구는 아카이브를 생성한 도구와 같거나 더 최신이어야 합니다. 실행 전 원본과 대상의 버전·네임스페이스·문서 수·SHA-256을 검토합니다. `mongorestore`로 같은 데이터베이스의 임시 컬렉션에 복원한 뒤 문서 수와 컬렉션 UUID를 확인하고 새 이름으로 변경합니다. 대상 이름이 사용 중이면 서버가 이름 변경을 거절합니다. 복원이 중단된 뒤 임시 컬렉션이 남아 있으면 결과에 이름을 표시합니다. 운영 연결은 실행 시 `PROD`를 확인하고 백업·복원 결과를 작업 기록에 남깁니다. [MongoDB mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/) · [MongoDB renameCollection](https://www.mongodb.com/docs/manual/reference/command/renameCollection/)

Windows 앱, MongoDB 8.0.38 TLS 독립 서버와 단일 노드 복제 세트, MongoDB Database Tools 100.20.1에서 백업과 복원을 확인했습니다. 복원한 컬렉션을 다시 내보내 원본 문서의 BSON과 인덱스가 유지되는지 비교했습니다. 손상된 아카이브, 검토 이후 변경한 파일, 같은 이름으로 먼저 만든 컬렉션, 읽기 전용 연결의 복원 요청은 거절됐습니다.

**전체 데이터베이스** 복원은 아카이브에서 원본 데이터베이스 하나를 골라 일반·빈 컬렉션, 시계열 컬렉션과 뷰를 함께 복원합니다. 입력한 이름 앞부분에 고유 접미사를 붙여 검토 화면에 실제 대상 이름을 표시합니다. 새 데이터베이스의 목록 조회·생성·삽입·인덱스 생성과 데이터 검증 권한이 필요합니다. 대상에 이미 객체가 있으면 실행을 거절합니다. 암호화 컬렉션과 원본 컬렉션이 빠진 뷰가 있는 데이터베이스는 전체 복원을 할 수 없습니다. [MongoDB mongorestore](https://www.mongodb.com/docs/database-tools/mongorestore/)

복원 후 대상의 객체 목록·유형, 뷰 원본, 인덱스 이름, 문서 수와 시계열 버킷 수를 아카이브와 대조합니다. 복원이 실패하거나 중단되면 새 데이터베이스에 일부 객체가 남을 수 있습니다. 대상에 객체가 남았거나 상태를 확인하지 못한 경우 결과 메시지에 확인할 이름을 표시합니다. [MongoDB collStats](https://www.mongodb.com/docs/manual/reference/command/collstats/)

Windows 앱과 MongoDB 8.0.38 TLS 독립 서버·단일 노드 복제 세트에서 전체 복원을 검증했습니다. 빈 일반·시계열 컬렉션을 포함해 복원된 문서, 인덱스, 컬렉션 옵션과 서로 참조하는 뷰의 정의를 원본과 비교했습니다. 복원 전에 다른 클라이언트가 만든 대상의 데이터가 보존되는지 확인했습니다. 기본 데이터베이스를 지정하지 않은 연결의 복원 화면에서 한글 이름으로 복원한 뷰도 다시 조회했습니다.

**이 연결에서 컬렉션·뷰 관리 허용**을 선택하면 **컬렉션·뷰 만들기**에서 기존 데이터베이스를 사용하거나 첫 컬렉션과 함께 새 데이터베이스를 만들 수 있습니다. 컬렉션에는 선택적으로 Extended JSON 유효성 규칙과 검사 범위, 위반 시 쓰기 거부 또는 서버 경고를 설정합니다. 뷰는 같은 데이터베이스의 원본과 읽기 전용 집계 단계 최대 24개를 사용합니다. 생성은 서버 명령을 검토한 뒤 5분 안에 한 번 적용하며 운영 환경에서는 `PROD`를 입력합니다. [MongoDB create](https://www.mongodb.com/docs/manual/reference/command/create/) · [MongoDB 뷰 생성](https://www.mongodb.com/docs/manual/core/views/create-view/) · [MongoDB 유효성 검사 범위](https://www.mongodb.com/docs/manual/core/schema-validation/specify-validation-level/)

Windows 앱과 로컬 MongoDB 8.0.38에서 새 데이터베이스의 첫 컬렉션 생성, 규칙 위반 문서의 삽입 거절, 뷰의 필터 결과와 생성 후 목록 갱신을 확인했습니다. TLS와 사용자 인증을 적용한 서버에서 읽기 전용 계정은 생성 요청을 거절당하고, 별도 연결에서 같은 이름을 먼저 생성하면 이전 검토의 적용이 거절됩니다.

**정의** 화면에서는 서버에 저장된 옵션을 Canonical Extended JSON으로 읽습니다. 컬렉션의 유효성 규칙·검사 범위·위반 시 동작과 뷰의 원본·파이프라인을 확인할 수 있습니다. 이 화면은 서버의 상세 조회 권한을 따르며 최대 64 KiB를 표시합니다. [MongoDB listCollections](https://www.mongodb.com/docs/manual/reference/command/listcollections/)

컬렉션·뷰 관리가 허용된 연결에서 뷰의 **정의 → 뷰 정의 편집**을 열면 같은 데이터베이스의 원본 컬렉션이나 뷰를 바꾸고 파이프라인을 수정할 수 있습니다. 서버에 저장된 정의와 변경할 정의를 표시하며 운영 환경에서는 `PROD`를 입력합니다. 적용 전에 원본의 존재와 뷰 정의를 다시 확인합니다. 새 파이프라인은 중첩된 쓰기 단계와 서버 JavaScript를 차단하며, 그 밖의 단계 지원 여부와 뷰의 순환 참조는 서버가 검사합니다. [MongoDB collMod 뷰 변경](https://www.mongodb.com/docs/manual/reference/command/collmod/#modify-views)

Windows 앱과 MongoDB 8.0.38 TLS 환경에서 원본을 다른 뷰로 바꾼 뒤 새 파이프라인의 조회 결과를 확인했습니다. 오래된 검토, 적용 전에 사라진 원본, 순환 참조, 읽기 전용 계정의 변경 요청은 거절됐습니다.

컬렉션·뷰 관리가 허용된 연결에서 일반 컬렉션의 **정의 → 유효성 규칙 편집**을 열면 규칙과 검사 옵션을 변경할 수 있습니다. 규칙 입력을 비우면 규칙을 제거합니다. 적용 전에 변경 전후를 표시하며 운영 환경에서는 `PROD`를 입력합니다. 서버의 변경 권한이 필요하고 적용 직전에 컬렉션 UUID와 기존 규칙·검사 옵션을 다시 읽습니다. 기존 문서는 설정된 검사 범위에 따라 이후 수정 시 검사됩니다. [MongoDB collMod](https://www.mongodb.com/docs/manual/reference/command/collmod/)

Windows 앱과 TLS를 적용한 MongoDB 8.0.38에서 규칙 변경으로 인한 쓰기 거부, 경고 설정 및 규칙 제거 후 쓰기 허용, 읽기 전용 계정의 변경 거절을 확인했습니다. 두 연결에서 같은 규칙을 동시에 변경하면 한 건만 적용되고, 같은 이름으로 다시 생성한 컬렉션에는 이전 검토를 적용할 수 없습니다.

일반 컬렉션은 **정의 → 컬렉션 삭제**에서 영향을 검토할 수 있습니다. 문서 수 추정치와 인덱스 수, 같은 데이터베이스의 직접·간접 의존 뷰를 표시합니다. `$lookup`, `$graphLookup`, `$unionWith`와 중첩 파이프라인의 참조도 포함합니다. `DROP` 승인과 운영 환경의 `PROD` 확인 뒤 UUID와 의존 뷰를 다시 읽고, 서버 삭제 명령에도 UUID를 전달합니다. 영향 조회 후 추가된 문서도 같은 컬렉션을 삭제할 때 함께 지워집니다. 의존 뷰의 정의는 보존됩니다. [MongoDB drop](https://www.mongodb.com/docs/manual/reference/command/drop/) · [MongoDB 8 서버의 UUID 확인](https://github.com/mongodb/mongo/blob/r8.0.0/src/mongo/db/catalog/drop_collection.cpp#L208-L229)

Windows 앱과 MongoDB 8.0.38 TLS 환경에서 승인 후 삭제와 읽기 전용 계정의 요청 거절을 확인했습니다. 의존 뷰가 추가되거나 같은 이름의 컬렉션이 재생성되면 이전 검토가 거절됐습니다. MongoDB는 잘못된 UUID를 포함한 삭제 명령도 거절했습니다. 뷰는 UUID가 없으므로 뷰 삭제에는 서버에서 대상의 이름과 타입을 함께 확인할 수단이 필요합니다. [MongoDB 8 서버의 뷰 삭제 처리](https://github.com/mongodb/mongo/blob/r8.0.0/src/mongo/db/catalog/drop_collection.cpp#L148-L159)

일반 컬렉션은 **정의 → 컬렉션 이름 변경**에서 같은 데이터베이스 안의 새 이름을 검토할 수 있습니다. 기존 이름에 의존하는 뷰와 새 이름에 연결될 뷰를 각각 표시하고 운영 환경에서는 `PROD`를 확인합니다. 기존 뷰 정의는 그대로 유지됩니다. 적용 전에 두 이름의 의존 뷰와 원본 UUID를 다시 확인하며, 서버에 원본 UUID와 `dropTarget: false`를 전달합니다. 성공하면 새 이름을 선택하고 감사 기록에 두 이름을 남깁니다. [MongoDB renameCollection](https://www.mongodb.com/docs/manual/reference/command/renamecollection/) · [MongoDB 8 서버의 원본 UUID 확인](https://github.com/mongodb/mongo/blob/r8.0.0/src/mongo/db/commands/rename_collection_cmd.cpp#L86-L104)

Windows 앱과 MongoDB 8.0.38 TLS 환경에서 이름 변경 후 문서와 인덱스가 보존되고, 새 이름을 참조하던 뷰가 데이터를 반환하는 것을 확인했습니다. 기존 이름을 참조하던 뷰의 정의와 별도 컬렉션의 데이터도 보존됐습니다. 검토 뒤 새 이름이 사용되거나 의존 뷰가 추가되거나 원본이 재생성되면 이전 검토가 거절됐으며, 서버도 잘못된 UUID를 포함한 이름 변경을 거절했습니다.

**이 연결에서 인덱스 관리 허용**을 선택하면 일반 컬렉션의 **인덱스** 화면에서 이름과 키 순서를 지정해 인덱스를 만들 수 있습니다. 오름차순·내림차순 단일 및 복합 키, 텍스트, 2d·2dsphere, 해시를 지원합니다. TTL은 `_id`를 제외한 일반 키 하나에 지정하고, 이미 만료된 문서에 미칠 영향을 생성 검토에 표시합니다. 인덱스 종류와 옵션 조합은 서버가 검사합니다. [MongoDB createIndexes](https://www.mongodb.com/docs/manual/reference/command/createindexes/) · [MongoDB TTL 인덱스](https://www.mongodb.com/docs/manual/core/index-ttl/)

**옵션 변경**에서 쿼리 플래너의 인덱스 숨김을 켜거나 끄고, 지원하는 단일 키에 TTL을 추가하거나 변경할 수 있습니다. 검토 화면에 변경 전후 정의를 표시합니다. TTL을 새로 설정하거나 줄이면 이미 만료된 문서를 서버가 삭제할 수 있습니다. 숨김 인덱스도 고유 제약을 검사하고 TTL 만료를 처리합니다. 적용은 서버의 `collMod` 권한을 따르며, 컬렉션 UUID와 인덱스 정의를 다시 확인한 뒤 실행합니다. [MongoDB collMod](https://www.mongodb.com/docs/manual/reference/command/collmod/) · [MongoDB 숨김 인덱스](https://www.mongodb.com/docs/manual/core/index-hidden/)

인덱스 삭제 검토는 현재 정의와 쿼리 계획·고유 제약·자동 만료에 미칠 영향을 표시합니다. `$indexStats`를 읽을 수 있으면 응답한 노드의 사용 횟수를 합산합니다. 인덱스 한 개를 대상으로 5분 이내에 `DROP`을 입력하며, 운영 환경에서는 `PROD`도 입력합니다. 적용 직전에 컬렉션 UUID와 인덱스 정의를 다시 읽습니다. 서버에 보내는 명령에는 컬렉션 UUID와 인덱스 이름을 포함합니다. 시작과 결과를 감사 기록에 남기고, 연결이나 시간 초과로 결과를 확인할 수 없으면 목록에서 상태를 다시 확인하도록 안내합니다. [MongoDB dropIndexes](https://www.mongodb.com/docs/manual/reference/command/dropindexes/) · [MongoDB 인덱스 사용 통계](https://www.mongodb.com/docs/manual/reference/operator/aggregation/indexstats/)

Windows 앱과 로컬 MongoDB 8.0.38에서 복합 고유 인덱스와 TTL·텍스트·2dsphere 인덱스의 생성과 삭제를 확인했습니다. 숨김과 숨김 해제, 기존 인덱스에 TTL 추가·변경, Windows 화면의 `DROP`·`PROD` 승인도 검사했습니다. 다른 연결에서 인덱스 키 또는 TTL을 바꾼 뒤 이전 검토가 거절되는 것을 확인했습니다.

문서 화면의 **찾기 빌더**에서 필드·비교 연산자·값으로 조건을 만들고 AND·OR 그룹을 중첩할 수 있습니다. 문자열 입력과 Extended JSON 값을 사용하며, 목록 연산에는 배열을 입력하고 필드 존재 여부는 선택합니다. 기존 필터도 함께 적용하면 AND로 연결합니다. **조회 적용**은 생성한 필터를 JSON 입력란에 채우고 현재 표시 필드·정렬 설정과 함께 첫 페이지를 조회합니다. Rust에서 BSON 타입과 필드 순서를 보존해 필터를 만들고 조회에 쓰는 검사 규칙을 적용합니다. [MongoDB 조회 조건](https://www.mongodb.com/docs/manual/reference/operator/query/)

**일치 건수 조회**는 적용된 필터 전체를 `countDocuments`로 계산합니다. 컬렉션과 뷰 모두에서 사용할 수 있으며, 현재 페이지·표시 필드·정렬과 관계없이 일치한 문서를 셉니다. 새 필터를 적용하면 이전 건수는 지워집니다. 건수 요청은 현재 연결의 권한으로 실행하고, 서버에는 7초 처리 한도를 전달합니다. [MongoDB countDocuments](https://www.mongodb.com/docs/manual/reference/method/db.collection.countDocuments/)

Windows 앱과 로컬 MongoDB 8.0.38에서 문서 23개의 전체 건수, 필터 적용 결과와 뷰의 건수를 확인했습니다. 찾기 빌더에서 중첩 조건을 적용하고 다시 열어 수정할 때 표시 필드·정렬 설정이 반영되는지도 확인했습니다.

접속할 때 **이 연결에서 문서 편집 허용**을 선택하면 일반 컬렉션에서 문서 한 건을 삽입·복제·수정·삭제할 수 있습니다. 수정·복제·삭제는 `_id`로 전체 문서를 새로 읽습니다. Extended JSON으로 64 KiB 이하의 문서를 편집할 수 있으며, 기존 BSON을 손실 없이 표현할 수 있는지 확인합니다. 수정할 때는 `_id`를 유지합니다. 삽입과 복제는 `_id`를 생략하면 검토 화면에 새 ObjectId를 표시합니다. 중복 필드 이름이 있는 입력은 거절합니다.

문서 편집기의 **JSON**, **트리**, **그리드**는 같은 초안을 사용합니다. 트리에서 중첩 객체와 배열을 펼치고, 그리드에서 값 셀을 눌러 편집하거나 객체·배열 안으로 들어갑니다. 필드 추가·이름 변경·제거와 배열 항목 추가·이동·제거를 지원합니다. **초안에 반영**하면 네이티브 BSON 변환으로 필드 순서와 Int64·Decimal128 등 BSON 유형을 보존합니다. 서버에 쓰려면 기존 변경 검토를 거쳐야 합니다. Windows의 로컬 MongoDB 8.0.38에서 세 보기 전환, 64비트 정수와 배열 순서의 저장·재조회를 확인했습니다.

**변경 검토**에서 전체 원본과 입력값을 확인합니다. 검토는 5분 이내에 한 번 적용할 수 있습니다. `PROD`에서 적용할 때는 `PROD`, 삭제할 때는 `DELETE`를 입력합니다. 수정과 삭제는 MongoDB 단일 문서 쓰기 조건으로 원본 값과 BSON 타입을 검사합니다. 쓰기 명령에는 검토한 컬렉션의 UUID를 포함합니다. 서버의 `collectionUUID`와 `$getField` 지원이 필요합니다. 권한·컬렉션 유효성 검사·고유 인덱스는 서버에서 적용되며, 응답이 끊겨 결과를 확인하지 못한 경우 다시 조회하도록 안내합니다. 작업 기록에는 연결·환경·결과를 남깁니다. [MongoDB 단일 문서 쓰기](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) · [MongoDB BSON 비교](https://www.mongodb.com/docs/manual/reference/bson-type-comparison-order/)

컬렉션과 뷰의 **스키마 분석**은 선택한 대상에서 `$sample`로 최대 20·50·100개의 문서를 읽습니다. 분석에 포함된 문서를 분모로 필드 등장 비율을 계산하고, 각 BSON 유형을 문서당 한 번 집계합니다. 배열 항목은 `[]`로 표시하며, `a.b`처럼 점이 포함된 단일 필드 이름은 `["a.b"]`로 구분합니다. 화면에서 필드 경로를 검색하고 두 가지 이상의 유형이 나온 경로만 볼 수 있습니다. 64 KiB를 넘는 문서, 경로 제한을 넘는 필드는 집계에서 제외하고 화면에 알립니다. 결과에는 필드 경로와 유형별 개수를 표시합니다. 서버 처리 시간은 최대 7초로 설정하고, 디스크를 사용하는 집계는 비활성화합니다. [MongoDB 무작위 표본](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sample/) · [MongoDB 집계 실행 옵션](https://www.mongodb.com/docs/manual/reference/command/aggregate/)

**집계 파이프라인**에서 단계의 연산자와 Extended JSON 값을 편집하고, 위아래로 옮기거나 활성화 여부를 바꿀 수 있습니다. **여기까지 미리보기**는 지정한 단계까지의 활성 단계만 실행합니다. **전체 미리보기**는 모든 활성 단계를 실행합니다. `$match`, `$project`, `$group`, `$sort`, `$lookup`, `$facet` 등을 지원합니다. 중첩 파이프라인을 포함해 최대 24단계까지 실행하고, 실행 단계에서 서버 JavaScript와 쓰기 연산자를 차단합니다. 현재 연결의 권한으로 실행하며 서버 처리 시간은 7초, 디스크 사용은 비활성으로 설정합니다. 미리보기는 최대 문서 20개를 Canonical Extended JSON으로 표시하고 문서당 64 KiB, 전체 384 KiB 한도를 적용합니다. [MongoDB 집계 단계](https://www.mongodb.com/docs/manual/reference/mql/aggregation-stages/) · [MongoDB Rust 드라이버 집계](https://www.mongodb.com/docs/drivers/rust/current/aggregation/)

이름을 붙여 저장한 파이프라인은 프로젝트 내 다른 MongoDB 컬렉션이나 뷰에서도 열 수 있습니다. 작업 공간 스키마 v21은 단계 순서와 JSON 원문 및 활성 상태를 보관합니다. 프로젝트를 복제하면 파이프라인도 복사됩니다. **JSON 교환**에서 복사한 StackPort 형식은 다른 프로젝트에서도 가져올 수 있습니다. 불러오기와 가져오기는 편집기에 단계를 채우며, 집계는 미리보기 버튼으로 실행합니다.

**SQL Server**는 호스트·TCP 포트·시작 데이터베이스·인증 방식·환경을 프로젝트에 저장합니다. SQL Server 로그인 암호는 접속할 때만 입력합니다. Windows 통합 인증을 선택하면 현재 Windows 계정으로 연결합니다. TLS는 필수이며 OS 신뢰 저장소와 선택한 PEM CA로 서버 인증서를 검증합니다. 서버가 TDS 8.0을 제공하면 엄격한 TLS를 선택할 수 있습니다. 운영 연결에는 `PROD` 확인이 필요합니다. [Tiberius](https://github.com/tiberius-rs/tiberius/releases/tag/v0.13.0) · [SQL Server의 엄격한 암호화](https://learn.microsoft.com/en-us/sql/relational-databases/security/networking/connect-with-strict-encryption)

SQL Server 작업 공간은 접속한 데이터베이스에서 계정에 공개된 스키마, 테이블, 뷰를 검색합니다. 열 이름·타입·NULL·IDENTITY를 표시하며, 미리보기는 앞 64개 열을 읽습니다. 테이블은 기본 키의 열 순서와 정렬 방향으로 50행씩 읽습니다. 기본 키가 없으면 한 번에 최대 50행을 표시합니다. 큰 정수와 소수는 문자열로, 바이너리는 HEX로 보존하며 값은 처음 256문자 또는 256바이트까지 표시합니다. 잘린 문자열의 크기는 UTF-16으로 변환한 전체 값의 바이트 수입니다. [SQL Server 메타데이터 공개 범위](https://learn.microsoft.com/en-us/sql/relational-databases/security/metadata-visibility-configuration)

SQL Server 작업 공간의 **DB 백업**에서 SQL Server 2017 이상에 연결된 온라인 사용자 DB의 전체 `COPY_ONLY` 백업을 만들 수 있습니다. Windows 드라이브 또는 Linux의 서버 로컬 디스크 절대 경로를 입력하면 새 `.bak` 경로를 제안합니다. 미리보기에서 대상 DB·파일·압축 옵션을 확인합니다. `PROD` 연결에서는 `PROD` 입력이 필요합니다. SQL 계정에는 `BACKUP DATABASE`, 서버 서비스 계정에는 폴더의 읽기·쓰기 권한이 필요합니다. 실행 직전에 같은 이름의 파일이나 폴더와 부모 폴더를 확인한 뒤 `CHECKSUM`, `NOFORMAT`, `NOINIT`을 적용합니다. [SQL Server 전체 백업](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/create-a-full-database-backup-sql-server) · [BACKUP](https://learn.microsoft.com/en-us/sql/t-sql/statements/backup-transact-sql)

**파일 검증**은 서버의 파일 경로와 백업 세트 위치를 입력받습니다. SQL 계정에 `CREATE DATABASE` 권한이 필요합니다. `RESTORE HEADERONLY`로 원본 DB·서버 버전·세트 ID를 읽고 `RESTORE VERIFYONLY`로 백업을 검사합니다. 체크섬이 있는 세트는 체크섬까지 검증하며, 없는 세트는 판독 결과를 표시합니다. 백업과 검증은 별도 TLS 연결에서 실행되며 서버가 진행률을 공개하면 현재 작업의 퍼센트를 표시합니다. 작업당 최대 30분이며 중단 요청에 대한 서버 응답을 표시합니다. 작업 기록에는 연결과 작업 ID·결과를 남깁니다. [백업 헤더](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/backup-history-and-header-information-sql-server) · [RESTORE VERIFYONLY](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-verifyonly-transact-sql) · [백업 진행률](https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/backup-restore/backup-restore-operations)

SQL Server 작업 공간의 **DB 복원**에서 서버 로컬 디스크의 일반 전체 DB 백업 세트 하나를 SQL Server 2017 이상의 새 DB에 복원합니다. 미리보기는 원본 DB와 버전, 백업 세트와 체크섬, 논리 파일·원래 경로·크기 및 새 서버 경로를 보여줍니다. 서버의 기본 데이터·로그 폴더를 사용하거나 각각 지정할 수 있습니다. 한 세트의 파일은 최대 1,000개까지 검토합니다. 전환까지 수행하려면 SQL 계정에 DB 생성 및 `ALTER ANY DATABASE`·`CONNECT ANY DATABASE` 권한이 필요합니다. SQL Server 서비스 계정에는 백업 읽기와 대상 폴더 쓰기 권한이 필요합니다. 서버 로그인과 SQL Server Agent 작업은 별도로 구성합니다. [FILELISTONLY](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-filelistonly-transact-sql) · [새 위치로 복원](https://learn.microsoft.com/en-us/sql/relational-databases/backup-restore/restore-a-database-to-a-new-location-sql-server)

미리보기는 5분 안에 한 번 사용하며 대상 이름과 파일 위치를 확인합니다. 운영 환경에서는 `PROD`를 입력합니다. 실행 직전에 백업 세트와 파일 목록을 다시 읽고 `VERIFYONLY`로 판독·복원 위치를 확인합니다. 임시 DB에 `MOVE`와 `RECOVERY`로 복원하고 온라인 상태 및 파일 위치를 확인한 후 SQL Server에서 검토한 이름으로 바꿉니다. 검토 이후 같은 이름의 DB가 생기면 SQL Server가 이름 변경을 거부합니다. 복원 도중 중단되거나 이름 전환이 실패하면 확인할 임시 DB를 결과에 표시하며 작업 기록에 연결과 결과를 남깁니다. [RESTORE](https://learn.microsoft.com/en-us/sql/t-sql/statements/restore-statements-transact-sql) · [SQL Server 데이터베이스 이름 변경](https://learn.microsoft.com/en-us/sql/relational-databases/databases/rename-a-database)

**SQL 편집기**는 T-SQL 구문 강조와 줄 번호를 제공하며, 전체 문서·현재 배치·선택 영역을 실행합니다. `Ctrl+Enter`는 선택이 있으면 선택 영역을, 없으면 커서가 있는 배치를 실행합니다. 전체·선택 실행은 독립된 줄의 `GO`와 `GO n`으로 나눈 배치를 같은 실행 연결에서 최대 100회 처리합니다. 현재 배치 실행은 한 번 처리합니다. 문서의 최대 크기는 UTF-8 기준 256 KiB입니다. [SQL Server 배치 구분 명령](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/sql-server-utilities-statements-go)

로그인 계정의 실제 권한으로 SQL을 실행합니다. 실행마다 별도 TLS 연결을 사용하므로 임시 테이블과 세션 설정은 같은 실행의 배치 사이에서 유지됩니다. 실행이 끝나면 열린 트랜잭션을 롤백하고 연결을 닫습니다. 실패 배치 다음의 배치는 실행하지 않으며, 이미 커밋한 변경은 유지됩니다. 30초 실행 타임아웃과 수동 중단에서 서버의 중단 확인 여부를 표시합니다. SQL Server 2022 실서버 테스트에서는 드라이버가 일부 중단 응답을 확인하지 못했습니다. 이 경우 실행 연결을 닫고 중단 응답과 롤백 완료가 미확인임을 표시합니다. [SQL Server의 TDS 중단 응답](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-tds/9bcc4b79-a791-41d0-bf76-73a97e501b35)

결과는 앞 16개 집합을 각각 최대 100행·128열까지 표시합니다. 값당 텍스트 최대 2 KiB, 바이너리 최대 1 KiB와 전체 미리보기 저장 한도를 적용합니다. 제한에 도달한 뒤에도 실행 결과를 읽어 성공이나 오류를 확인합니다. 실행 시간·서버 오류 코드·줄 번호를 표시하며, 감사 로그에는 연결과 실행 결과만 기록합니다. 현재 편집기는 연결을 닫으면 초기화되며, 서버 정보 메시지·영향받은 행 집계는 구현 범위에 남아 있습니다.

**매개변수 실행**은 선택한 SQL이나 커서가 있는 배치 하나에서 대문자 `@P1`~`@P64`를 찾아 입력 폼을 엽니다. 같은 번호는 한 번 입력하며 번호 사이를 건너뛸 수 있습니다. 문자열·인용 식별자·주석에 들어 있는 이름은 건너뜁니다. 유니코드 텍스트, 64비트 정수, 최대 38자리 소수, 부동소수점, `bit`, 16진수 바이너리와 `NULL`을 선택할 수 있습니다. 값은 실행할 때 `sp_executesql`의 별도 RPC 인자로 전달합니다. **값 숨기기**는 입력을 가리고 해당 실행에서 서버 오류 본문을 숨깁니다. [SQL Server sp_executesql](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql)

SQL Server 테이블·뷰의 **결과 내보내기**는 적용된 필터와 정렬로 모든 결과 행과 공개된 열을 스트리밍합니다. UTF-8 CSV 또는 타입과 HEX 인코딩을 기록하는 버전형 JSON을 선택할 수 있습니다. 38자리 소수, 날짜·시간, 긴 유니코드 문자열, 바이너리, `NULL`과 빈 값을 보존합니다. 내보내기에는 같은 인증 및 TLS 설정을 적용한 별도 연결을 사용합니다. 로그인 암호는 현재 세션이 열린 동안만 메모리에 두고 세션을 닫을 때 지웁니다. 진행 행 수를 표시하고 중단할 수 있으며, 완료된 파일만 지정한 경로에 저장합니다. 성공 시 객체와 행 수를 작업 기록에 남깁니다. 제한 시간은 5분입니다. 열이 4,095개를 넘거나 한 행의 큰 값이 합계 32 MiB를 넘으면 내보내기를 중단합니다. `sql_variant`와 사용자 정의 CLR 타입 등 지원 범위 밖의 열은 이름과 타입을 오류에 표시합니다.

SQL Server의 **키와 인덱스**는 현재 계정에 공개된 인덱스, 제약조건, 외래 키를 항목별로 50개씩 보여줍니다. 인덱스의 종류·고유 여부·비활성 상태, 키 순서와 정렬 방향, 포함 열, 공개된 필터와 파티션별 추정 행 수의 합계를 표시합니다. 제약조건에서 기본 키·고유 키·CHECK·DEFAULT를 확인합니다. 외래 키는 들어오는 참조·나가는 참조·자기 참조를 구분하며, 복합 키의 열 대응과 갱신·삭제 동작을 표시합니다. 공개된 테이블은 열 구조로 바로 이동하고 공개 범위 밖의 대상 이름과 열은 가립니다. [sys.index_columns](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-index-columns-transact-sql) · [sys.foreign_keys](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-foreign-keys-transact-sql)

**Oracle Database**는 Oracle의 Rust Thin 드라이버 프리릴리스 버전을 고정해 사용합니다. Windows 실행 파일에서 별도 Oracle Instant Client 설치 없이 호스트·포트·서비스 이름 또는 SID를 지정해 접속합니다. 기본 전송 방식인 TCPS는 호스트 이름과 인증서를 검증하며 드라이버에 포함된 신뢰 루트와 선택한 PEM CA를 사용합니다. 일반 TCP도 선택할 수 있습니다. 암호는 연결할 때 입력하고 운영 환경에서는 `PROD`를 확인합니다. [Oracle Rust Thin 드라이버](https://oracle.github.io/rust-oracledb/)

Oracle 작업 공간은 접속한 서비스에서 계정에 공개된 스키마·테이블·뷰·구체화 뷰와 열 구조를 보여줍니다. 미리보기는 앞 64개 열을 표시하며, 유효한 기본 키가 있는 테이블은 50행씩 이동할 수 있습니다. Oracle NUMBER는 지정된 자릿수를 부동소수점으로 변환하지 않고 문자열로 표시합니다. 문자와 CLOB은 앞부분을, RAW와 BLOB은 앞 256바이트를 HEX로 읽습니다. [Oracle ALL_TAB_COLUMNS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_TAB_COLUMNS.html)

Oracle 작업 공간의 **Data Pump**에서 로그인한 계정의 스키마를 서버의 `.dmp` 파일로 내보냅니다. 구조와 데이터, 구조만, 데이터만을 선택할 수 있습니다. 데이터는 `FLASHBACK_TIME`으로 같은 시점을 읽습니다. Oracle 디렉터리 객체와 실제 서버 경로, 새 파일과 작업 이름을 미리 보고 실행합니다. 계정에 디렉터리 `WRITE`와 `CREATE TABLE`, 기본 테이블스페이스 할당량이 필요합니다. 운영 환경에서는 `PROD`를 입력합니다. 실행 직전에 계정과 경로를 다시 확인하며 Oracle이 같은 이름의 파일을 보존하도록 설정합니다. 작업별 한도는 30분입니다. 데이터 진행률, 서버 오류 및 중단 결과를 표시하며 작업 기록에 연결과 결과를 남깁니다. [Oracle Data Pump API와 권한](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_DATAPUMP.html) · [Oracle 디렉터리 개체](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_DIRECTORIES.html)

**덤프 헤더 확인**은 `READ` 권한이 있는 Oracle 디렉터리 안의 파일을 읽습니다. 파일 크기, 덤프 세트 ID, 작업·파일 형식 버전과 생성 정보를 표시합니다. 방금 만든 파일을 선택하면 헤더의 작업 이름을 대조합니다. 헤더 확인 결과와 내보내기 결과는 각각 표시됩니다. Data Pump를 제공하는 Oracle 설치가 필요하며 Oracle Free 컨테이너는 Full 이미지를 사용합니다. [Oracle GET_DUMPFILE_INFO](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_DATAPUMP.html) · [Oracle Free 이미지 비교](https://container-registry.oracle.com/ords/ocr/ba/database/free)

**덤프 가져오기**는 로그인한 Oracle 사용자 스키마에 마스터 정보가 포함된 단일 덤프를 적용합니다. 미리보기는 입력한 원본 스키마, 서버 파일과 덤프 세트, 원본 작업 버전, 대상 Oracle 버전과 기본 테이블스페이스를 표시합니다. 대상 계정은 디렉터리 `READ`, `CREATE TABLE`, 저장 할당량과 객체별 생성 권한이 필요합니다. 실행 때 덤프 헤더, 파일 크기, 디렉터리 경로와 대상 스키마를 다시 확인합니다. 대상 이름을 그대로 입력하고, 운영 연결에서는 `PROD`도 입력합니다. [Oracle Data Pump 가져오기와 REMAP_SCHEMA](https://docs.oracle.com/en/database/oracle/oracle-database/26/sutil/parameters-available-command-line-mode-import-oracle-data-pump.html)

구조를 포함하는 가져오기는 빈 사용자 스키마에 대상의 기본 저장 설정으로 객체를 만들며 Oracle의 `SKIP` 정책을 사용합니다. 사용자 정의와 시스템·역할 권한 등 계정 설정은 가져오기에서 제외합니다. 구조만 선택하면 행을 가져오지 않습니다. 데이터만 선택하면 검토 목록에 있는 기존 테이블과 덤프가 일치하는 범위에서 행을 추가합니다. 원본 스키마 이름이 뷰나 저장 코드 안에 포함된 경우 참조를 별도로 확인합니다. 가져오기 도중 실패하거나 중단하면 일부 변경이 대상에 남을 수 있습니다. 완료 뒤에는 사용자 객체·테이블 수와 유효하지 않은 객체 수를 표시합니다. [Oracle Data Pump 필터와 변환](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_DATAPUMP.html)

Oracle **SQL 편집기**는 전체 문서, 현재 문장, 선택 영역을 실행합니다. 일반 SQL은 세미콜론으로 나눕니다. 연달아 실행할 PL/SQL 블록과 저장 프로그램은 별도 줄의 `/`로 구분합니다. Oracle 대체 인용 문자열과 인용 식별자 안의 구분 문자는 유지합니다. 문서의 최대 크기는 256 KiB이며 한 번에 최대 100개 문장을 실행합니다. [Oracle SQL*Plus의 PL/SQL 구분](https://docs.oracle.com/en/database/oracle/oracle-database/19/sqpug/SQL-Plus-basics.html)

실행 범위에 `:name` 같은 입력 변수가 있으면 타입과 값을 실행 전에 입력합니다. 일반 이름은 대소문자 구분 없이 같은 값으로 바인딩하고 인용된 이름은 대소문자를 유지합니다. 문자열, 64비트 정수, 최대 38자리 `NUMBER`, `BINARY_DOUBLE`, 16진수 `RAW`, `NULL`을 지원합니다. 실행 범위 전체의 변수와 제출한 값이 일치해야 첫 문장을 실행합니다. 값을 숨기면 입력란, 실행 오류의 상세 메시지, 서버 경고를 가립니다. 쿼리에서 반환한 값은 결과 표에 표시됩니다. 감사 로그에는 연결과 실행 결과를 기록합니다. [Oracle Rust 드라이버의 SQL 실행과 바인딩](https://github.com/oracle/rust-oracledb/blob/main/doc/sql_execution.md)

실행마다 같은 로그인과 전송 설정으로 별도 연결을 엽니다. Oracle에서 커밋한 작업은 유지하고, 열린 트랜잭션은 실행 종료 시 롤백합니다. 한 문장이 실패하거나 중단 요청을 확인하면 다음 문장부터 실행을 멈춥니다. 스크립트 실행 시간은 최대 30초로 관리하며, 소켓 읽기·쓰기에는 최대 8초 한도를 적용합니다. 수동 중단 요청은 진행 중인 호출이 반환된 뒤 적용됩니다. 중단·시간 초과 과정에서 Oracle의 중단 응답과 실행 종료 시의 롤백 확인 상태를 표시합니다.

결과에서 문장 시작 줄, Oracle 오류와 드라이버가 제공한 경고, DML의 영향받은 행 수를 확인할 수 있습니다. 조회마다 앞 100행과 128열을 표시하며, 텍스트 값은 2 KiB, 바이너리는 1 KiB까지 미리 봅니다. NUMBER는 정밀도를 보존하고 CLOB·BLOB은 제한된 부분만 읽습니다. 전체 미리보기 저장 한도에 도달한 뒤에도 해당 결과를 읽어 실행 성공 여부를 확인합니다. 출력 바인드와 `DBMS_OUTPUT` 수집은 남아 있습니다.

Oracle의 **결과 내보내기**는 테이블·뷰·구체화 뷰에서 적용한 필터와 정렬로 전체 결과를 UTF-8 CSV 또는 버전형 JSON에 저장합니다. `NUMBER`는 정밀도를 유지하고, 시간대가 있는 타임스탬프는 오프셋과 저장된 지역을 기록합니다. `WITH LOCAL TIME ZONE` 값은 UTC로 기록합니다. `CLOB`·`NCLOB`·`BLOB`은 작은 단위로 읽고 SQL `NULL`과 비어 있는 LOB를 구분합니다. 네이티브 `JSON` 값은 Oracle이 표준 JSON 텍스트로 직렬화합니다. [Oracle JSON_SERIALIZE](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/JSON_SERIALIZE.html)

내보내기는 같은 인증과 전송 설정으로 별도 연결을 엽니다. 암호는 열린 세션 동안 메모리에 유지하고 종료 시 지웁니다. 진행 행 수를 표시하며, 중단은 진행 중인 서버 호출이 반환된 뒤 처리합니다. 제한은 4,096열, 행당 값 합계 32 MiB, 전체 5분입니다. `BFILE`·`LONG` 등 지원 범위 밖의 열은 이름과 타입을 오류에 표시합니다. 성공한 파일만 지정 경로에 저장하고 대상 객체와 행 수를 작업 기록에 남깁니다.

**Snowflake**는 공식 SQL API에 Windows의 인증서 검증을 사용하는 HTTPS로 연결합니다. 계정 식별자 또는 계정 호스트, 데이터베이스, 선택한 웨어하우스와 역할, 인증 방식과 환경을 프로젝트에 저장합니다. PAT 또는 OAuth 액세스 토큰은 연결할 때 입력하며 운영 프로필에는 PROD 확인이 필요합니다. 업무 화면에 연결된 실제 역할과 웨어하우스를 표시합니다. [Snowflake SQL API](https://docs.snowflake.com/en/developer-guide/sql-api/intro) · [Snowflake 인증 방식](https://docs.snowflake.com/en/developer-guide/snowflake-rest-api/authentication)

Snowflake 작업 공간은 현재 역할로 볼 수 있는 데이터베이스의 스키마, 테이블, 뷰, 구체화 뷰를 검색합니다. 열 구조는 이름, 데이터 타입, NULL 허용 여부와 IDENTITY를 표시합니다. 미리보기는 최대 50행과 64열을 읽습니다. NUMBER의 정밀도를 문자열로 보존하고, 긴 문자와 바이너리 값은 앞 256문자 또는 256바이트를 표시합니다. [Snowflake TABLES](https://docs.snowflake.com/en/sql-reference/info-schema/tables) · [Snowflake COLUMNS](https://docs.snowflake.com/en/sql-reference/info-schema/columns)

Snowflake **SQL 편집기**는 전체 문서, 현재 문장, 선택 영역을 실행합니다. 세미콜론으로 문장을 나누고 인용 문자열·인용 식별자·주석의 구분 문자를 보존합니다. 익명 Snowflake Scripting 블록은 `EXECUTE IMMEDIATE $$…$$`로 감쌉니다. 한 번에 최대 100개 SQL 문장을 하나의 SQL API 요청에 담으므로 명시적 트랜잭션과 세션 문맥을 그 요청 안에서 이어서 사용할 수 있습니다. [Snowflake 다중 문장 요청](https://docs.snowflake.com/en/developer-guide/sql-api/submitting-multiple-statements)

**매개변수 실행**은 현재 문장이나 선택한 문장의 `?`에 값을 등장 순서대로 연결합니다. Snowflake SQL API는 매개변수가 있는 요청을 한 문장으로 제한합니다. 문자열, 64비트 정수, 최대 38자리 `DECFLOAT`, 실수, 불리언, 16진수 바이너리, `NULL` 값을 요청의 `bindings`에 담습니다. 숨긴 값이 있으면 입력란, 서버 오류 상세, 경고를 가립니다. 쿼리에서 직접 반환한 값은 결과 표에 표시됩니다. SQL과 입력값은 감사 기록에 남기지 않습니다. [Snowflake SQL API의 바인딩](https://docs.snowflake.com/en/developer-guide/sql-api/submitting-requests)

문장별 쿼리 ID·DML 삽입/수정/삭제 통계·서버 오류 코드와 SQLSTATE를 표시합니다. 개별 결과는 필요한 파티션에서 최대 100행·128열을 표시하며, 소수는 서버가 반환한 문자열을 사용합니다. HTTP 응답당 8 MiB와 전체 미리보기 저장 한도를 적용합니다. 중단 시 실행 핸들을 받았으면 SQL API에 취소를 요청하고 서버의 응답을 표시합니다. 서버 실행이 완료된 결과는 수신만 중단합니다. API 실행 제한 시간은 30초이고 앱의 결과 대기 한도는 45초입니다. 쿼리 본문은 실행 감사 기록에서 제외합니다. [Snowflake SQL API 응답과 중단](https://docs.snowflake.com/en/developer-guide/sql-api/reference)

HTTPS 모의 서버로 스크립트 제출, 타입별 바인딩 요청, 문장별 결과 파티션과 중단을 검증했고 Windows 앱에서 편집기 조작을 확인했습니다. 실제 Snowflake 계정 검증이 남아 있습니다.

Snowflake의 **결과 내보내기**는 현재 역할·웨어하우스에서 필터와 정렬이 적용된 테이블·뷰·구체화 뷰를 다시 조회합니다. SQL API 파티션을 번호순으로 요청하고 행을 읽는 대로 UTF-8 CSV 또는 버전형 JSON 파일에 기록합니다. 숫자는 SQL API의 문자열 값을 사용하고, 바이너리는 HEX, 공간 데이터는 EWKB의 HEX로 기록합니다. `VARIANT`와 배열·객체 등은 Snowflake의 `TO_JSON` 표기로 저장합니다. SQL `NULL`은 빈 문자열과 구분합니다. [Snowflake SQL API 결과](https://docs.snowflake.com/en/developer-guide/sql-api/handling-responses) · [Snowflake TO_JSON](https://docs.snowflake.com/en/sql-reference/functions/to_json)

내보내기는 진행 행 수를 표시하며, 중단 시 임시 파일을 정리하고 실행 중인 SQL의 핸들을 받았으면 서버에 중단을 요청합니다. 전체 결과가 확인된 뒤 파일을 저장하고 대상과 행 수를 작업 기록에 남깁니다. 열 4,096개, 행당 값 합계 32 MiB, 압축을 푼 파티션당 512 MiB, 전체 5분 제한이 있습니다. HTTPS 테스트 서버로 압축된 다중 파티션, 다시 요청, 중단을 확인했습니다. 실제 Snowflake 계정 검증이 남아 있습니다.

SQL Server·Oracle·Snowflake에서 열 타입에 맞는 비교와 범위, 문자열 포함, NULL 조건을 서버에서 적용합니다. 여러 열을 정렬하고 NULL 위치를 지정할 수 있습니다. 조회 SQL에는 매개변수 자리가 표시되고 입력값은 별도로 바인딩합니다. SQL Server와 Oracle은 기본 키로 정렬의 동점을 처리해 50행씩 이동할 수 있습니다. 기본 키가 없는 객체와 Snowflake 객체는 서버가 조건을 적용한 결과의 첫 50행을 표시합니다. 필터와 정렬은 연결·객체별로 저장하고 다시 적용할 수 있습니다.

세 엔진의 스키마 패널에서 **객체 검색**을 열면 연결된 데이터베이스 전체 또는 현재 스키마를 대상으로 객체 이름과 열 이름을 검색할 수 있습니다. 테이블·뷰·지원되는 구체화 뷰 중 종류를 선택할 수 있습니다. 검색어의 `%`와 `_`도 문자 그대로 찾습니다. 현재 계정 또는 역할에 공개된 객체가 스키마와 함께 50개씩 표시되며, 객체 이름으로 찾으면 데이터 화면을, 열 이름으로 찾으면 열 구조를 엽니다. [SQL Server 카탈로그 공개 범위](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-objects-transact-sql) · [Oracle ALL_OBJECTS](https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/ALL_OBJECTS.html) · [Snowflake Information Schema](https://docs.snowflake.com/en/sql-reference/info-schema)

**정의 SQL**에서 SQL Server 뷰의 저장된 모듈 정의, Oracle 테이블·뷰·구체화 뷰의 `DBMS_METADATA.GET_DDL`, Snowflake 테이블·뷰·구체화 뷰의 `GET_DDL` 결과를 확인할 수 있습니다. SQL Server에서 권한이 없거나 뷰가 암호화된 경우, Oracle에서 계정에 객체 메타데이터가 공개되지 않은 경우 원문 대신 사유를 표시합니다. Snowflake 보안 뷰의 정의는 소유 역할에 공개됩니다. [SQL Server sys.sql_modules](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-sql-modules-transact-sql) · [Oracle DBMS_METADATA 권한](https://docs.oracle.com/en/database/oracle/oracle-database/26/arpls/DBMS_METADATA.html) · [Snowflake GET_DDL](https://docs.snowflake.com/en/sql-reference/functions/get_ddl)

SQL Server의 **생성 SQL**은 `VIEW DEFINITION` 권한이 있는 일반 디스크 테이블의 카탈로그에서 스크립트를 구성합니다. 열 타입과 정렬 규칙, `IDENTITY`, 계산 열, 마스킹, `SPARSE`, 기본값, 기본·고유 키, CHECK, 나가는 외래 키, 일반 행 저장소 인덱스와 파일그룹을 포함합니다. 스크립트를 재실행할 때는 참조 스키마, 사용자 정의 타입, XML 스키마 모음, 참조 테이블과 파일그룹이 대상 DB에 있어야 합니다. 파티션, 시스템 버전 관리, 특수 인덱스 또는 참조 메타데이터의 비공개로 완전한 스크립트를 구성할 수 없으면 화면에 사유를 표시합니다. [SQL Server CREATE TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql) · [SQL Server CREATE INDEX](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)

정의 SQL은 UTF-8 기준 1 MiB까지 표시하고 복사합니다. 새 `.sql` 파일에 저장할 때 원문의 줄바꿈과 문자를 그대로 기록하며 같은 경로의 기존 파일을 보호합니다. MySQL과 MariaDB의 생성 SQL도 같은 복사·저장 화면을 사용합니다.

Oracle Free 컨테이너에서 정의 SQL을 조회하려면 XML DB가 포함된 Full 이미지가 필요합니다. Full 이미지에서 소유자의 테이블·뷰·구체화 뷰 정의를 반환하는 것을 검증했습니다. Lite 이미지에서는 소유 객체의 `GET_DDL`을 호출할 때 서버가 XDB 라이브러리 오류를 반환했습니다. Oracle 정의 조회는 최대 60초까지 기다리고 완료 후 기존 연결의 호출 제한을 복원합니다. [Oracle Free 컨테이너 이미지 기능 비교](https://container-registry.oracle.com/ords/ocr/ba/database/free)

**화면 설정**은 상단 또는 명령 팔레트에서 엽니다. 기본값은 시스템 테마이며 OS 설정이 바뀌면 작업 공간과 터미널에도 반영합니다. 라이트·다크를 직접 선택하면 창 제목 표시줄까지 적용합니다. 설정은 현재 WebView2 프로필에 저장합니다. 터미널에서는 실행 중인 세션을 유지한 채 화면 색상과 라이트 테마의 기본 ANSI 팔레트를 갱신합니다.

**화면 밀도**를 **컴팩트**로 설정하면 작업 도구, 탐색기, SQL 결과 및 파일 목록의 여백을 줄입니다. 선택한 밀도는 같은 WebView2 프로필에서 다시 적용됩니다. 상단 버튼이나 명령 팔레트에서 **집중 모드**를 켜면 탐색기, 도구 표시줄과 하단 상태 표시줄이 숨겨집니다. 현재 도구와 분할 위치, SQL 초안 및 열린 터미널은 유지됩니다. 집중 모드를 끝내면 기존 탐색기 상태가 돌아옵니다. 앱을 다시 열면 저장된 분할 배치와 탐색기 설정을 복원하고 도구 표시줄을 표시합니다.

탐색기의 **MySQL 계열 연결 추가**에서 MySQL·MariaDB의 호스트, 포트, 사용자, 시작 데이터베이스와 환경을 저장합니다. TLS를 기본으로 사용하고, 시스템 신뢰 저장소와 선택한 CA로 호스트 이름과 인증서를 검증합니다. 암호는 연결할 때만 입력하며 운영 연결에는 `PROD` 확인이 필요합니다. 접속 직후 서버 종류·버전을 읽고 세션의 기본 트랜잭션을 읽기 전용으로 설정합니다. 메타데이터 v15에서 연결을 프로젝트에 저장하고 복제할 때 연결 설정을 함께 복사합니다. [mysql_async TLS 옵션](https://docs.rs/mysql_async/0.37.1/mysql_async/struct.SslOpts.html)

**클라이언트 인증서**에서 PEM 인증서 체인과 암호화되지 않은 PEM 개인 키의 절대 경로를 지정할 수 있습니다. 두 파일은 각각 256 KiB까지 지원합니다. 프로필에는 경로만 저장하고 드라이버가 연결할 때 파일을 읽습니다. `REQUIRE X509` 계정에 인증서를 제시하며 계정 암호와 서버 인증서도 검증합니다. 직접 연결과 SSH 터널의 SQL·내보내기·서버 모니터에도 같은 인증 설정을 사용합니다. [MySQL 암호화 연결](https://dev.mysql.com/doc/refman/8.4/en/using-encrypted-connections.html) · [MariaDB 계정의 TLS 정책](https://mariadb.com/docs/server/reference/sql-statements/account-management-sql-statements/create-user)

**연결 경로**에는 같은 프로젝트에서 프로필의 호스트와 포트로 전달하는 로컬 SSH 터널이 표시됩니다. SSH 점프를 거쳐 시작한 터널도 선택할 수 있습니다. 목록, SQL 실행, 내보내기, 서버 모니터는 선택한 경로를 사용하며 TLS를 켜면 데이터베이스 프로필의 호스트 이름과 신뢰 체인을 검증합니다. 터널이 중단되면 작업 공간에 연결 끊김을 표시합니다. 같은 작업 공간에서 SQL 초안을 유지하며, 터널을 다시 시작하고 연결 창에서 목록을 새로 고침하면 같은 경로로 연결할 수 있습니다. [터널 연결에서의 TLS 호스트 이름 설정](https://docs.rs/mysql_async/0.37.1/mysql_async/struct.SslOpts.html#method.with_danger_tls_hostname_override)

MySQL 작업 공간은 계정이 볼 수 있는 데이터베이스와 테이블·뷰를 각각 검색하고 100개씩 표시합니다. 선택한 객체의 열 이름, 타입, NULL 허용 여부와 키 표시를 읽습니다. 데이터 미리보기는 50행씩 읽으며 처음·이전·다음 페이지로 이동합니다. 한 화면에 앞 128개 열과 값당 512바이트를 표시합니다. 큰 정수와 소수는 문자열로 보존하고 바이너리 값은 HEX로 표시합니다. 긴 UTF-8 값은 문자 경계를 지켜 자릅니다. [MySQL 열 메타데이터](https://dev.mysql.com/doc/refman/8.4/en/information-schema-columns-table.html)

객체 상세는 **인덱스**, **제약조건**, **들어오는 외래 키**를 열 때 각각 조회합니다. 인덱스는 방식, 고유 여부, 열 또는 함수 식, 순서, 접두 길이와 고유값 추정치를 표시합니다. 서버가 제공하면 MySQL 인덱스 가시성 또는 MariaDB의 무시 상태를 표시합니다. 제약조건은 기본 키·고유 키·외래 키·CHECK를 표시하며, 복합 외래 키의 열 대응과 갱신·삭제 규칙을 선언 순서로 읽습니다. 양방향으로 참조 관계를 확인하고, 계정 메타데이터에 표시되는 참조 객체의 구조로 이동할 수 있습니다. 구역마다 최대 100개 항목씩 표시합니다. [MySQL 키 열 대응](https://dev.mysql.com/doc/refman/8.4/en/information-schema-key-column-usage-table.html) · [MariaDB 인덱스 메타데이터](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-statistics-table)

MariaDB의 SELECT 전용 계정에는 키 열과 CHECK를 별도 카탈로그에서 읽습니다. 서버가 해당 계정에 갱신·삭제 규칙을 공개하지 않으면 그 상태를 표시합니다. [MariaDB 키 열 메타데이터](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-key_column_usage-table) · [MariaDB CHECK 메타데이터](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-check_constraints-table)

**생성 SQL**은 테이블 또는 뷰의 `SHOW CREATE` 결과를 표시합니다. 정의 전체를 읽은 경우 복사하거나 새 UTF-8 SQL 파일로 저장할 수 있습니다. 표시 한도는 262,144자입니다. 뷰의 정의를 읽는 데 필요한 권한이 없으면 해당 구역에 사유를 표시합니다. [MySQL SHOW CREATE VIEW](https://dev.mysql.com/doc/refman/8.4/en/show-create-view.html)

**서버 모니터**는 현재 연결과 같은 사용자 및 TLS 설정으로 별도의 읽기 전용 세션을 엽니다. 서버 버전·문자셋·시간대·기본 스토리지 엔진과 가동 시간, 연결 수·한도·실패, 누적 문장·느린 쿼리·트래픽, 행 잠금 대기와 교착 상태 통계를 표시합니다. 보이는 세션은 50개씩 조회하며 실행 중, 잠금 대기, 지정 시간 이상 실행 중인 세션으로 필터링할 수 있습니다. 시간 열은 서버가 보고한 현재 상태의 경과 시간입니다. 실행 SQL은 사용자가 켤 때만 최대 2,048자를 읽습니다. 수동 갱신 또는 5초마다 갱신할 수 있으며 화면을 나가면 모니터 연결을 닫습니다. [MySQL 세션 목록](https://dev.mysql.com/doc/refman/8.4/en/information-schema-processlist-table.html) · [MariaDB 세션 목록](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-processlist-table)

차단 세션은 MySQL의 Performance Schema 데이터 잠금 또는 MariaDB의 InnoDB 잠금 대기 정보에서 읽습니다. 두 엔진 모두 계정에 보이는 세션만 표시합니다. MySQL에서 잠금 테이블을 읽을 수 있어도 계정의 세션 목록에 없는 차단 세션은 식별 정보를 표시하지 않습니다. 잠금 메타데이터를 사용할 수 없으면 그 사유와 세션 상태에 나타나는 잠금 대기를 표시합니다. 한 번에 잠금 관계 1,000개와 세션별 차단 ID 16개까지 읽습니다. [MySQL 데이터 잠금 대기](https://dev.mysql.com/doc/refman/8.4/en/performance-schema-data-lock-waits-table.html) · [MariaDB InnoDB 잠금 대기](https://mariadb.com/docs/server/reference/system-tables/information-schema/information-schema-tables/information-schema-innodb-tables/information-schema-innodb_lock_waits-table)

**필터 및 정렬**은 화면에 표시되지 않는 열에도 적용합니다. 비교·범위·포함·NULL 조건을 최대 16개까지 AND 또는 OR로 결합하고, 정렬은 최대 8개 열의 방향과 NULL 순서를 지정합니다. 서버가 필터와 정렬을 적용한 뒤 페이지를 반환합니다. 기본 키가 있으면 정렬에 포함되지 않은 키 열을 마지막에 적용합니다. 기본 키가 없는 결과는 동률 행의 순서가 달라질 수 있으며, 조회 사이에 데이터가 변경되면 페이지 구성이 달라질 수 있습니다. 날짜만 입력해 DATETIME 또는 TIMESTAMP와 비교하면 해당 날짜의 자정을 사용합니다. 큰 정수와 고정 소수 비교는 정밀도를 유지합니다. [MySQL 비교 시 자료형 변환](https://dev.mysql.com/doc/refman/8.4/en/type-conversion.html) · [MariaDB 비교 시 자료형 변환](https://mariadb.com/docs/server/reference/sql-functions/string-functions/type-conversion)

**조회 SQL**에는 입력값 대신 실제 바인딩에 사용한 매개변수를 표시합니다. **저장된 조건**에서 현재 필터 값과 정렬을 로컬 작업 공간에 보관하고 다시 적용할 수 있습니다. 메타데이터 v16은 기존 SQLite·PostgreSQL 조건의 이름, 범위와 개정 번호를 유지하면서 MySQL 계열 연결을 지원합니다.

MySQL·MariaDB 직접 연결에서 **DB 백업** 또는 **테이블 백업**으로 구조, 데이터, 또는 둘 다를 새 로컬 SQL 파일에 저장합니다. 서버와 주·부 버전이 같은 `mysqldump` 또는 `mariadb-dump`가 필요합니다. 테이블이나 뷰의 조회 권한과 함께 전체 DB의 트리거·루틴·이벤트를 읽을 권한이 필요할 수 있습니다. 연결 설정의 TLS 호스트·CA·클라이언트 인증서를 적용하고 백업 암호는 실행할 때 입력합니다. 운영 연결은 `PROD`를 확인합니다. [MySQL mysqldump](https://dev.mysql.com/doc/refman/8.4/en/mysqldump.html) · [MariaDB mariadb-dump](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump)

데이터 백업은 InnoDB의 단일 트랜잭션에서 `utf8mb4`와 바이너리의 16진수 표현을 사용합니다. 다른 스토리지 엔진의 일반 테이블은 구조만 백업할 수 있습니다. 스냅샷 도중 테이블의 DDL 변경은 피해야 합니다. 전체 DB 구조에는 원본 DB 이름과 기본 문자셋·콜레이션이 포함됩니다. SQL을 복원할 환경에는 원본 정의가 참조하는 객체와 `DEFINER` 계정이 필요할 수 있습니다. 결과에는 파일 크기, SHA-256, 서버와 도구 버전을 표시합니다. 중단하거나 실패하면 임시 파일을 정리합니다. 감사는 연결·환경과 작업 결과를 기록합니다.

**DB 복원**에서 연결한 직접 접속 서버에 새 DB를 만듭니다. 표준 머리글과 완료 기록이 있는 단일 DB SQL, 같은 제품 및 주·부 버전의 서버와 `mysql` 또는 `mariadb` 도구가 필요합니다. 전체 DB 구조에 이름이 선언된 백업은 대상 서버에서 그 이름을 사용하며 문자셋과 콜레이션을 적용합니다. DB 선언이 없는 테이블 백업은 새 이름을 선택할 수 있습니다. 데이터 전용 백업에는 같은 원본 DB의 구조 전용 SQL을 함께 선택하면 구조부터 읽습니다. [MySQL SQL 덤프 복원](https://dev.mysql.com/doc/refman/8.4/en/reloading-sql-format-dumps.html) · [MariaDB 덤프 복원](https://mariadb.com/docs/server/clients-and-utilities/backup-restore-and-import-clients/mariadb-dump)

미리보기에서 원본과 대상 DB, 서버·도구 버전, 테이블·뷰 목록과 파일별 SHA-256을 확인합니다. 확인한 사본은 해당 세션에서 5분간 한 번 사용할 수 있습니다. 백업 출처와 새 DB 이름을 확인하고 `PROD`에서는 운영 확인을 추가합니다. SQL은 대상 서버에서 계정 권한으로 실행되며 참조 객체와 `DEFINER` 계정이 필요할 수 있습니다. 클라이언트는 배치 바이너리 모드로 실행하고 로컬 파일 읽기 기능을 끕니다. [MySQL 클라이언트 옵션](https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html) · [MariaDB 클라이언트 옵션](https://mariadb.com/docs/server/clients-and-utilities/mariadb-client/mariadb-command-line-client)

미리보기와 실행 때 대상 이름을 재확인하며, 실제 SQL 실행 세션에서 새 DB 생성을 먼저 요청합니다. 이름 충돌이면 복원을 중단합니다. 복원 뒤 서버에서 테이블·뷰 목록을 다시 읽어 백업 목록과 대조하고 전체 행 수를 집계합니다. 실행 도중 실패하거나 중단되면 새 DB에 남은 변경을 확인할 수 있도록 부분 복원 또는 생성 상태 미확인을 표시합니다. 실행과 검증의 상태를 구분하고 감사 기록에는 연결·환경·결과를 기록합니다.

연결할 때 **이 연결에서 데이터 그리드 편집 허용**을 선택하면, 표시 가능한 기본 키가 있는 InnoDB 테이블의 **데이터 미리보기**에서 한 행의 여러 셀을 편집할 수 있습니다. 복합 기본 키는 위치를 찾는 데 사용합니다. 일반 텍스트·수치·날짜·시간 값, 빈 문자열, NULL, 서버 기본값을 구분하며 기본 키와 생성 열은 읽기 전용입니다. **변경 미리보기**에서 현재 값과 입력값을 비교하고, 운영 환경에서는 `PROD`를 다시 입력해 적용합니다.

적용 시 별도 쓰기 트랜잭션에서 대상을 잠그고, 조회 가능한 열 전체의 지문과 테이블 구조를 다시 확인합니다. 제약 위반, 값 변환 경고, 동시 변경이 있으면 적용을 중단합니다. 감사 기록에는 대상과 결과를 남기며, 커밋 결과를 확인할 수 없으면 데이터 그리드를 갱신합니다. [MySQL 트랜잭션](https://dev.mysql.com/doc/refman/8.4/en/commit.html) · [MariaDB 행 잠금](https://mariadb.com/docs/server/reference/sql-statements/data-manipulation/selecting-data/for-update)

**MySQL SQL 편집기**의 기본 **읽기 전용 조회**는 현재 데이터베이스에서 문서 또는 선택 영역의 조회 문장 하나를 실행합니다. 줄 번호, MySQL 구문 강조와 찾기·바꾸기를 사용합니다. `SELECT`, `WITH` 조회, `SHOW`, `DESCRIBE`, `EXPLAIN`을 허용하며 파일 입출력, 잠금 변경과 실행 주석은 차단합니다. 문자열·식별자·주석 밖의 `?`에는 문자열, 64비트 정수, 실수 또는 NULL을 바인딩합니다. 입력값을 숨길 수 있으며 실행 전 매개변수는 메모리에만 보관합니다. 서버 SQL 모드로 문장을 다시 확인하고 읽기 전용 트랜잭션에서 준비된 문장으로 실행합니다. [MySQL 준비된 문장](https://dev.mysql.com/doc/refman/8.4/en/sql-prepared-statements.html) · [MySQL 주석 규칙](https://dev.mysql.com/doc/refman/8.4/en/comments.html)

**SQL 스크립트**는 전체 문서, 현재 문장 또는 선택 영역을 로그인 계정 권한으로 실행합니다. 세미콜론과 `DELIMITER` 줄을 구분하고 프로시저 본문을 한 문장으로 전달합니다. 실행 범위에 있는 `?`는 문장 순서대로 바인딩하며 문서 최대 128 KiB에서 문장 100개, 매개변수 64개까지 실행합니다. SQL 모드에 따라 문장을 구분하고 실행 연결의 시작 SQL 모드로 범위를 다시 확인합니다. 운영 연결에서는 스크립트를 실행할 때마다 `PROD`를 입력합니다. [MySQL 프로시저 구분](https://dev.mysql.com/doc/refman/8.4/en/stored-programs-defining.html)

한 실행의 문장은 같은 실행용 연결을 공유합니다. 자동 커밋을 선택할 수 있고 `START TRANSACTION`, `SAVEPOINT`, `COMMIT`, `ROLLBACK`을 사용할 수 있습니다. 실행이 종료되면 열린 트랜잭션을 롤백하고 서버 응답을 표시합니다. DDL의 암시적 커밋과 이미 커밋된 작업은 서버 규칙대로 유지됩니다. 문장 실패나 중단 이후에는 다음 문장을 실행하지 않습니다. 실행 한도는 45초입니다. 중단 시 같은 계정의 별도 연결에서 서버 연결 번호와 이번 실행의 식별자를 확인합니다. 서버가 실행 중단 오류를 반환하면 확인 상태를 표시합니다. 감사 기록에는 연결·환경·결과를 기록하며 SQL과 값은 제외합니다. [MySQL 암시적 커밋](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html) · [MariaDB KILL QUERY](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/kill)

스크립트 결과는 문장 시작 줄·시간·결과 집합·영향받은 행·경고 개수·오류 코드·SQLSTATE를 표시합니다. 결과 집합당 최대 50행·128열, 문장당 32개 결과 집합과 공통 미리보기 저장 한도를 적용합니다. SQL과 실행 결과는 같은 연결의 편집기에서 다시 볼 수 있습니다.

**실행 계획**은 선택 영역이나 전체 편집기의 단일 SELECT 또는 WITH 조회에 대한 예상 계획을 표시합니다. **실행 분석**은 확인을 받은 뒤 읽기 전용 트랜잭션에서 문장을 실제 실행합니다. MySQL의 TREE와 MariaDB의 JSON 결과에서 단계, 테이블·인덱스, 서버가 제공하는 비용과 예상 행, 실제 행·루프·시간을 읽어 단계 트리와 텍스트로 표시합니다. MySQL은 회당 시간, MariaDB는 누적 시간을 표시하며 가장 오래 걸린 리프 단계에 표시를 붙입니다. 계획 결과와 데이터 결과를 오갈 수 있습니다. 서버 식은 바인딩 값 노출을 막기 위해 계획 표시에서 제외합니다. 요청을 중단해도 서버 실행이 끝났는지는 확인되지 않을 수 있습니다. [MySQL EXPLAIN](https://dev.mysql.com/doc/refman/8.4/en/explain.html) · [MariaDB ANALYZE FORMAT=JSON](https://mariadb.com/docs/server/reference/sql-statements/administrative-sql-statements/analyze-and-explain-statements/analyze-format-json)

읽기 전용 조회 결과는 타입과 값, 조회 시간, 행·열 표시 한도를 보여줍니다. 실행에는 탐색과 별도의 연결을 사용합니다. 이 모드에서 중단하거나 20초가 지나면 실행용 연결을 닫고, 서버에서 중단됐는지는 미확인으로 표시합니다. 결과는 최대 50행과 128열을 표시하며, 화면을 전환해도 같은 연결 안에서는 SQL 초안과 마지막 결과를 다시 볼 수 있습니다.

테이블·뷰 또는 읽기 전용 SQL 실행 결과의 **결과 내보내기**는 전체를 UTF-8 CSV·JSON으로 저장합니다. 그리드에서는 적용된 필터와 정렬로 모든 열과 행을 다시 조회합니다. 읽기 전용 편집기에서는 마지막으로 실행한 문장 또는 선택 영역을 조회하고, 매개변수는 다시 입력합니다. JSON은 `stackport.mysql-results` 형식 버전 1로 열과 값을 순서대로 기록합니다. 수치는 정밀도를 유지하는 문자열로 저장하고, NULL은 JSON `null`, 바이너리는 `encoding: "hex"`로 표시한 열의 대문자 HEX 문자열로 보존합니다. CSV에서 NULL은 인용되지 않은 `\N`, 바이너리는 인용된 `X'…'` 형식을 사용합니다. 열 이름과 스프레드시트 수식 보호는 선택할 수 있습니다.

파일은 별도의 읽기 전용 연결에서 행 단위로 기록하며 진행 행 수를 표시합니다. 한 행의 최대 크기는 32 MiB이며 서버 설정에 따라 더 낮을 수 있습니다. 조회와 임시 파일 쓰기는 5분 이내에 완료해야 합니다. 중단 또는 오류 시 임시 파일을 정리하고, 완료한 파일만 새 경로에 저장합니다. 화면에서 행 수와 파일 크기를 확인할 수 있습니다. 성공 작업 기록에는 연결·환경·형식·행 수를 남깁니다. [MySQL 비동기 결과 읽기](https://docs.rs/mysql_async/0.37.1/mysql_async/struct.QueryResult.html)

탐색기의 **Redis 연결 추가**에서 Redis 6.2 이상과 호환되는 단독 서버의 호스트·포트, DB 번호, ACL 사용자와 환경을 프로젝트에 저장합니다. TLS는 시스템 신뢰 저장소와 선택한 PEM CA를 사용해 TLS 1.2 이상에서 호스트 이름과 인증서를 검증합니다. 일반 TCP도 연결 설정에서 명시적으로 선택할 수 있습니다. 연결마다 암호를 입력하며 `PROD` 연결에는 운영 환경 확인이 필요합니다. `INFO server`와 `INFO cluster`로 접속한 서버의 버전과 단독 구성을 확인합니다. DB 0 이외의 번호는 `SELECT` 권한이 필요합니다. 메타데이터 v14에서 Redis 프로필을 보관하며 프로젝트 복제 시 연결 설정을 복사합니다. [Redis 프로토콜](https://redis.io/docs/latest/develop/reference/protocol-spec/)

**키 탐색**은 `SCAN`으로 서버 패턴과 타입 필터를 실행합니다. `COUNT 100`은 서버에 전달하는 탐색 힌트입니다. 비어 있는 페이지에도 다음 커서가 있을 수 있고, 조회 중 키가 바뀌면 결과에 반영될 수 있습니다. 역할에 해당 권한이 있으면 `DBSIZE`, `PTTL`, `MEMORY USAGE`로 DB 전체 키 수와 선택한 키의 만료 시간 및 메모리를 표시합니다. String은 512바이트 구간, List와 Sorted Set은 순서 범위, Hash와 Set은 커서, Stream은 메시지 ID로 값을 탐색합니다. 바이너리 키와 값은 HEX로 표시합니다. 응답 하나가 4 MiB 또는 8,192개 항목을 초과하면 연결을 닫습니다. Windows 통합 테스트는 실제 Redis 서버와 로컬 TLS 연결로 인증·DB 번호·타입별 읽기 및 단절 감지를 확인합니다. [Redis SCAN](https://redis.io/docs/latest/commands/scan/)

연결할 때 `COMMAND INFO`로 Redis JSON의 `JSON.GET`과 `JSON.SET` 등록 여부를 확인합니다. 조회 명령이 확인되면 키 탐색의 타입 필터에 **JSON**이 표시됩니다. 서버가 명령 조회를 제한하면 지원 상태는 미확인으로 표시되며, 탐색 중 JSON 키를 열면 현재 권한으로 조회를 시도합니다. [Redis COMMAND INFO](https://redis.io/docs/latest/commands/command-info/)

편집을 허용한 연결에서 64 KiB 이하의 JSON 문서를 열고 **값 편집**을 선택하면 현재 문서에서 수정을 시작합니다. 검토 화면에서 원본과 입력값 전체를 비교합니다. JSON 숫자를 브라우저에서 변환하지 않고 서버에 입력 텍스트 그대로 전달합니다. 검토 시 처음 불러온 문서와 다시 조회한 값을 비교하고, `WATCH` 이후 키가 바뀌면 적용을 중단합니다. `JSON.SET`은 기존 키의 문서 전체에 적용합니다. 64 KiB를 넘는 문서는 앞부분만 표시합니다. [Redis JSON.GET](https://redis.io/docs/latest/commands/json.get/) · [Redis JSON.SET](https://redis.io/docs/latest/commands/json.set/)

연결할 때 **이 연결에서 키 편집 허용**을 켜면 기존 키의 String 값 교체, Hash 필드 저장, List 항목 교체, Set 멤버 추가, Sorted Set 점수 저장, Stream 메시지 추가를 할 수 있습니다. 텍스트와 HEX 입력을 지원하며 한 번에 최대 1 MiB의 변경을 검토합니다. List는 0부터 시작하거나 음수로 끝에서 지정합니다. Set과 Sorted Set은 멤버를 선택하고, Stream은 한 메시지에 최대 64개의 필드를 추가합니다. 키의 TTL을 유지합니다. 필드별 만료를 지원하는 Redis에서 `HSET`으로 값을 저장하면 해당 필드의 만료가 해제됩니다. [Redis SET](https://redis.io/docs/latest/commands/set/) · [Redis HEXPIRE](https://redis.io/docs/latest/commands/hexpire/) · [Redis XADD](https://redis.io/docs/latest/commands/xadd/)

**변경 미리보기**는 `WATCH` 후 현재 값과 입력값을 표시합니다. 운영 연결은 적용할 때 `PROD`를 다시 입력하고, 5분 이내의 미리보기를 한 번 사용합니다. 앱은 `MULTI`와 `EXEC` 사이에 타입별 명령 하나만 넣습니다. 다른 클라이언트가 대상 키를 변경하거나 서버가 키를 만료시키면 Redis가 트랜잭션을 중단합니다. 적용 응답을 받기 전에 연결이 끊기면 재접속해 현재 값을 확인하도록 안내합니다. 기록에는 연결과 환경, 결과를 남깁니다. 값과 키 원문은 세션에서 사용합니다. [Redis 트랜잭션](https://redis.io/docs/latest/develop/using-commands/transactions/)

**만료 설정**은 키의 현재 TTL과 적용 시점부터 남을 시간을 보여줍니다. 화면에서 초 단위로 입력하며 `PEXPIRE`로 설정하고 `PERSIST`로 해제합니다. 값은 변경하지 않습니다. [Redis PEXPIRE](https://redis.io/docs/latest/commands/pexpire/) · [Redis PERSIST](https://redis.io/docs/latest/commands/persist/)

**키 삭제**는 개별 키나 현재 페이지에서 고른 최대 50개의 키를 검토합니다. 키 이름 합계는 64 KiB까지 지원하며, 바이너리 키를 포함한 이름 전체와 대상 서버·논리 DB·건수를 표시합니다. `DELETE`를 입력해 승인하고, 운영 환경에서는 `PROD`도 입력합니다. 모든 대상을 `WATCH`한 뒤 단일 `UNLINK`로 적용합니다. 하나라도 검토 뒤 변경되거나 만료되면 트랜잭션 전체가 중단됩니다. 삭제 시도와 결과는 키 이름 없이 감사 기록에 남깁니다. [Redis UNLINK](https://redis.io/docs/latest/commands/unlink/) · [Redis 트랜잭션](https://redis.io/docs/latest/develop/using-commands/transactions/)

**서버 모니터**는 연결된 단독 서버의 `INFO`로 메모리·클라이언트·초당 작업·복제 상태와 DB별 키 수·만료 설정·평균 TTL을 읽습니다. `SLOWLOG GET` 권한이 있으면 최근 20건의 명령 이름, 시각, 실행 시간을 볼 수 있습니다. 명령 인수, 클라이언트 주소와 이름은 화면이나 작업 기록에 전달하지 않습니다. 슬로로그 권한이 제한된 계정도 다른 서버 통계를 계속 볼 수 있습니다. [Redis INFO](https://redis.io/docs/latest/commands/info/) · [Redis SLOWLOG GET](https://redis.io/docs/latest/commands/slowlog-get/)

**서버 모니터 → 백업 관리**에서 RDB의 최근 저장 상태와 AOF의 활성화·재작성 상태를 확인합니다. `CONFIG GET`을 허용한 연결에서는 서버 데이터 폴더와 파일 또는 AOF 폴더 이름도 표시합니다. 연결할 때 **백업 관리 허용**을 선택한 경우에만 모든 논리 DB에 적용되는 `BGSAVE` 또는 `BGREWRITEAOF`를 요청할 수 있습니다. 서버 명령 권한과 범위 확인이 필요하며 `PROD`는 실행할 때 다시 입력합니다. 작업이 겹치면 재확인을 안내하고, 요청 접수와 서버의 작업 완료를 구분합니다. 서버의 작업 횟수나 상태로 완료를 확인하지 못하면 결과 미확인으로 표시합니다. 감사에는 연결과 요청·결과를 기록합니다. [Redis BGSAVE](https://redis.io/docs/latest/commands/bgsave/) · [Redis BGREWRITEAOF](https://redis.io/docs/latest/commands/bgrewriteaof/)

RDB 복사에는 서버 파일 읽기 권한과 SFTP 등 별도 전송 수단이 필요합니다. 완료된 RDB는 호환 버전의 격리된 검증 서버에 복사해 `dir`과 `dbfilename`을 맞추고 AOF를 끈 상태에서 시작합니다. AOF 재작성은 실행 서버의 로그를 정리합니다. Redis 7 이상에서 AOF를 확보하려면 재작성과 쓰기가 중지된 시점의 AOF 폴더를 매니페스트와 함께 복사합니다. 이전 버전은 해당 시점의 단일 AOF 파일을 복사합니다. 호환되는 검증 서버의 파일 설정을 맞춰 AOF를 켠 상태에서 시작한 뒤 키와 만료 상태를 확인합니다. [Redis 영속성과 복구](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)

Windows 앱과 TLS·ACL을 적용한 Redis 8.4.7 테스트 연결에서 RDB·AOF 완료, 읽기 전용과 서버 ACL의 실행 차단, `PROD` 확인, 요청 응답 유실의 결과 미확인을 검증했습니다. 생성된 RDB와 재작성된 AOF 폴더를 각각 격리된 Redis에 읽혀 논리 DB 0·3의 키와 만료 시간이 복원되는지 확인했습니다.

**백업 파일 검사**에서는 로컬의 RDB·단일 AOF 파일이나 다중 파일 AOF 매니페스트를 선택합니다. 실행 파일이 설치된 폴더를 지정하면 `redis-check-rdb` 또는 `redis-check-aof`를 임시 사본에 검사 모드로 실행합니다. 다중 파일 AOF에서는 매니페스트와 같은 폴더의 활성 기본·증분 파일을 검사합니다. 구성 파일의 외부 경로와 링크는 거절합니다. 파일마다 크기와 SHA-256을 표시하고, RDB는 형식 버전, 내장 체크섬 검증 여부, 검사 도구가 읽은 키와 이미 만료된 키 수를 표시합니다. [Redis RDB 검사 도구](https://github.com/redis/redis/blob/8.4/src/redis-check-rdb.c) · [Redis AOF 검사 도구](https://github.com/redis/redis/blob/8.4/src/redis-check-aof.c)

Windows 앱과 Redis 8.4.7 도구에서 실제로 만든 RDB와 다중 파일 AOF, 단일 RESP AOF와 RDB 선두부가 있는 단일 AOF를 검사했습니다. RDB 체크섬 손상·생략과 끝 위치 불일치, 잘린 AOF, 매니페스트 구성 파일 누락과 외부 경로, 한글·공백 파일 이름을 확인했습니다. 파일의 SHA-256을 별도로 계산한 값과 비교했고, Redis 연결을 끊은 상태의 RDB·AOF 검사 화면도 통과했습니다.

RDB 검사가 끝나면 **격리 복원 검증**을 실행할 수 있습니다. 앱은 임시 복사본의 SHA-256을 검사 결과와 다시 비교하고, 같은 도구 폴더의 Redis 7 이상을 로컬 루프백에서 실행해 복사본을 불러옵니다. Redis 버전, 로딩한 키와 로딩 때 만료로 건너뛴 키, 논리 DB별 키 수와 만료 설정 수를 표시합니다. 검증이 성공하거나 실패하거나 취소되면 임시 Redis 프로세스와 파일을 정리합니다. AOF의 실제 로딩은 호환 버전의 별도 격리 서버에서 확인할 수 있습니다. [Redis INFO](https://redis.io/docs/latest/commands/info/)

Windows 앱과 Redis 8.4.7로 DB 0·3·31의 복원 결과, 로딩 시점에 만료된 키의 집계, 검사 이후 SHA-256이 달라진 파일의 실행 차단을 확인했습니다.

**Pub/Sub**는 별도 연결에서 채널 이름 하나 또는 패턴 하나를 구독합니다. Redis 논리 DB와 관계없이 서버 전체의 채널에 연결합니다. 연결이 끊기면 재접속을 시도하며, 실패할 때마다 다음 연결까지 대기 시간을 1초에서 늘려 최대 15초까지 기다립니다. 중단된 동안의 메시지는 다시 받지 못합니다. 구독 암호와 최근 100개의 수신 기록은 구독 세션 동안 메모리에 보관합니다. 메시지의 첫 512바이트를 텍스트 또는 HEX로 표시하고, 기록을 비우거나 구독을 종료할 수 있습니다. [Redis Pub/Sub](https://redis.io/docs/latest/develop/pubsub/)

**메시지 발행**은 연결할 때 별도로 허용합니다. 채널과 UTF-8 메시지(최대 64 KiB)를 검토하고, 운영 환경에서는 `PROD`를 다시 입력한 뒤 한 번 보냅니다. 작업 기록에는 연결·환경·결과와 서버가 보고한 수신자 수를 남깁니다. 채널·메시지·암호는 기록에 저장하지 않습니다. 발행 응답 전에 연결이 끊기면 결과 미확인 상태를 표시합니다. [Redis PUBLISH](https://redis.io/docs/latest/commands/publish/)

**명령 콘솔**은 현재 논리 DB에서 지원 목록의 읽기 전용 명령을 한 번에 하나씩 실행합니다. Tab이나 제안 버튼으로 명령 이름을 완성하고, 방향키로 이전 입력을 불러옵니다. 공백을 포함한 인수는 따옴표로 감싸고, 큰따옴표 안의 `\xNN`으로 바이너리 바이트를 지정할 수 있습니다. 단순 문자열·바이트 문자열·정수·배열·NULL을 구분해 표시합니다. 바이트 문자열당 512바이트, 중첩 응답 전체 256개 항목으로 화면 미리보기를 제한합니다. 코어의 RESP 응답 한도를 넘으면 연결을 닫습니다. 실행한 명령과 결과는 연결별로 최근 30건까지 메모리에 남고, 기록을 비우거나 연결을 종료하면 삭제됩니다. `FLUSHDB`, `DEL`, 스크립트, 서버 설정 변경 등은 콘솔에서 차단하고 사유를 표시합니다. [Redis CLI](https://redis.io/docs/latest/develop/tools/cli/) · [RESP](https://redis.io/docs/latest/develop/reference/protocol-spec/)

탐색기의 **PostgreSQL 연결 추가**에서 호스트·포트, 데이터베이스, 사용자 이름과 환경을 프로젝트에 저장합니다. 운영 환경은 `PROD` 확인을 거칩니다. 시스템 신뢰 저장소를 사용하며 사설 CA가 필요하면 PEM 인증서 파일을 함께 지정할 수 있습니다. TLS 1.2 이상에서 서버 인증서의 신뢰 체인과 호스트 이름을 검사합니다. 같은 프로젝트에서 등록한 PostgreSQL 호스트·포트로 전달하는 로컬 SSH 터널이 실행 중이면 **연결 경로**에서 선택할 수 있습니다. SSH 터널을 경유해도 저장된 PostgreSQL 호스트 이름으로 인증서를 검증합니다. [PostgreSQL TLS](https://www.postgresql.org/docs/current/libpq-ssl.html) · [tokio-postgres 연결 옵션](https://docs.rs/tokio-postgres/latest/tokio_postgres/config/struct.Config.html)

Windows에서는 연결 창에서 **연결 성공 후 Windows에 암호 저장**을 선택할 수 있습니다. 성공한 연결의 암호는 현재 Windows 사용자의 자격 증명 관리자에 보관합니다. **저장한 암호 사용**을 선택하면 연결, 서버 모니터, 백업, 복원에 네이티브 코드가 자격 증명을 전달합니다. 백업과 복원에서 `pg_dump`와 `pg_restore`에는 해당 프로세스의 환경으로 전달합니다. 각 작업에서 TLS와 운영 확인을 적용합니다.

저장 암호는 작업 공간의 위치, 연결 ID, 설정과 버전을 확인한 뒤 사용합니다. 이름을 포함한 연결 설정을 바꾼 경우 새 설정으로 연결해 다시 저장할 수 있습니다. 연결 창의 **저장한 암호 삭제**나 연결·프로젝트 삭제로 해당 Windows 항목을 지웁니다. 작업 공간 복사, 연결 복제, 연결 교환 파일과 감사 이력에는 암호가 포함되지 않습니다. [Windows 자격 증명 저장](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credwritew) · [Windows 자격 증명 범위](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw)

로컬 SSH 터널은 점프 호스트를 거쳐 시작할 수 있습니다. 경유 중인 터널이 중단되면 PostgreSQL 세션을 닫고 연결 화면에 터널 이름과 복구 경로를 표시합니다. **SSH 터널 열기**에서 같은 터널을 다시 시작한 뒤 **PostgreSQL 다시 연결**을 누르면 해당 터널이 연결 경로에 선택되어 있습니다. 데이터베이스 작업 공간을 열어 두는 동안 SQL 탭과 초안을 유지합니다.

PostgreSQL 14 이상에서 시스템 스키마를 제외한 스키마와 테이블·파티션 테이블·뷰·구체화 뷰를 조회합니다. 연결과 조회 트랜잭션에 읽기 전용 정책을 적용하고 스키마 접근 권한과 테이블·뷰의 SELECT 권한을 표시합니다. 데이터는 한 번에 100행과 24열, 값 하나를 512자까지 표시합니다. 숫자는 서버가 반환한 문자열을 유지하며 NULL과 빈 문자열을 구분합니다. 기본 키가 있는 객체는 키 순서로 읽습니다. 다른 객체의 페이지 순서는 서버 실행 계획에 따라 달라질 수 있습니다. [PostgreSQL 세션 제한](https://www.postgresql.org/docs/current/runtime-config-client.html) · [PostgreSQL 트랜잭션 모드](https://www.postgresql.org/docs/current/sql-set-transaction.html)

**필터 및 정렬**은 현재 열 페이지 밖의 열도 사용할 수 있습니다. 비교·범위·문자열 포함·NULL 조건을 최대 16개까지 AND 또는 OR로 결합합니다. 입력값은 PostgreSQL이 추론한 타입으로 바인딩합니다. 날짜 범위를 입력할 때는 날짜 선택기를 사용할 수 있습니다. 최대 8개 열에 방향과 NULL 순서를 지정할 수 있으며, 기본 키가 있으면 정렬 목록에 없는 키 열을 마지막에 적용해 동률을 구분합니다. 조건을 적용하거나 초기화하면 첫 행 페이지로 이동합니다. **조회 SQL**과 **SQL로 열기**는 필터 값 대신 `$1` 같은 매개변수를 표시합니다. SQL 편집기에서 문장을 별도로 실행할 때는 값을 입력합니다. [PostgreSQL 매개변수 타입 추론](https://www.postgresql.org/docs/18/sql-prepare.html) · [PostgreSQL 정렬](https://www.postgresql.org/docs/18/queries-order.html)

SQLite와 PostgreSQL 테이블·뷰의 **열 설정**에서 표시 여부, 왼쪽 고정, 위아래 순서와 64~720px 폭을 조정합니다. 적용한 배치와 이름을 붙인 보기 프로필은 연결·스키마·객체별로 현재 WebView2 프로필에 저장합니다. 다시 열면 배치가 복원되며, 새 열은 기존 설정 뒤에 표시합니다. PostgreSQL은 한 번에 최대 24열을 요청하고 고정 열을 각 열 페이지 앞에 표시합니다. 숨긴 열도 행 식별과 조회 조건에 사용할 수 있고 전체 결과를 내보낼 때는 필터·정렬이 적용된 모든 열을 저장합니다.

보기 프로필에는 타입별 색상과 열별 숫자·날짜 표시 형식도 저장합니다. PostgreSQL은 서버가 보고한 타입을 사용하고 SQLite는 값의 저장 타입과 선언된 열 타입을 함께 참고합니다. 숫자 표시는 천 단위로 구분하고, 소수 자릿수를 0~20으로 지정하면 절댓값 기준으로 반올림합니다. 자릿수를 비우면 소수 자릿수를 유지합니다. 날짜 형식은 ISO 날짜 부분의 순서와 구분자를 바꾸고 시간·소수 초·오프셋을 보존합니다. 다른 날짜 표현은 원래 문자열을 표시합니다. 행 식별, 편집과 내보내기는 원래 값을 사용합니다. [SQLite 날짜 저장 형식](https://sqlite.org/datatype3.html#date_and_time_datatype) [PostgreSQL 날짜 출력](https://www.postgresql.org/docs/18/datatype-datetime.html#DATATYPE-DATETIME-OUTPUT)

SQLite와 PostgreSQL의 테이블·뷰·SQL 결과에서 **행 선택**을 켜면 현재 페이지의 개별 행이나 전체 행을 선택할 수 있습니다. **선택한 행 복사**는 보이는 열을 화면 순서대로 탭으로 구분해 클립보드에 씁니다. 다시 조회하거나 페이지를 바꾸면 선택이 초기화됩니다. 숫자·날짜의 표시 서식은 제거하고 현재 조회 결과가 보관한 값을 사용합니다. 선택 범위에 잘린 값, 원문을 보존하지 못한 SQLite 값, SQLite BLOB 또는 NUL 문자가 있으면 해당 행과 열을 알리고 복사를 중단합니다. [Clipboard API](https://www.w3.org/TR/clipboard-apis/#dom-clipboard-writetext)

열 이름 포함과 스프레드시트 수식 보호가 기본으로 켜져 있습니다. 수식처럼 보이는 열 이름이나 텍스트에는 작은따옴표를 덧붙입니다. 원래 텍스트를 StackPort에 다시 붙여넣을 때는 복사 전에 수식 보호를 끌 수 있습니다. 복사한 범위에서 NULL은 따옴표 없는 `\N`, 빈 문자열은 `""`, 실제 문자열 `\N`은 큰따옴표로 감싼 형태입니다. **행 붙여넣기**에서 **StackPort의 NULL과 빈 문자열 복원**을 켜면 두 값을 구분해 미리 볼 수 있습니다.

SQLite와 PostgreSQL의 **저장된 조건**에서 현재 편집 중인 필터 입력값과 정렬을 로컬 작업 공간에 이름을 붙여 저장합니다. 연결과 스키마·테이블 또는 뷰별로 최대 50개를 보관합니다. PostgreSQL에서는 연결의 호스트·포트·데이터베이스·사용자도 저장 범위에 포함합니다. 조건을 선택해 적용하면 첫 행 페이지로 이동하고 날짜 입력 형식과 정렬 우선순위까지 복원합니다. 객체에 필요한 열이 사라진 경우 적용할 때 해당 열을 표시합니다. 저장된 조건은 확인을 거쳐 갱신하거나 삭제할 수 있고, 연결을 삭제하면 그 연결의 조건도 함께 삭제됩니다. 작업 기록에는 작업 종류, 연결, 프로젝트와 환경을 남깁니다. [SQLite 외래 키의 삭제 처리](https://www.sqlite.org/foreignkeys.html)

PostgreSQL 연결 창의 **이 연결에서 데이터 그리드 편집 허용**을 선택하면 지원되는 셀에 편집 버튼이 표시됩니다. 이 선택은 현재 접속에만 적용됩니다. 테이블의 SELECT 및 UPDATE 권한과 즉시 검증되는 기본 키가 필요합니다. 일반 힙 테이블에서 사용자 트리거, 규칙, 생성 열, 상속·파티션 여부를 확인합니다. 기본 키·고유 키·IDENTITY 열은 조회할 수 있습니다. **열 추가**로 같은 행의 최대 16개 셀을 편집하고, 변경된 열의 이전 값과 새 값을 비교합니다. 편집기는 일반 문자열·숫자·날짜·시간·UUID·JSON·XML 등 지원 타입에서 최대 4,096자의 값을 다루고, 빈 문자열과 NULL을 구분합니다. 기본값을 선택하면 기본값 식을 표시하고 실제 값은 변경을 적용할 때 계산합니다. 편집 창이나 앱을 닫을 때 미적용 변경을 버릴지 확인합니다. SQL 편집기의 읽기 전용 조회 모드는 읽기 전용 트랜잭션에서 실행합니다. [PostgreSQL UPDATE](https://www.postgresql.org/docs/18/sql-update.html)

PostgreSQL의 **선택한 행 편집**은 같은 편집 허용 연결에서 현재 페이지의 2~100행을 다룹니다. 행당 16개, 전체 256개 셀까지 각각 값을 바꾸거나 같은 열을 한 값으로 채울 수 있습니다. 편집할 열을 열 때 현재 값을 읽고, 4,096자를 넘는 셀은 읽기 전용으로 표시합니다. 변경 전후를 행별로 확인한 뒤 기본 키와 `ctid`·`xmin`이 일치하는 행에 한 트랜잭션으로 반영합니다. PostgreSQL이 미리보기에서 변환한 값이 저장되므로 `now` 같은 상대 입력은 미리보기의 시각으로 확정됩니다. 서버 기본값은 적용 시 계산합니다. 다른 연결의 수정, 권한·행 수준 보안 또는 제약조건 위반이 있으면 전체를 롤백합니다. 커밋 결과가 불명확하면 다시 연결해 현재 데이터를 확인하도록 표시합니다. [PostgreSQL 시스템 열](https://www.postgresql.org/docs/18/ddl-system-columns.html) [PostgreSQL 잠금](https://www.postgresql.org/docs/18/explicit-locking.html)

같은 연결에서 **행 추가**와 **행 삭제**도 사용할 수 있습니다. 테이블의 SELECT 권한과 해당 작업의 INSERT 또는 DELETE 권한을 확인합니다. 행 추가는 서버에서 입력 타입을 검증한 뒤 명시적 NULL, 빈 문자열, 숫자, 생략한 열의 기본값을 미리 보여줍니다. 기본값과 IDENTITY 값은 적용할 때 서버가 계산합니다. 저장 후 그리드에서 실제 값을 펼쳐 볼 수 있습니다. 삭제는 기본 키와 `ctid`·`xmin`을 함께 확인하므로 미리보기 뒤 갱신된 행은 삭제하지 않습니다. 연쇄 변경을 일으키는 외래 키가 있는 테이블은 그리드 삭제를 차단하며, 서버의 행 수준 보안과 제약조건도 적용됩니다. 운영 환경은 별도 `PROD` 입력이 필요합니다. [PostgreSQL INSERT](https://www.postgresql.org/docs/18/sql-insert.html) [PostgreSQL 트랜잭션 격리](https://www.postgresql.org/docs/18/transaction-iso.html)

**행 붙여넣기**는 같은 편집 허용 연결에서 SELECT와 INSERT 권한이 있는 지원 테이블에 여러 행을 추가합니다. SQLite와 같이 탭 구분 범위를 최대 100행·64열·256 KiB까지 붙여넣고 제목 또는 직접 선택한 대상 열로 매핑합니다. 빈 문자열, NULL, 생략한 값을 구분합니다. PostgreSQL이 대상 열의 타입으로 입력값을 변환하고, 미리보기에서 확인한 값을 서버 형식으로 보관해 한 번의 다중 행 `INSERT`에 전달합니다. `now` 같은 상대 입력도 미리보기에서 확정한 시각을 저장하고, 생략한 열의 기본값과 IDENTITY 값은 적용할 때 계산합니다. 권한·행 수준 보안·제약조건에 걸리면 그 트랜잭션의 행 전체가 롤백됩니다. 커밋 결과가 불명확하면 다시 연결해 실제 데이터를 확인하도록 안내합니다. [PostgreSQL INSERT](https://www.postgresql.org/docs/18/sql-insert.html) [PostgreSQL 행 수준 보안](https://www.postgresql.org/docs/18/ddl-rowsecurity.html)

SQLite와 PostgreSQL에서 여러 행을 추가할 수 있는 테이블의 **파일 가져오기**로 CSV·TSV·TXT를 읽습니다. 자동 인코딩은 UTF-8 또는 BOM이 있는 UTF-16을 사용합니다. UTF-16 LE·BE, 한국어 Windows-949와 Windows-1252도 선택할 수 있습니다. 쉼표·탭·세미콜론·세로줄 중 파일에 맞는 구분자를 제안하고, 여러 방식으로 읽을 수 있으면 직접 선택하도록 요청합니다. 따옴표 안의 구분자·줄바꿈·겹따옴표를 처리하며, 같은 열 수를 가진 레코드를 요구합니다. 가져올 파일과 디코딩한 텍스트는 각각 최대 4 MiB이며 데이터 1,000행·64열까지 읽습니다. [RFC 4180](https://www.rfc-editor.org/rfc/rfc4180) [WHATWG 인코딩](https://encoding.spec.whatwg.org/#names-and-labels)

첫 레코드를 열 이름으로 쓰거나 열의 위치로 대상 열을 제안합니다. 매핑 화면에 값에서 추정한 원본 형식과 예시를 표시합니다. 이 추정은 참고용이며 사용자가 대상과 빈 셀 정책을 정합니다. **StackPort의 NULL과 빈 문자열 복원**을 켜면 따옴표 없는 `\N`을 NULL로, 따옴표로 감싼 빈 값을 빈 문자열로 읽습니다. 파일 미리보기에는 처음 25행과 전체 추가 예정 건수를 표시합니다. 승인 전에 전체 행의 형식을 검증하고, PostgreSQL의 서버 변환은 같은 읽기 트랜잭션에서 나눠 실행합니다. 적용은 선택한 기존 테이블에 한 트랜잭션으로 추가합니다. 제약조건, 중복 키, 행 수준 보안에서 거절되면 모두 롤백합니다. 운영 환경은 `PROD` 입력을 요구합니다. 작업 기록에는 대상 테이블·결과·추가 행 수를 남기며 파일 이름·경로와 원본 값은 기록에서 제외합니다. [PostgreSQL 매개변수 상한](https://www.postgresql.org/docs/18/limits.html)

JSON 가져오기는 일반 객체 배열과 StackPort의 SQLite·PostgreSQL 결과 JSON 버전 1을 지원합니다. 같은 1,000행·64열·4 MiB 한도를 적용합니다. 객체 배열의 속성 이름으로 열을 제안하고, 중복 속성 이름을 발견하면 해당 레코드를 표시합니다. 결과 JSON의 열 이름과 순서를 그대로 두므로 이름이 겹치는 열도 위치별로 매핑할 수 있습니다. 속성이 빠진 값은 대상의 기본값을 사용하고, 명시적 `null`과 빈 문자열을 구분합니다. 숫자 토큰과 중첩 객체·배열의 원문을 JavaScript 숫자로 변환하지 않고 전달합니다. PostgreSQL 열은 서버의 대상 타입으로 검증합니다. [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259)

SQLite의 **원본 형식 유지**는 64비트 정수, 내보낸 실수, 불리언의 정수 표현과 BLOB을 각각의 저장 타입으로 넘깁니다. 일반 JSON의 소수와 64비트 범위를 넘는 정수는 원문을 문자열로 보존하며, 필요한 열은 직접 실수나 정수 입력으로 바꿀 수 있습니다. SQLite가 선택한 타입이나 값을 바꾸면 전체를 롤백합니다. StackPort 결과 JSON의 BLOB·`bytea`는 바이트로 복원할 수 있습니다. SQLite BLOB은 셀당 2,048바이트까지 지원하며 PostgreSQL은 서버에서 표시한 값의 미리보기 길이 제한을 적용합니다. [PostgreSQL 바이너리 타입](https://www.postgresql.org/docs/18/datatype-binary.html)

XML 가져오기는 선택한 레코드 경로의 요소를 행으로 읽고, 속성(`@`)과 바로 아래 요소를 열에 매핑합니다. 이름은 네임스페이스 URI와 로컬 이름으로 구분합니다. 빠진 요소는 DB 기본값, 빈 요소는 빈 문자열, 참 값의 `xsi:nil`은 SQL NULL로 처리합니다. 하위 요소나 데이터 속성을 가진 셀은 XML로 직렬화해 전달합니다. 같은 이름의 하위 요소가 한 레코드에서 반복되면 행과 요소를 표시하고 경로를 다시 선택할 수 있습니다. DTD와 처리 지시문은 파싱 전에 거절합니다. XML도 1,000행·64열·4 MiB 한도와 대상 타입 검증을 적용하며, 문자 인코딩은 파일 설정에서 선택합니다. [XML 1.0](https://www.w3.org/TR/xml/) · [XML 네임스페이스](https://www.w3.org/TR/xml-names/) · [`xsi:nil`](https://www.w3.org/TR/xmlschema11-1/#xsi_nil)

PostgreSQL 그리드 **원본 열기**는 상속 자식이 없는 일반 힙 테이블의 긴 텍스트·가변 길이 문자·JSON·JSONB·XML과 `bytea` 셀에서 사용할 수 있습니다. 텍스트는 4,096자, 바이너리는 4,096바이트씩 텍스트 또는 HEX로 확인합니다. **전체 값 저장**은 하나의 읽기 전용 스냅샷에서 순차 조회해 텍스트는 UTF-8, `bytea`는 원본 바이트로 기록합니다. 행 버전과 SELECT 및 행 수준 보안 정책을 다시 확인하며 행이 바뀌면 그리드 재조회를 안내합니다. 읽기가 끝난 뒤 새 파일을 게시하고 작업 기록에는 셀 내용과 파일 경로를 포함하지 않습니다. [PostgreSQL 행 버전 시스템 열](https://www.postgresql.org/docs/18/ddl-system-columns.html) · [바이너리 부분 조회](https://www.postgresql.org/docs/18/functions-binarystring.html)

원본 창에서 JSON·JSONB 들여쓰기와 XML 구조는 요청할 때 최대 256 KiB를 읽습니다. JSON 보기에는 PostgreSQL이 반환한 숫자 토큰과 키를 그대로 표시합니다. XML은 노드와 속성을 텍스트로 렌더링합니다. DTD·처리 지시문이 있거나 구조 한도를 넘으면 원문으로 돌아갑니다. `bytea`는 1 MiB 이하이고 폭과 높이가 각각 2,048픽셀 이하인 정적 PNG를 미리 볼 수 있습니다. 미리보기에서 메타데이터를 제외하고 **전체 값 저장**에서는 실제 셀 바이트를 그대로 기록합니다. [PostgreSQL JSON·JSONB 타입](https://www.postgresql.org/docs/18/datatype-json.html) · [PNG 형식](https://www.w3.org/TR/png-3/)

**변경 적용**은 5분 이내의 미리보기를 한 번 사용합니다. 운영 연결에서는 `PROD`를 입력해야 합니다. 쓰기 트랜잭션은 테이블 구조와 권한을 확인하고 기본 키로 행을 고정한 뒤 행 버전을 확인합니다. 선택한 셀을 한 UPDATE로 적용하고 반환된 값들을 확인한 뒤 커밋합니다. 다른 연결이 선택한 행을 수정했거나 서버가 타입·제약조건·권한을 거부하면 행의 변경 전체가 롤백됩니다. 커밋 확인 응답이 돌아오지 않으면 재접속해 현재 값을 확인하도록 표시합니다. 작업 기록에는 연결·환경·변경 결과를 남깁니다. [PostgreSQL 시스템 열](https://www.postgresql.org/docs/18/ddl-system-columns.html) · [트랜잭션](https://www.postgresql.org/docs/18/tutorial-transactions.html)

객체의 **데이터**와 **구조**를 오갈 수 있습니다. 구조에서 현재 역할의 객체 권한과 행 수준 보안 상태를 확인하고, 열의 기본값·생성 식·정렬 규칙, 제약조건, 인덱스, 트리거, 파티션을 열어 봅니다. 선택한 항목만 읽기 전용 스냅샷으로 조회하며 목록은 32개씩 표시합니다. 현재 역할에 스키마 `USAGE`와 대상 `SELECT` 권한이 있으면 외래 키의 참조 대상이나 하위 파티션의 구조로 이동할 수 있습니다. [PostgreSQL 권한 검사 함수](https://www.postgresql.org/docs/18/functions-info.html) · [PostgreSQL 열 카탈로그](https://www.postgresql.org/docs/16/catalog-pg-attribute.html)

**객체 검색**은 연결한 데이터베이스의 사용자 스키마 전체 또는 선택한 스키마에서 테이블·파티션 테이블·뷰·구체화 뷰를 찾습니다. 이름·열 이름·객체와 열의 주석·SQL 정의를 대소문자 구분 없이 검색하고, 검색어 없이 객체 종류만 선택할 수도 있습니다. SQL 정의 검색에는 뷰 본문, 열의 기본값과 생성 식, 제약조건·인덱스·트리거·파티션 정의가 포함됩니다. 결과는 현재 역할에 `USAGE`와 `SELECT`가 있는 객체를 40개씩 표시하며, 일치한 항목의 구조로 이동합니다. [PostgreSQL 객체 카탈로그](https://www.postgresql.org/docs/18/catalog-pg-class.html) · [PostgreSQL 시스템 정보 함수](https://www.postgresql.org/docs/18/functions-info.html)

객체 탐색에서 스키마를 선택하고 **관계도**를 열면 읽기 전용 스냅샷에서 해당 스키마의 테이블과 외래 키로 직접 연결된 다른 스키마의 테이블을 가져옵니다. 양쪽 끝에 스키마 `USAGE`와 테이블 `SELECT`가 있는 관계를 표시합니다. 복합 키는 선언 순서대로 열을 대응시키고, 자기 참조도 표시합니다. 다른 스키마의 테이블에 표시되는 관계는 처음 선택한 스키마에 닿는 관계입니다. 목록을 검색하거나 캔버스에서 테이블을 선택하고 **테이블 열기**로 기존 데이터 그리드에 이동합니다. 테이블 150개, 열 16,000개, 외래 키 열 대응 4,000개까지 읽으며, 한도를 넘으면 관계도에 오류를 표시합니다. [PostgreSQL 제약조건 카탈로그](https://www.postgresql.org/docs/18/catalog-pg-constraint.html)

**DB 백업**, **스키마 백업**, **테이블 백업**에서 전체 DB·선택한 스키마·일반 테이블과 구조만·데이터만·둘 다를 지정합니다. 파티션 테이블과 하위 테이블을 함께 백업하려면 해당 스키마 또는 전체 DB를 선택합니다. 개별 스키마와 테이블의 아카이브를 복원할 때 대상에 참조 객체가 필요할 수 있습니다. 원본 역할에 해당 범위를 덤프할 권한이 필요하며 운영 연결에서는 암호와 함께 `PROD`를 입력합니다. [pg_dump 옵션과 선택 범위](https://www.postgresql.org/docs/18/app-pgdump.html)

Windows의 PostgreSQL 설치 폴더에서 서버 주 버전 이상인 같은 버전의 `pg_dump.exe`와 `pg_restore.exe`를 찾습니다. 별도로 설치한 도구는 앱을 시작하기 전에 `STACKPORT_POSTGRES_TOOLS_DIR`에 신뢰할 수 있는 절대 `bin` 경로를 지정할 수 있습니다. 연결 프로필의 서버 이름으로 TLS 인증서를 검증하고 실행 중인 SSH 터널 경로를 유지합니다. 프로필에 PEM CA를 지정하면 해당 파일을 사용하고, 그 밖에는 16 이상 도구의 TLS 라이브러리 신뢰 저장소를 사용합니다. 새로 입력한 암호는 자식 프로세스의 메모리에 전달합니다. [libpq TLS 연결 옵션](https://www.postgresql.org/docs/18/libpq-connect.html) · [libpq 환경 변수](https://www.postgresql.org/docs/18/libpq-envars.html)

압축 `.backup` 파일은 지정 폴더의 임시 파일에 생성합니다. `pg_restore`로 아카이브를 SQL로 읽고 SHA-256을 계산한 경우에만 새 이름으로 게시합니다. 연결이 끊기거나 작업을 취소하거나 30분을 넘기면 도구 실행을 중단합니다. 화면의 **아카이브 검사 통과**는 아카이브를 읽어 SQL로 변환한 결과입니다. [pg_restore](https://www.postgresql.org/docs/18/app-pgrestore.html)

연결 화면의 **백업 복원**에서 `pg_dump` 커스텀 아카이브와 현재 서버에 새로 만들 DB 이름을 지정합니다. 미리보기는 현재 역할의 `CREATEDB` 권한, 이름 충돌과 서버 버전을 확인한 뒤 백업의 출처 DB, 도구 버전, 목차와 SHA-256을 표시합니다. 대상 서버 주 버전은 원본 서버와 덤프 도구의 주 버전 이상이어야 합니다. 미리보기 때 로컬 임시 사본을 만들어 복원에 사용하고, 5분이 지나거나 확인을 취소하면 사본을 닫습니다. 아카이브의 SQL은 현재 역할의 권한으로 실행되므로 출처 확인과 새 DB 이름을 입력해야 합니다. 운영 연결에서는 암호와 `PROD`도 다시 입력합니다. [pg_dump 버전 호환성](https://www.postgresql.org/docs/18/app-pgdump.html) · [pg_restore의 신뢰 경계](https://www.postgresql.org/docs/18/app-pgrestore.html)

앱은 `template0`에서 고유한 이름의 임시 DB를 만들고 `PUBLIC`의 `CONNECT` 권한을 회수합니다. `pg_restore`가 객체와 데이터를 단일 트랜잭션으로 복원한 뒤에만 확인한 최종 이름을 부여합니다. 이때 PostgreSQL이 이름 충돌을 검사합니다. 복원 역할이 객체를 소유하고 대상의 권한과 기본 테이블스페이스를 사용합니다. 의존성 오류로 트랜잭션이 실패하면 롤백된 임시 DB의 이름을 알려 주며, 연결이 끊기거나 중단 요청과 커밋이 겹친 경우 대상 상태를 다시 확인하도록 안내합니다. 성공 후 TLS로 다시 연결해 사용자 테이블 수를 읽고, 작업 기록에 새 DB 이름과 결과를 남깁니다. Windows 테스트는 앱이 만든 백업을 새 DB에 복원하고 행 값·복합 외래 키·롤백을 확인합니다. 테스트 도구 경로는 `STACKPORT_POSTGRES_TOOLS_DIR`로 지정합니다. [CREATE DATABASE](https://www.postgresql.org/docs/18/sql-createdatabase.html) · [pg_restore 트랜잭션과 옵션](https://www.postgresql.org/docs/18/app-pgrestore.html)

**서버 모니터**는 현재 데이터베이스에 독립적인 읽기 전용 TLS 연결을 엽니다. 암호와 운영 환경 확인을 다시 입력하며 작업 공간이 사용 중인 SSH 터널을 그대로 경유합니다. 작업 공간 연결이 종료되면 모니터 연결도 닫힙니다. 현재 DB 세션을 50개씩 읽고, 실행 중·잠금 대기·느린 실행·열린 트랜잭션 대기로 필터링합니다. 잠금 대기에는 차단 PID가 표시되며 느린 실행의 기준 시간은 1~3600초에서 설정합니다. 현재 역할이 볼 수 있는 실행 SQL을 펼쳐 확인할 수 있습니다. 서버 가동 시간, DB 백엔드 수, 서버 연결 한도, 커밋·롤백, 블록 읽기·버퍼 캐시 적중, 임시 파일 기록, 교착 상태와 통계 초기화 시각을 표시합니다. 수동으로 새로 고치거나 모니터가 표시되는 동안 5초 간격으로 조회할 수 있습니다. [PostgreSQL 활동·통계 조회](https://www.postgresql.org/docs/14/monitoring-stats.html) · [PostgreSQL 잠금 차단 PID](https://www.postgresql.org/docs/14/functions-info.html)

모니터의 **누적 쿼리**는 `pg_stat_statements`가 설치되고 사전 로드된 현재 DB의 통계를 40개씩 조회합니다. 최대 실행 시간 하한을 적용하거나 현재 역할로 한정할 수 있고, 호출 횟수·평균·최대·누적 실행 시간으로 정렬합니다. 처리 행 수, 공유·임시 블록과 전체 통계 초기화 시각을 함께 표시합니다. 확장 소유 뷰가 다른 스키마에 설치되어 있어도 해당 위치를 찾아 읽습니다. 다른 역할의 SQL이나 쿼리 ID는 PostgreSQL이 현재 역할에 허용한 경우에만 반환합니다. 확장 설치, 사전 로드, 권한과 뷰 호환성 상태는 누적 쿼리 화면에 표시합니다. [PostgreSQL 누적 쿼리 통계](https://www.postgresql.org/docs/18/pgstatstatements.html)

서버에서 가져온 뷰의 조회 정의, 인덱스와 트리거의 생성 SQL, 열·제약조건·파티션의 정의 일부를 복사하거나 새 UTF-8 SQL 파일로 저장합니다. 정의가 16,384자를 넘으면 앞부분을 표시합니다. 복사와 저장은 화면에서 전체를 확인할 수 있는 정의에 제공됩니다. [PostgreSQL 정의 조회 함수](https://www.postgresql.org/docs/18/functions-info.html)

PostgreSQL에서 **SQL 편집기**를 선택하거나 객체의 **SQL로 열기**를 눌러 SQL을 작성합니다. 연결별 탭과 UTF-8 파일을 지원하며 파일을 저장할 때 BOM과 LF·CRLF를 유지합니다. **읽기 전용 조회**에서는 `Ctrl+Enter`로 선택한 SQL 또는 문서의 단일 문장을 실행하고, **SQL 스크립트**에서는 같은 단축키로 선택 영역 또는 문서 전체를 실행합니다. `Ctrl+Shift+Enter`는 두 모드에서 커서가 속한 문장을 실행합니다. 달러 인용 문자열, 이스케이프 문자열, 중첩 블록 주석과 SQL 루틴의 `BEGIN ATOMIC` 본문 안의 세미콜론을 문장 경계에서 제외합니다. 서버 오류에 위치가 있으면 편집기에서 이동할 수 있습니다. [PostgreSQL SQL 문법](https://www.postgresql.org/docs/18/sql-syntax-lexical.html) · [PostgreSQL SQL 함수 본문](https://www.postgresql.org/docs/18/sql-createfunction.html)

**읽기 전용 조회**는 단일 조회를 읽기 전용 트랜잭션에서 실행한 뒤 롤백하고 세션 상태를 정리합니다. 연결당 한 실행이 진행되며 서버의 기본 문장 제한은 8초입니다. 취소는 기존 연결과 같은 검증 TLS 경로를 사용하고 실행 중인 쿼리가 서버 중단을 반환하면 확인 상태를 표시합니다. 연결을 다시 열어야 하는 경우에도 작성 중인 SQL 탭은 메모리에 유지합니다. 조회 결과는 최대 100행·24열로 가져오고, 25행씩 다시 실행 없이 표시합니다. 마지막으로 실행한 최대 네 탭의 결과를 현재 작업 공간에서 유지합니다. [PostgreSQL 확장 프로토콜과 취소](https://www.postgresql.org/docs/18/protocol-flow.html) · [PostgreSQL 트랜잭션 모드](https://www.postgresql.org/docs/18/sql-set-transaction.html)

**SQL 스크립트**는 현재 연결 계정의 권한으로 최대 100개 문장을 순서대로 실행합니다. 자동 커밋을 켜면 명시적 트랜잭션 밖에서 성공한 문장마다 커밋합니다. 끄면 첫 문장 앞에 트랜잭션을 열고, 스크립트의 `COMMIT`으로 작성한 변경을 저장합니다. `BEGIN`, `ROLLBACK`과 저장점을 스크립트 안에서 사용할 수 있습니다. 오류가 발생하면 이후 문장의 실행을 중단하고 앞선 문장의 결과를 유지합니다. 한 번의 실행은 최대 45초이며, 종료 시 열린 트랜잭션을 롤백하고 임시 객체와 세션 설정을 정리합니다. 정리 여부가 불확실하면 연결을 닫고 결과에 표시합니다. 운영 연결에서 실행할 때마다 `PROD`를 입력해야 합니다. 감사 로그에는 실행 결과와 대상 연결만 기록하고 스크립트와 조회 값은 저장하지 않습니다. [PostgreSQL 쿼리 프로토콜](https://www.postgresql.org/docs/18/protocol-flow.html) · [PostgreSQL 세션 정리](https://www.postgresql.org/docs/18/sql-discard.html)

스크립트 결과에서 문장별 시작 줄, 실행 시간, 영향을 받은 행, 조회 결과와 서버 알림을 확인합니다. 조회 미리보기는 문장당 100행·24열과 값당 512자, 전체 그리드 1 MiB를 한도로 표시하며 결과는 끝까지 읽습니다.

**실행 및 저장**에서 새 JSON 경로를 지정하면 선택 영역 또는 문서 전체의 반환 행을 실행 중 임시 파일에 기록합니다. 화면의 미리보기 한도와 별개로 각 문장의 시작 줄, 전체 열과 행, 영향을 받은 행 수를 순서대로 저장합니다. 값은 정확한 문자열 또는 JSON `null`로 기록하고, 매개변수 실행에서 바이너리로 반환된 값은 `binary_hex` 객체로 보존합니다. 행당 파일 입력은 최대 32 MiB이며 실행 제한은 5분입니다. 완료 파일만 원래 경로에 게시합니다. 경로에 기존 파일이 있으면 실행 전에 알리고, 저장 직전에 다른 파일이 생긴 경우에도 그 파일을 보존합니다. 오류나 취소로 파일 저장을 마치지 못한 경우에는 먼저 커밋한 변경이 DB에 남을 수 있습니다. 감사 기록에는 저장 여부와 행 수를 남깁니다.

스크립트의 `$1` 같은 위치 매개변수는 실행 범위에서 먼저 찾아 한 번에 입력받습니다. 같은 번호는 범위 안에서 값을 공유하며, 실제로 사용한 번호의 값만 입력합니다. 값과 NULL을 PostgreSQL의 Bind 메시지로 전달하고 각 문장의 타입은 앞선 문장이 실행된 뒤 서버가 추론합니다. 타입이 모호할 때는 `$1::numeric`처럼 지정할 수 있습니다. 입력 오류가 발생하면 이후 문장을 중단하며, 이미 커밋한 문장을 다시 실행하지 않습니다. 입력값이 서버의 오류나 알림에 포함될 수 있어 매개변수가 있는 실행에서는 오류 코드와 위치를 표시하고 상세 메시지와 알림은 숨깁니다. 쿼리 결과로 반환된 값은 미리보기에 표시됩니다. [PostgreSQL 매개변수 타입 추론](https://www.postgresql.org/docs/18/sql-prepare.html) · [PostgreSQL Bind 메시지](https://www.postgresql.org/docs/18/protocol-message-formats.html)

매개변수를 사용하는 문장의 미리보기는 정수·정밀 소수·날짜·텍스트·JSON 등의 값을 읽으며, 시간대가 있는 타임스탬프는 UTC로 표시합니다. 바이트 배열과 텍스트 변환을 구현하지 않은 결과 타입은 앞부분을 HEX로 표시합니다. 서버에서 문자열로 보고 싶은 값은 조회 열을 `::text`로 지정할 수 있습니다. [PostgreSQL 결과 형식](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY)

SQLite와 PostgreSQL의 **매개변수 세트**에 이름을 붙여 값을 저장하고, 세트를 불러오거나 갱신·삭제할 수 있습니다. 같은 프로젝트의 같은 엔진과 SQL 실행 범위에서 세트를 표시합니다. PostgreSQL의 읽기 전용 조회에서는 서버가 유추한 매개변수 타입도 확인하며, 스크립트는 별도의 세트 목록을 사용합니다. 기본 세트를 지정하면 다음 입력 창에 일반 값과 NULL을 채웁니다. 숨김 값은 종류와 재입력 표시만 남으며, 값을 다시 입력해야 실행할 수 있습니다. 작업 공간 메타데이터 v19에서 SQL 본문의 식별 해시와 세트를 관리합니다. 프로젝트 복제는 세트를 새 프로젝트에 복사합니다.

MySQL·MariaDB의 읽기 전용 조회와 스크립트, SQL Server의 선택 배치, Oracle의 SQL·PL/SQL, Snowflake의 단일 문장 매개변수 실행에도 세트를 사용할 수 있습니다. 세트는 실행할 문장과 매개변수 목록을 기준으로 찾습니다. MySQL 계열은 인용 구문에 영향을 주는 세션 SQL 모드도 반영하며, 읽기 전용 조회와 스크립트는 각각 세트를 관리합니다. SQL Server·Oracle·Snowflake에서 저장한 정밀 소수는 문자열로 보관해 원래 자릿수를 유지합니다.

조회 SQL에 `$1` 같은 변수가 있으면 PostgreSQL이 추론한 타입을 표시합니다. 타입이 모호한 경우 `$1::numeric`처럼 캐스트를 지정할 수 있습니다. 값은 UTF-8 바인딩으로 전달하므로 숫자의 정밀도를 유지하고, 빈 문자열과 NULL을 구분합니다. 최대 32개 변수에 값당 16 KiB까지 입력할 수 있습니다. 잘못된 값을 서버가 거부하면 입력한 값을 유지해 수정할 수 있으며 앱의 오류 메시지는 원본 값을 표시하지 않습니다. **숨기기**는 입력 필드를 가립니다. 서버가 조회 결과로 반환한 값은 그리드에 표시됩니다. 실행 입력값은 로컬 기록이나 파일에 저장하지 않습니다. [PostgreSQL 매개변수 타입 추론](https://www.postgresql.org/docs/18/sql-prepare.html) · [Parse·Bind 메시지](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY)

PostgreSQL 편집기의 **실행 계획**은 선택 영역 또는 문서의 단일 조회를 `EXPLAIN`으로 분석해 예상 행과 비용, 계획 수립 시간, 스캔·조인·인덱스 단계를 표시합니다. **실행 분석**을 확인하면 같은 문장을 읽기 전용 트랜잭션에서 실제로 실행해 서버 시간, 루프당 실제 행과 시간, 공유·임시 버퍼 블록 및 정렬 방식을 측정합니다. 분석은 조회 미리보기의 100행 제한을 적용하지 않고, 서버의 8초 문장 제한과 취소 경로를 사용합니다. 루프 합산 시간이 가장 긴 리프와 예상·실제 행 수가 크게 다른 단계에 표시를 붙입니다. 같은 탭에서 단계·텍스트 계획과 이전 조회 결과를 오갈 수 있습니다. 표시 데이터는 계획의 객체 이름과 지표로 한정하며, 최대 2 MiB에서 200단계까지 읽습니다. [PostgreSQL EXPLAIN 옵션](https://www.postgresql.org/docs/18/sql-explain.html) · [PostgreSQL 실행 계획 해석](https://www.postgresql.org/docs/18/using-explain.html)

테이블·뷰 또는 SQL 조회 결과에서 **결과 내보내기**를 눌러 전체 결과를 UTF-8 CSV·JSON으로 저장합니다. 그리드에서 내보낼 때는 적용한 필터 값과 정렬을 그대로 사용해 전체 열과 행을 다시 조회합니다. SQL 편집기는 마지막 실행의 문장 범위를 사용하며, 매개변수 값은 다시 입력합니다. JSON은 열 이름과 PostgreSQL 타입을 순서대로 기록하고 셀을 서버의 전체 텍스트 표현 또는 JSON `null`로 저장합니다. 숫자의 정밀도, 중복 열 이름, NULL과 빈 문자열을 유지합니다. CSV에는 열 이름과 수식 접두사 보호 옵션이 있습니다. CSV의 NULL은 인용되지 않은 `\N`으로 기록합니다. [PostgreSQL 포털과 결과 형식](https://www.postgresql.org/docs/18/protocol-flow.html#PROTOCOL-FLOW-EXT-QUERY)

읽기 전용 조회를 스트리밍하며 기록한 행 수를 표시합니다. 조회와 임시 파일 완료 제한은 5분이며, 한 행에 32 MiB를 초과하는 텍스트가 있으면 오류를 표시합니다. 취소나 조회 오류 시 임시 파일을 정리합니다. 조회가 완료되면 임시 파일을 동기화한 뒤 기존 파일이 없는 경로에만 게시합니다. 성공 기록에는 연결과 작업 종류, 행 수를 남깁니다.

SQLite 연결 헤더의 **관계도** 또는 명령 팔레트에서 읽기 전용 ERD를 엽니다. 한 번의 SQLite 읽기 스냅샷으로 기본 스키마의 테이블·열·외래 키를 가져옵니다. 캔버스에서 선택한 테이블과 직접 연결된 테이블을 표시하고, 화살표는 외래 키를 선언한 테이블에서 참조 대상으로 향합니다. 복합 외래 키는 하나로 묶고 암시 참조는 대상 기본 키 순서로 해석합니다. 참조 테이블·열을 찾을 수 없거나 암시 참조의 열 수가 맞지 않으면 표시합니다. 테이블 이름 및 관계 유형으로 목록을 좁히고, 확대/축소하거나 **테이블 열기**로 열·인덱스·생성 SQL을 확인합니다. 테이블 512개와 열·외래 키 열 대응 30,000개까지 읽으며 한 페이지에 외래 키 16개를 표시합니다. [SQLite 외래 키](https://www.sqlite.org/foreignkeys.html)

관계도나 명령 팔레트의 **SQLite 데이터 사전**에서 선택한 스키마 객체 또는 기본 스키마의 전체 테이블·뷰를 UTF-8 Markdown 또는 단일 HTML 파일로 저장합니다. 열 유형·기본값·생성 열 특성, 선언된 키와 외래 키 대응, 인덱스와 트리거를 문서화합니다. SQLite에 저장된 생성 SQL을 함께 실으므로 해당 정의의 제약식과 주석을 읽을 수 있습니다. 한 읽기 스냅샷에서 최대 512개 객체의 스키마 메타데이터를 가져와 최대 16 MiB의 새 파일로 저장합니다. 작업 기록에는 연결과 객체 수가 남습니다. [SQLite 스키마](https://www.sqlite.org/fileformat2.html) · [SQLite 메타데이터 PRAGMA](https://www.sqlite.org/pragma.html)

관계도나 명령 팔레트의 **SQLite 스키마 비교**에서 보관되지 않은 프로젝트의 기준·대상 연결을 선택합니다. 각 파일의 독립 읽기 스냅샷에서 기본 스키마의 최대 512개 객체를 읽고, 한쪽에만 있는 객체와 달라진 정의를 보여줍니다. 열·키·인덱스·트리거와 저장된 정의 SQL을 비교합니다. 정의 SQL의 주석과 내부 공백 차이도 표시 범위에 포함됩니다. 기준에만 있는 일반 테이블·뷰의 생성, 대상에만 있는 객체의 삭제, 양쪽에 있는 뷰의 재정의는 복사할 수 있는 SQL 초안으로 제공합니다. [SQLite ALTER TABLE](https://sqlite.org/lang_altertable.html)

**선택한 변경 검토**에서 한 번에 최대 32개의 새 일반 테이블·뷰와 출력 열이 같은 뷰 재정의를 검토합니다. `PROD` 대상에는 직접 확인 입력이 필요합니다. 적용할 때 양쪽 파일과 스키마가 검토와 일치하는지 확인하고, 대상 쓰기 잠금을 얻은 상태에서 새 백업 파일을 생성하고 무결성을 검사합니다. 이어 한 트랜잭션에서 적용한 뒤 선택한 정의·뷰 열·외래 키를 검사합니다. 적용이나 검증에 실패하면 대상 구조를 되돌리고 사전 백업 파일을 보존합니다. 테이블 행 복사와 기존 테이블 변경·삭제는 미리보기의 적용 범위에서 제외됩니다. [SQLite Online Backup API](https://sqlite.org/c3ref/backup_finish.html) · [SQLite PRAGMA](https://sqlite.org/pragma.html)

공통 작업 공간의 상단에는 현재 프로젝트와 작업 기록, 도구 전환을 배치합니다. 어느 도구에서든 프로젝트 탐색기를 펼치거나 접을 수 있습니다. 탐색기에서 SQLite 연결·객체를 선택하면 데이터베이스 화면이 열리고, 저장된 SSH 연결을 선택하면 해당 연결 설정과 터미널로 이동합니다. 도구 버튼에 초점이 있을 때 좌우 화살표와 Home·End로 이동하고 Enter로 엽니다. 열려 있는 터미널과 RDP 작업 수는 다른 도구에서도 표시합니다. 원격 파일 화면의 연결 표시는 연결할 때의 프로젝트와 서버를 계속 보여줍니다. [PuTTY의 저장된 세션](https://the.earth.li/~sgtatham/putty/latest/htmldoc/Chapter4.html#config-saving) · [Navicat의 객체 탐색](https://www.navicat.com/manual/online_manual/en/navicat_18/win_manual/main_window.html) · [MobaXterm의 세션 관리](https://mobaxterm.mobatek.net/documentation.html)

Windows 상단의 **빠른 연결**은 `Ctrl+Shift+Q`와 명령 팔레트에서도 열립니다. `ssh://`, `postgresql://`, `rdp://`, `sqlite:///` 주소와 SQLite 파일 경로를 인식합니다. 프로토콜이 없는 호스트는 포트 3389면 RDP, 5432면 PostgreSQL, 그 밖에는 SSH로 표시합니다. 입력한 대상과 일치하는 현재 프로젝트의 저장 연결은 이름과 환경을 표시해 기존 설정을 그대로 엽니다. 새 SSH 대상은 호스트 키 확인 화면이나 등록 창에서 이어서 작업하고, RDP는 원격 화면 양식, PostgreSQL과 SQLite는 등록 양식에 값을 채웁니다. 빠른 연결 주소에서 암호와 URL 옵션은 거절하며 접속은 각 프로토콜의 기존 흐름에서 실행합니다. [PuTTY의 저장 세션 열기](https://the.earth.li/~sgtatham/putty/0.83/htmldoc/Chapter3.html#using-cmdline-load) · [MobaXterm의 빠른 연결](https://mobaxterm.mobatek.net/documentation.html)

탐색기에서는 프로젝트 선택과 검색창을 상단에 고정하고 **데이터베이스**와 **SSH** 그룹을 각각 접을 수 있습니다. 데이터베이스 목록은 저장된 연결을 엔진에 관계없이 이름순으로 표시합니다. 각 연결에서 엔진과 주소를 확인하고, 탐색기나 빈 데이터베이스 화면의 **데이터베이스 연결 추가**에서 엔진을 고릅니다. 연결 이름·엔진·파일 경로·호스트와 포트·환경, 그리고 열린 SQLite 연결의 테이블과 뷰를 공백으로 구분한 검색어로 찾습니다. 일치한 객체는 연결 아래에 표시하며, 필터를 지우면 접기 상태가 복원됩니다. 프로젝트를 바꾸면 검색을 초기화합니다. 프로젝트 이름 변경·복제·보관·삭제와 작업 공간 복사는 **프로젝트 관리**에서 실행합니다. [Navicat의 탐색기 필터](https://www.navicat.com/manual/online_manual/en/navicat_18/win_manual/main_window.html)

탐색기의 **즐겨찾기**에서 개인 또는 프로젝트 범위를 선택한 뒤 SQLite·PostgreSQL·SSH 연결이나 SQLite·PostgreSQL 테이블·뷰 옆의 별을 누릅니다. 즐겨찾기는 작업 공간 메타데이터에 저장되며, 탐색기 검색으로 다른 연결의 고정 객체도 열 수 있습니다. 프로젝트를 복제하면 프로젝트 범위의 항목이 복제된 연결을 가리킵니다. 개인 범위는 원래 프로젝트에 유지됩니다. 연결 정의를 삭제하면 관련 항목도 제거됩니다. 메타데이터 v13으로 이관할 때 이전 작업 공간을 검증해 백업하고 기존 즐겨찾기를 보존합니다.

PostgreSQL에 접속한 뒤 탐색기에 객체 이름이나 `스키마.객체`를 입력하고 **연결 이름에서 검색**을 누르면 현재 서버의 조회 가능한 객체를 페이지별로 표시합니다. 검색 결과나 객체 화면에서 즐겨찾기에 추가할 수 있습니다. 즐겨찾기는 저장 연결·스키마·객체 이름을 보존합니다. 연결을 종료한 상태에서 즐겨찾기를 열면 먼저 일반 접속 화면에서 TLS·암호·환경 확인을 거치고, 접속 후 서버에서 현재 객체와 조회 권한을 확인합니다.

Windows 하단 상태 표시줄에는 창에서 열린 터미널 탭과 RDP 창, 실행 중인 SSH 터널 수를 표시합니다. 각 항목으로 해당 도구를 열 수 있습니다. PostgreSQL 연결 상태와 SQLite·PostgreSQL 쿼리 실행·취소 상태는 다른 도구를 사용하는 중에도 표시됩니다.

상단의 **명령 팔레트**나 `Ctrl+Shift+P`로 도구, 활성 프로젝트, 현재 프로젝트의 SQLite·SSH 연결, 선택된 SQLite 연결의 테이블·뷰를 검색합니다. ↑·↓로 결과를 이동하고 Enter로 엽니다. 최근에 실행한 명령 최대 12개는 현재 실행의 메모리에 두고 검색어가 없을 때 먼저 표시합니다. 검색 대상은 이름·유형·환경과 도구 키워드입니다. 파일 경로, 호스트 주소, 자격 증명, SQL 본문, 쿼리 값과 터미널 출력은 검색 대상에 포함하지 않습니다. 저장된 SSH를 선택하면 기존 호스트 키 확인 화면이 열립니다. [WAI-ARIA 콤보 상자](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) · [모달 대화 상자](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)

데스크톱의 **화면 분할**은 현재 도구에 두 번째 도구를 더해 좌우 또는 상하로 표시합니다. **배치 설정**에서 2×2를 한 번에 적용하거나 원하는 영역을 좌우·상하로 다시 나눌 수 있습니다. 최대 네 영역에서 각각 한 도구를 표시하며, 이미 열린 도구를 다른 영역에 지정하면 두 도구의 위치를 바꿉니다. 분할선마다 마우스나 방향키로 비율을 조절할 수 있고 Home과 End는 현재 분할의 최소·최대 위치로 이동합니다. 탐색기에서 이미 표시 중인 도구의 연결이나 객체를 열면 그 위치에서 작업합니다. 영역을 이동하거나 닫아도 같은 앱 실행에서 터미널 세션, SQL 초안과 각 도구의 작업 상태가 유지됩니다. [WAI-ARIA 분할선](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)

Windows 로컬 터미널은 ConPTY와 xterm.js를 사용하며 PowerShell(`-NoProfile`) 또는 CMD(`/D`) 세션을 별도 탭으로 엽니다. 출력은 메모리에 유지하며 파일 저장은 사용자 요청으로 시작합니다. 셸과 실행 프로그램은 자체 기록 설정을 사용합니다. 화면을 숨겨도 세션을 유지하며 출력 대기열은 유한한 크기로 제한하고 밀리면 프로세스에 역압을 적용합니다. 창 크기는 PTY에 전달하고, 여러 줄 붙여넣기 및 탭·앱 종료 시 확인합니다. Windows 작업 개체에 연결된 프로세스는 탭이나 앱을 닫을 때 정리합니다. Windows 10 1809 이상의 ConPTY가 필요하며 WSL·사용자 지정 셸, 재연결, 명령 기록 관리와 다른 OS 검증은 아직 없습니다.

터미널 상단에 PowerShell·CMD 열기와 SSH 연결을 배치합니다. 직접 입력하는 SSH 연결은 별도 창에서 호스트·포트, 사용자·인증 방식을 각각 나란히 보여줍니다. 탐색기에서 저장된 SSH 연결을 열면 해당 서버와 환경을 연결 창에 표시합니다.

터미널 탭은 끌거나 탭에 초점을 둔 상태에서 `Alt+←/→`로 이동합니다. 탭 오른쪽의 **터미널 탭 관리**, 우클릭 또는 `Shift+F10`에서 고정하거나 순서를 변경할 수 있습니다. 고정한 탭은 왼쪽에 표시하며 고정 상태가 같은 탭끼리 순서를 바꿉니다. 탭을 이동해도 실행 중인 셸과 출력은 유지됩니다.

**탭 복제**와 **최근 닫은 탭**은 같은 종류의 새 셸 또는 새 SSH 연결을 엽니다. 저장된 SSH는 현재 연결 정의를 다시 확인하고, 직접 입력한 SSH는 마지막 호스트·포트·사용자를 채웁니다. SSH는 기존 인증 방식을 선택하며 호스트 키 및 운영 환경 확인을 거칩니다. 키 파일 경로, 암호, 출력과 명령은 복제하지 않습니다. 닫은 탭은 앱 메모리에 최대 12개까지 둡니다. **고정하지 않은 탭 닫기**는 확인한 뒤 해당 탭의 작업을 종료하고, 닫기에 실패한 탭은 남겨 오류를 표시합니다.

각 터미널 탭의 현재 화면과 최대 10,000줄 메모리 스크롤백을 일반 문자열로 검색할 수 있습니다. 이전·다음 이동, 대소문자 구분과 `Ctrl+Shift+F`를 지원합니다. 검색어는 해당 탭에만 보관하고 검색을 닫거나 탭이 종료되면 지웁니다.

터미널의 `출력 저장`은 저장 버튼을 누른 시점에 선택한 탭의 기본 화면과 메모리 스크롤백을 캡처합니다. TXT는 화면 너비에 맞춰 줄바꿈된 내용을 한 줄로 이어 저장하며, ANSI는 xterm.js 직렬화로 색상과 커서 이동 등 화면 형식을 저장합니다. `vim` 같은 프로그램의 대체 화면과 이미 스크롤백에서 밀려난 출력은 저장 범위에서 제외합니다. 두 형식 모두 16 MiB 이하의 UTF-8 파일을 새 경로에 게시합니다. 사용자 입력이 화면에 표시된 경우 파일에 포함되며, 내용과 경로는 작업 기록에 추가하지 않습니다. [xterm.js SerializeAddon](https://github.com/xtermjs/xterm.js/tree/6.0.0/addons/addon-serialize)

다른 탭이나 화면을 보고 있는 동안 터미널에 출력 바이트가 도착하면 해당 탭에 `새 출력`을 표시합니다. 탭을 확인하면 표시를 지우고, 출력 내용과 표시 상태는 저장하지 않습니다. 제어 문자만 들어온 경우에도 표시될 수 있으며 OS 알림이나 창이 가려졌는지 감지는 아직 제공하지 않습니다.

Windows SSH는 시스템 OpenSSH의 `ssh-keyscan`으로 대상의 공개 키 후보를 조회합니다. 이 조회 자체는 서버를 인증하지 않으므로 사용자가 별도의 경로로 SHA-256 지문을 비교해 하나를 선택해야 합니다. 확인한 키는 앱 데이터의 별도 `ssh-trust.sqlite`에 호스트·포트별로 저장하며 암호와 개인 키는 저장하지 않습니다. 실제 접속에서는 선택한 키만 들어 있는 임시 파일과 [OpenSSH의 엄격한 호스트 키 검사](https://man.openbsd.org/ssh_config#StrictHostKeyChecking)를 사용합니다. 개인·시스템 SSH 설정은 읽지 않으며 프록시·포워딩을 자동 실행하지 않습니다. 키가 달라지면 인증 전에 차단되고, 별도 재조회와 `교체` 확인 후에만 기존 키를 원자적으로 교체합니다. 신뢰·교체 이력은 호스트·포트·이전/새 지문과 함께 같은 트랜잭션에 기록하며 작업 기록 화면에서 조회할 수 있습니다. 저장소의 변조 방지와 자동 백업은 아직 없습니다. 정상 종료 시 임시 키 파일은 삭제되지만 앱이 강제 종료되면 공개 키만 포함된 파일이 남을 수 있습니다.

SSH 터미널은 현재 Windows OpenSSH와 영문 호스트/IP·영문 사용자 이름만 지원합니다. 호스트 키는 Ed25519, ECDSA 및 RSA-SHA2를 지원하며 서버 인증서는 아직 지원하지 않습니다. 프로젝트별 연결 정의에 이름·호스트·포트·사용자·환경을 저장하고 수정·삭제할 수 있습니다. 동시 수정은 버전으로 감지하고 연결 시 확인한 정의가 바뀌었으면 접속을 중단합니다. 저장된 `PROD` 연결은 Rust 명령에서 `PROD` 입력을 확인하고 터미널에 환경을 표시합니다. 직접 입력한 임시 연결은 환경 미지정이며 저장된 연결의 운영 환경 확인이 적용되지 않으므로 전체 호스트에 대한 접근 정책이 아닙니다. 연결 정의 삭제와 호스트 키 교체는 이미 열린 세션을 종료하지 않습니다. 암호는 터미널에서 직접 입력하고 암호 인증 프롬프트는 한 번으로 제한합니다. 세션에 키 파일을 1~8개 지정할 수 있습니다. OpenSSH는 선택한 키만 사용하며 서버의 인증 시도 제한에 도달하면 나머지 키를 확인하기 전에 종료될 수 있습니다. 암호화된 키의 암호는 터미널에 직접 입력하며 키 경로와 암호는 저장하지 않습니다. OpenSSH의 경로 확장을 피하기 위해 키 경로의 `%`와 `${...}`는 거절합니다. 에이전트에 등록된 공개 키 파일 사용은 OpenSSH에 의존하며 별도 실서버 검증이 필요합니다. ProxyJump·터널, 자동 재연결과 다른 OS 검증은 아직 없습니다. 사용자 지정 SSH 설정은 보안 정책을 우회하지 않도록 적용하지 않습니다.

저장된 SSH 연결과 주소를 직접 입력하는 SSH 연결에서 **파일 탐색 함께 열기**는 기본으로 켜져 있습니다. 암호 또는 개인 키로 한 번 인증하고 하나의 SSH 연결에서 셸과 SFTP v3를 엽니다. 다단계 경유는 저장된 연결에서 사용할 수 있습니다. 파일 탐색을 끊거나 SFTP 시작이 실패해도 터미널을 사용할 수 있으며, 파일 창에서 같은 연결의 SFTP를 다시 열 수 있습니다. 터미널을 닫으면 공유 연결도 닫힙니다. 별도로 열어 둔 SFTP 연결은 공유 파일 탐색이 닫히면 이전에 보던 폴더로 돌아옵니다. 네 영역을 모두 사용 중이면 SFTP에 연결한 뒤 파일 탐색 도구를 선택해 원격 파일을 봅니다. SSH 연결 창의 체크를 풀면 터미널만 엽니다. 동기화 설정을 프로필로 저장하려면 저장된 SSH 연결을 사용합니다. [SSH 연결 프로토콜](https://datatracker.ietf.org/doc/html/rfc4254)

파일 탐색 도구에서 저장된 SSH 연결로 SFTP만 열 수도 있습니다. 인증 전에 저장한 SSH 호스트 키를 비교하며, 암호와 암호화된 개인 키를 지원합니다. 인증 정보는 연결 설정에 보존하지 않습니다. `PROD` 확인과 연결 정의 변경 검사는 SSH 터미널과 동일하게 적용합니다. 로컬·원격 폴더를 나란히 표시하며 상위 폴더 이동·새로고침·숨김 파일 표시를 제공합니다. 원격 항목의 파일 크기·수정 시간·소유자와 그룹 ID·권한은 서버가 제공한 값입니다. 첫 2,000개 항목을 표시하고 유효한 원격 경로의 원본 바이트는 목록 이동에 유지합니다. [Russh](https://github.com/Eugeny/russh) · [Russh SFTP](https://github.com/AspectUnk/russh-sftp)

SSH 터미널과 SFTP의 **경유 서버 사용**은 같은 프로젝트의 SSH 연결을 최대 3개 순서대로 열고, 이전 서버의 `direct-tcpip` 채널 안에서 다음 SSH 서버와 키 교환을 수행합니다. 직접 접속할 수 없는 주소도 경유 서버를 통해 확인할 수 있습니다. 호스트와 포트별 저장 지문이 있으면 일치해야 인증을 시도합니다. 첫 지문은 별도 확인을 위해 표시하고 해당 서버에는 자격 증명을 보내기 전에 연결을 끊습니다. 사용자가 신뢰한 뒤 계속하면 앞서 확인한 경유 서버부터 다시 연결합니다. 각 단계의 인증·키 검증·전달 오류와 `PROD` 확인은 해당 경유지 또는 대상 이름과 함께 표시됩니다. [RFC 4254 TCP/IP 전달 채널](https://www.rfc-editor.org/rfc/rfc4254.html#section-7.2)

경유 터미널은 대상 SSH 채널에서 `xterm-256color` PTY를 요청하고 일반 터미널 탭과 같은 입출력, 크기 조절, 출력 검색 및 종료 상태 표시를 사용합니다. 프로그램 내에서 SSH 채널을 열고, 닫기나 셸 종료 후 대상과 경유 연결을 역순으로 정리합니다. SFTP 연결을 끊을 때도 같은 순서로 닫습니다. 탭 복제와 다시 열기는 경유 서버 순서만 보관합니다. [RFC 4254 SSH 상호작용 세션](https://www.rfc-editor.org/rfc/rfc4254.html#section-6)

**네트워크 → SSH 터널**에서 로컬·동적 SOCKS5·원격 전달을 프로젝트에 저장합니다. 기존 로컬 전달 설정은 이관 후에도 수신 포트·대상·버전을 유지합니다. 시작할 때 저장된 SSH 연결과 추가 경유 서버들의 지문·인증을 확인합니다. 포트 `0`은 자동 할당입니다. 로컬과 동적 전달은 `127.0.0.1`에서만 받고 Windows에서는 독점 바인드를 사용합니다. 포트 충돌·예약 오류는 SSH 인증 전에 표시합니다. 동적 전달은 확인을 거쳐 무인증 SOCKS5 TCP `CONNECT`를 받고, 요청의 도메인·IPv4·IPv6를 SSH 서버로 전달합니다. [RFC 1928 SOCKS5](https://www.rfc-editor.org/rfc/rfc1928.html) · [RFC 4254 포트 전달](https://www.rfc-editor.org/rfc/rfc4254.html#section-7) · [Windows 독점 포트 바인딩](https://learn.microsoft.com/en-us/windows/win32/winsock/using-so-reuseaddr-and-so-exclusiveaddruse)

원격 전달은 SSH 서버에 `127.0.0.1` 수신을 요청합니다. 실제 바인드는 서버의 `GatewayPorts` 설정에 따르므로 시작 전에 범위를 확인합니다. 앱은 등록된 주소·포트와 일치하고 서버가 루프백 출발지로 보고한 `forwarded-tcpip` 채널에 한해 사전에 지정한 로컬 대상에 연결합니다. 중단하면 새 채널 수락을 멈추고 원격 포트 해제를 요청합니다. 모든 전달 유형은 실제 포트·동시 접속 수·양방향 전달 바이트와 마지막 오류를 표시하며 중단·단절 시 전달 중인 연결을 닫습니다. 암호·키 파일 경로·경유 선택·전달 본문은 작업 공간에 기록하지 않습니다. [OpenSSH GatewayPorts](https://man.openbsd.org/sshd_config#GatewayPorts) · [RFC 4254 포트 전달](https://www.rfc-editor.org/rfc/rfc4254.html#section-7)

일반 원격 파일·폴더의 **권한 · UID/GID** 값을 선택하면 Unix 모드 또는 소유자·그룹을 변경할 수 있습니다. 모드는 8진수 0000~7777이며 UID와 GID는 10진수로 입력합니다. `PROD`에서는 변경할 때마다 `PROD`를 확인합니다. 서버가 보고한 기존 경로·유형·속성을 검증하고 변경 뒤 값을 다시 조회합니다. 서버가 OpenSSH의 `lsetstat` 버전 1을 광고하면 그 요청을 사용하며, 다른 서버에는 SFTP의 `SETSTAT`을 사용합니다. 서버가 미지원하거나 계정 권한으로 거부하면 이유를 표시합니다. 요청과 경로 검사를 하나로 묶는 기능은 SFTP에 없으므로 실행 중 경로가 바뀔 가능성이 남습니다. [OpenSSH SFTP 프로토콜 확장](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)

연결을 열면 파일 화면 상단에 서버와 환경을 표시합니다. 넓은 창에서는 양쪽 목록을 독립적으로 스크롤할 수 있고, 좁은 창에서는 로컬·원격 전환 버튼으로 각 폴더의 경로와 목록을 유지한 채 작업합니다.

각 목록은 현재 폴더의 항목을 이름으로 검색하고, 이름·크기·수정 시각을 오름차순 또는 내림차순으로 정렬할 수 있습니다. 두 창의 검색과 정렬은 독립적입니다. 폴더는 목록 위에 표시되며, 속성을 확인할 수 없는 항목은 해당 정렬 그룹의 끝에 표시됩니다. 폴더를 새로고침하면 검색을 유지하고, 다른 폴더를 열면 검색을 지웁니다.

두 파일 창은 각각 방문했던 폴더를 기억합니다. 화살표 버튼이나 `Alt+←/→`로 이동하면 해당 폴더를 다시 읽습니다. 방문했던 폴더에 접근할 수 없으면 현재 목록을 유지하고 오류를 표시합니다. 뒤로 이동한 위치에서 새 폴더를 열면 그 경로부터 이어집니다. `Ctrl+L`은 초점이 있는 파일 창의 경로를 선택합니다.

**폴더 비교**는 현재 선택된 로컬·원격 폴더를 다시 읽고 바로 아래 항목을 대소문자가 같은 이름끼리 비교합니다. 한쪽에만 있는 항목, 유형·크기·수정 시각 차이와 메타데이터를 확인합니다. 이름 인코딩이 정확하지 않거나 목록 한도 때문에 상대 항목 존재를 판단할 수 없으면 확인 필요로 표시합니다.

**하위 폴더 포함**을 선택하면 루트 기준 상대 경로로 두 구조를 비교합니다. 양쪽을 각각 깊이 16단계, 폴더 256개, 항목 4,000개까지 조회합니다. 폴더별 목록 한도는 2,000개입니다. 링크·경로 변경·목록 실패 등으로 확인할 수 없는 하위 경로는 누락과 구분합니다. 확인한 같은 상대 경로 파일은 개별적으로 내용 비교할 수 있습니다.

**동기화 계획**은 비교 시점의 목록과 확인한 SHA-256으로 폴더 생성, 파일 복사·갱신, 삭제 후보를 미리 보여줍니다. 단방향은 기준 쪽의 차이를 대상에 반영하는 작업을 계산하며, 대상에만 있는 항목은 삭제 반영을 켰을 때 후보에 포함합니다. 폴더는 확인하지 않은 하위 항목이나 보존 대상이 있으면 남깁니다. 양방향은 각 쪽에만 있는 항목을 서로 복사하는 후보를 제시하고 같은 경로의 변경은 충돌로 표시합니다. 크기와 시각이 같아도 SHA-256을 직접 확인하지 않은 파일은 내용 확인 대상으로 표시합니다. 제외 패턴은 대소문자를 구분하며, 한 줄에 한 개의 상대 경로를 입력합니다. 이름 패턴의 `*`, `?`와 경로 구간의 `**`를 지원합니다.

**새 항목 실행**은 미리 본 폴더 생성과 새 파일 복사를 확인 후 순차 실행합니다. 원격 쓰기가 있는 `PROD` 연결은 별도로 `PROD` 입력을 확인합니다. 원본의 확인 가능한 크기·수정 시각과 양쪽 경로를 재검사하고, 생성된 대상은 기존 파일을 덮어쓰지 않는 방식으로 저장합니다. 상위 폴더를 만들지 못하면 그 아래 항목을 건너뜁니다. 항목별 결과와 파일 SHA-256을 보여주며 작업 기록에 시작·완료 여부와 성공한 작업 수를 저장합니다.

**남은 작업 중단**을 누르면 진행 중인 항목의 결과를 확인한 뒤 후속 항목을 건너뜁니다. 완료한 항목 수와 건너뛴 항목은 실행 결과에서 확인할 수 있으며 중단은 작업 기록에 남습니다.

**갱신 후보 검증**은 양쪽 파일이 각각 16 MiB 이하인 단방향 후보의 SHA-256을 계산합니다. 내용이 다른 파일의 양쪽 해시를 확인하면 **동기화 실행**에 갱신을 포함할 수 있습니다. 실행 중 실제로 옮긴 바이트가 원본 해시와 같고, 교체 직전 대상의 해시와 확인한 메타데이터가 유지되어야 게시합니다. 원격은 OpenSSH의 원자적 이름 변경 확장과 기존 Unix 소유자·그룹·권한 보존을 요구합니다. Windows 로컬 교체는 같은 볼륨에 임시 원본 사본을 두고 운영체제의 파일 교체 기능을 사용합니다. 장애 후 즉시 복구할 수 없으면 사본의 위치를 결과에 표시합니다. 파일 시스템과 SFTP는 대상 해시를 교체 조건으로 전달하는 방법을 제공하지 않으므로 마지막 확인 뒤의 동시 변경 가능성이 남습니다. [ReplaceFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew) · [OpenSSH SFTP 확장 명세](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)

단방향에서 삭제 반영을 켠 뒤 **삭제 후보 검증**을 실행하면 대상 파일의 SHA-256과 메타데이터를 저장합니다. 확인은 현재 연결과 비교한 두 폴더에 한해 5분 동안 한 번 사용할 수 있습니다. 실행하려면 `삭제`를 입력하며 운영 서버에 쓰는 계획은 `PROD`도 입력해야 합니다. 실행 시 기준 쪽 경로의 부재와 대상이 그대로인지 다시 확인합니다. 폴더는 하위 항목부터 개별적으로 처리하고 마지막에 빈 상태를 확인합니다. 제외 대상과 새로 생긴 항목은 보존됩니다. 파일 시스템과 SFTP는 최종 확인과 삭제를 하나의 조건부 요청으로 묶는 기능을 제공하지 않습니다. 삭제를 포함한 실행은 별도로 작업 기록에 남습니다.

두 폴더에 같은 이름의 일반 파일이 있으면 행의 **내용 비교**로 양쪽 파일의 SHA-256을 확인할 수 있습니다. 파일당 최대 16 MiB까지 읽으며, 목록에 표시된 크기·수정 시각이 달라지면 폴더를 다시 읽도록 안내합니다. 해시는 비교 창에서 확인할 수 있습니다.

파일 탐색의 **파일 비교**에서는 현재 로컬 폴더와 SFTP 폴더의 일반 파일을 하나씩 직접 선택합니다. 파일 이름이 달라도 내용 비교, 차이 보기, 텍스트 병합을 사용할 수 있습니다.

내용이 다르고 두 파일이 각각 64 KiB 이하면 **차이 보기**에서 해시에 사용한 바이트를 비교합니다. 양쪽이 UTF-8이면 줄 추가·삭제, 줄 번호, 줄바꿈 형식, BOM과 공백을 확인할 수 있습니다. 바이너리는 같은 바이트 오프셋에서 다른 값을 HEX로 강조합니다. 텍스트는 차이와 주변 문맥을 최대 240줄, 바이너리는 차이가 있는 앞쪽 16바이트 구간 64개까지 표시합니다.

**텍스트 병합**에서는 각 변경 구간에 넣을 로컬 또는 원격 내용을 선택합니다. 기본 선택은 로컬이며, 선택한 줄의 줄바꿈과 마지막 줄 상태는 보존됩니다. 결과의 BOM은 별도로 선택할 수 있습니다. 미리 본 결과는 기존 파일이 없는 로컬 절대 경로에 임시 파일을 기록한 뒤 게시합니다. 로컬과 원격 원본은 그대로 보존됩니다.

로컬·SFTP 목록의 미리보기는 일반 파일을 읽기 전용으로 엽니다. HTML·XML·JSON·CSV를 포함한 UTF-8은 처음 64 KiB까지 원문으로 표시하고, 바이너리는 처음 4 KiB까지 오프셋·HEX·ASCII로 표시합니다. 정적 PNG는 1 MiB와 가로·세로 각 2,048픽셀 한도를 적용하며 부가 메타데이터를 제거한 이미지로 표시합니다. 텍스트와 이미지 데이터는 미리보기 창에만 둡니다. 읽기 전후의 파일 크기와 수정 시간이 달라지면 결과를 폐기합니다. [W3C PNG 규격](https://www.w3.org/TR/png-3/)

SFTP 다운로드는 선택한 일반 파일을 최대 32 KiB 단위로 읽고, 사용자가 지정한 로컬 폴더의 임시 파일에 기록합니다. 전송한 바이트 수, 평균 속도와 예상 잔여 시간을 표시하며, 완료 후 받은 바이트의 SHA-256을 표시합니다. 전송 전후의 원격 크기와 수정 시간을 비교하고 예상 길이보다 일찍 끝난 파일은 폐기합니다. 같은 크기와 수정 시간을 가진 동시 변경은 SFTP 메타데이터만으로 검출할 수 없습니다. 파일을 디스크에 동기화한 뒤 새 경로로 옮기며, 같은 이름의 기존 파일은 그대로 보존합니다. 전송 중 중단을 요청하면 진행 중인 요청이 정리된 뒤 임시 파일을 없앱니다. 현재 연결당 한 파일을 처리하며, 앱 강제 종료 시 임시 파일이 남을 수 있습니다. [SFTP v3 파일 읽기](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.4)

SFTP 업로드는 현재 원격 폴더에 임시 파일을 새로 만들고 최대 32 KiB씩 전송합니다. 임시 파일을 다시 읽어 원본 SHA-256과 크기를 비교하며, 서버에서 지원하면 원격 `fsync`도 실행합니다. 게시할 때는 기존 이름을 교체하지 않는 SFTP v3 `RENAME`을 사용합니다. 서버가 Unix 권한을 적용하면 새 파일은 소유자 읽기·쓰기(`0600`)로 생성됩니다. 성공하면 원격 목록을 새로고침합니다. 검증 실패, 충돌 또는 중단 시 생성한 임시 파일을 정리하며, 연결이 끊겨 정리를 확인할 수 없으면 해당 경로를 표시합니다. 서버가 게시 응답을 보내기 전에 연결이 끊기면 사용자가 목록을 새로고침해 저장 상태를 확인할 수 있게 안내합니다. [SFTP v3 이름 변경](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5)

원격 목록의 `새 폴더`는 확인 창에 현재 연결과 경로를 표시한 뒤 그 경로 바로 아래에 한 폴더를 만듭니다. 경로 구분자와 상위 경로는 입력할 수 없고, 기존 파일·폴더와 이름이 겹치거나 서버 권한이 부족하면 사유를 표시합니다. 서버가 Unix 권한을 적용하면 소유자만 접근하는 `0700`으로 생성합니다. 생성 후 현재 목록을 새로고침합니다. 생성 응답을 받지 못하면 다시 시도하기 전에 목록을 확인하도록 안내합니다. [SFTP v3 폴더 생성](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.6)

원격 목록에서 일반 파일이나 폴더의 이름을 같은 경로 안에서 변경할 수 있습니다. 서버의 최신 유형과 목록에 표시된 크기·수정 시각을 비교하고 값이 달라지면 다시 선택하도록 안내합니다. 표준 SFTP v3 이름 변경을 사용해 대상 이름이 이미 있으면 변경을 중단합니다. 서버 응답이 끊기면 목록을 새로고침해 결과를 확인할 수 있습니다. SFTP v3 이름 변경에는 원본의 메타데이터를 조건으로 전달할 수 없어 속성 조회와 변경 사이에 발생한 원본 교체는 감지 범위에 들지 않습니다. [SFTP v3 이름 변경](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5)

원격 이동은 같은 SFTP 연결에서 파일이나 폴더를 선택해 다른 원격 폴더로 옮깁니다. 상위·하위 폴더 탐색과 경로 직접 입력을 지원하며, 이동 확인 전에 서버가 해석한 최종 경로를 표시합니다. 이동 직전에 두 폴더의 경로와 원본 속성을 다시 확인합니다. 기존 대상과 이름이 같거나 폴더를 자기 자신이나 하위 폴더로 옮기려 하면 작업을 중단합니다. 파일 시스템이 다르면 서버가 이동을 거부할 수 있습니다. [SFTP v3 이름 변경과 경로 해석](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5)

원격 파일 복사는 같은 SFTP 연결에서 대상 폴더와 복사본 이름을 선택합니다. 원본의 크기·수정 시각을 확인하고 최대 32 KiB씩 읽어 원격 임시 파일에 기록합니다. 원격 임시 파일의 크기와 SHA-256을 읽은 원본과 비교하고 검증이 통과한 뒤 새 이름으로 게시합니다. 진행률과 중단을 지원하며, 중단·충돌·검증 실패 시 원본과 기존 대상을 보존하고 생성한 임시 파일을 정리합니다. Windows 디스크에는 복사 내용을 기록하지 않습니다. Unix 권한을 적용하는 서버에서는 복사본을 `0600`으로 만들며 원본 권한·시각을 복제하지 않습니다.

원격 삭제는 일반 파일 또는 빈 폴더 한 개에 적용됩니다. 확인 창에서 현재 연결과 환경, 정확한 경로와 삭제할 항목 수를 표시합니다. 확인 정보는 해당 연결에서 2분간 유효하며 한 번 사용합니다. `PROD` 연결에서는 삭제할 때마다 `PROD` 입력을 검사하고, 연결 설정이나 원격 항목 속성이 달라지면 삭제를 중단합니다. 폴더는 하위 항목 유무를 조회한 뒤 SFTP 서버에 빈 폴더 삭제를 요청합니다. 숨김 파일을 포함해 하위 항목이 하나라도 있으면 서버에서 거부합니다. SFTP v3에서는 경로를 지정해 삭제하므로 마지막 속성 조회와 삭제 요청 사이에 발생한 원본 교체는 감지 범위에 들지 않습니다. [SFTP v3 파일·폴더 삭제](https://datatracker.ietf.org/doc/html/draft-ietf-secsh-filexfer-02#section-6.5)

원격 편집은 최대 512 KiB의 UTF-8 일반 텍스트를 창에서 엽니다. BOM과 한 종류의 LF 또는 CRLF 줄바꿈을 저장할 때 유지합니다. `Ctrl+S`로 원격 파일을 저장할 수 있습니다. 미저장 변경이 있으면 편집기 또는 앱을 닫을 때 계속 편집, 로컬 초안 저장, 변경 버리기 중에서 선택할 수 있습니다. 로컬 초안은 사용자가 선택한 새 `.txt` 파일에 원본의 BOM과 줄바꿈 형식을 유지해 최대 16 MiB까지 저장합니다. 저장이 진행 중이면 작업이 끝날 때까지 앱을 유지하고, 실패하면 편집 내용은 창에 남습니다. 편집 원문과 초안은 작업 공간 파일이나 작업 기록에 자동으로 기록하지 않습니다.

SFTP와 SQL 편집기에서 스크롤에 맞춰 줄 번호와 현재 줄을 표시합니다. 커서의 줄·열 위치는 편집기 하단에서 확인할 수 있고, 긴 줄은 가로로 스크롤합니다. **찾기** 또는 `Ctrl+F`는 현재 문서의 일반 텍스트를 찾습니다. 대소문자 구분을 선택할 수 있고, `F3`과 `Shift+F3`으로 일치 위치를 오갑니다. **바꾸기** 또는 `Ctrl+H`로 한 건 또는 전체 일치 위치의 내용을 초안에서 바꿉니다. 바꾼 직후 `Ctrl+Z`로 그 작업을 되돌릴 수 있습니다. 바꿀 내용을 비워 두면 일치한 텍스트를 삭제하며, SQL 파일과 SFTP 원격 파일은 각각의 저장 단계에서 기록합니다.

원래 경로에 저장하려면 서버가 OpenSSH의 `posix-rename@openssh.com` 버전 1을 제공하고 일반 Unix 권한과 소유자·그룹을 보존할 수 있어야 합니다. `PROD` 연결은 원래 경로에 저장할 때마다 `PROD` 입력을 확인합니다. 저장 전에 원본 SHA-256·크기·시각·권한을 비교합니다. 수정본을 같은 원격 폴더의 임시 파일에 쓰고 체크섬을 검증한 다음, 원본을 다시 읽어 비교하고 서버의 원자적 파일 교체를 요청합니다. 충돌이 감지되면 편집 내용을 창에 남겨 두며 같은 폴더에서 기존 파일을 보존하는 새 이름 저장을 선택할 수 있습니다. 서버가 파일 교체를 지원하지 않거나 원본 메타데이터를 보존할 수 없는 경우에도 새 이름으로 저장할 수 있습니다. 기존 파일의 ACL·확장 속성·하드 링크 관계는 보존 대상에 포함되지 않습니다. SFTP 교체 요청에 원본 해시 조건을 전달할 수 없으므로 마지막 확인과 교체 사이에 이어진 동시 쓰기는 검출 범위 밖입니다. [OpenSSH SFTP 확장 명세](https://github.com/openssh/openssh-portable/blob/master/PROTOCOL)

SFTP 전송·복사·편집, 원격 폴더 생성, 이름 변경, 이동·삭제, 권한·소유자 변경과 동기화의 시작과 결과는 동일한 작업 ID로 연결합니다. 작업 기록에는 실행 시각, 로컬 실행자, 프로젝트·연결 ID, 환경, 결과와 적용 정책을 저장합니다. 파일 경로·이름·내용과 체크섬, 인증 정보는 제외합니다. 시작 기록을 쓸 수 없으면 작업을 시작하지 않습니다. 원격 작업 또는 로컬 파일 게시 이후 결과 기록을 저장할 수 없으면 작업 완료와 기록 실패를 함께 표시합니다. 앱이 강제 종료되면 시작 기록만 남을 수 있습니다.

서버 대화형 인증 또는 암호를 선택하면 해당 방식으로만 접속합니다. 대화형 인증은 서버 안내와 여러 단계의 질문을 터미널에 전달하며, 각 답변의 표시 여부는 서버가 지정합니다. 질문이 여러 개여도 한 번의 인증 시도에 해당합니다. 입력 응답은 저장하지 않고 실패 후 다른 방식으로 전환하지 않습니다. 자동 모드에서는 OpenSSH가 기본 키·에이전트, 대화형 인증, 암호 순서로 시도합니다. 키와 대화형 인증을 함께 요구하는 실제 서버 구성은 별도 검증이 필요합니다.

SSH 연결 화면과 네트워크 도구의 DNS·TCP 진단은 DNS 결과와 TCP 연결 성공·거부·시간 초과를 구분하고 시도한 주소별 결과를 표시합니다. 최대 8개 주소를 대상으로 DNS 4초, TCP 전체 4초와 주소별 1초를 적용합니다. 연결은 즉시 닫고 애플리케이션 데이터를 전송하지 않으며 호스트 키·SSH 핸드셰이크·인증·서버 권한을 검사하지 않습니다. 서버에 접속 시도 기록이 남을 수 있습니다. OS의 DNS 조회는 중단할 수 없으므로 시간 초과 뒤에도 최대 4개의 조회 스레드가 남을 수 있습니다. 이 한도에 도달하면 추가 조회를 시작하지 않고 이전 조회가 진행 중이라고 표시합니다. 진단 요청은 동시에 최대 4개로 제한합니다.

네트워크 도구는 사용자가 지정한 단일 대상에 Windows [Ping](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/ping)과 [tracert](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/tracert)를 실행합니다. 자동·IPv4·IPv6를 선택할 수 있습니다. Ping은 요청 4회와 전체 12초, 경로 추적은 역방향 조회를 끄고 최대 12홉과 전체 24초를 적용합니다. 종료 코드·경과 시간과 운영체제 출력을 표시하며 각 출력 스트림의 처음 16 KiB만 보관합니다. ICMP 결과는 서비스 인증이나 애플리케이션의 가용성을 검증하지 않습니다.

웹 상태 확인은 입력한 HTTP/HTTPS URL에 WinHTTP로 HEAD 또는 GET 요청을 보냅니다. 같은 URL을 1~5회 순차 측정하며, 다음 요청은 이전 요청이 끝난 뒤 1초 후에 시작합니다. 매번 새 세션으로 시작하고 응답 수, 2xx 수, 헤더까지 걸린 시간, HTTP 상태 코드와 헤더를 표시합니다. 연결 단계별 시간 제한과 응답 헤더 16 KiB 한도를 적용합니다. 프록시 자동 검색, 리디렉션, 쿠키 처리와 자동 인증을 끕니다. GET 요청도 본문은 읽지 않으며 쿠키와 인증 관련 응답 헤더 값은 화면에서 가립니다. URL에 사용자 정보나 `#` 조각이 있으면 요청을 거부합니다. [WinHTTP 옵션](https://learn.microsoft.com/en-us/windows/win32/winhttp/option-flags)

HTTPS는 Schannel로 서버 인증서를 검증하고 TLS 1.2 이상을 사용합니다. 검증 실패는 요청 결과에 표시합니다. Windows가 연결 세부 정보를 제공하면 협상한 TLS 버전, 암호 모음과 키 강도를 표시합니다. 이전 Windows에서는 키 강도만 표시될 수 있습니다. 결과는 현재 진단 화면에만 유지합니다. [WinHTTP TLS 연결 정보](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/ns-winhttp-winhttp_security_info)

네트워크 화면의 로컬 포트 목록은 [Windows IP Helper TCP](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)와 [UDP](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedudptable) 테이블을 읽습니다. IPv4·IPv6의 로컬 주소·포트·PID, TCP 원격 주소와 연결 상태, UDP 바인딩을 표시합니다. 프로세스 조회 권한이 있으면 실행 파일 이름을 표시하고 파일 경로는 반환하지 않습니다. 소켓과 프로세스는 조회 사이에 바뀔 수 있습니다. 일부 테이블이 실패하면 읽은 목록과 원인을 함께 표시합니다. 조회는 수동 새로고침을 지원하며 연결 시도나 트래픽 전송을 수행하지 않습니다.

원격 화면의 RDP는 Windows 시스템 디렉터리의 `mstsc.exe`로 연결을 엽니다. 호스트 또는 IP와 포트, 사용자 이름·도메인, 창·전체 화면·다중 모니터, 창 해상도와 색 깊이를 지정합니다. 인증은 Windows 창에서 처리하며 연결 설정은 서버 인증 실패 시 연결 거부, CredSSP 활성화, 자격 증명 프롬프트를 요청합니다. 관리 콘솔은 선택 시 `/admin`을 전달합니다. 클립보드·프린터·스마트카드·드라이브 공유는 기본으로 끄고, 필요한 리소스와 드라이브 문자만 선택합니다. 창 크기 변경, 자동 재연결, Windows 단축키 전달은 Windows 클라이언트 및 서버 정책 범위에서 동작합니다. [Windows 원격 데스크톱 명령](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/mstsc) · [RDP 연결 속성](https://learn.microsoft.com/en-us/azure/virtual-desktop/rdp-properties)

RDP 연결 화면에서 화면과 리디렉션 옵션을 펼쳐 조정할 수 있습니다. 열린 클라이언트 목록은 연결 설정 옆에 표시하고, 좁은 창에서는 설정 아래에 배치합니다. StackPort는 실행한 Windows RDP 클라이언트와 각 클라이언트의 임시 연결 설정을 추적합니다. 프로세스 목록은 Windows 창의 실행 상태를 표시합니다. 연결 끊기와 정상 앱 종료는 실행한 클라이언트만 정리하며, 원격 세션의 로그아웃은 Windows 서버에서 처리합니다. 작업 공간의 임시 `.rdp` 파일에는 연결 대상·사용자 이름·도메인·설정이 들어가며, 앱이 강제 종료되면 남을 수 있습니다. Windows와 서버가 자체 인증 정책과 원격 화면을 관리합니다.

네트워크 도구는 로컬 포트와 연결 진단을 전환하는 동안 각각의 필터와 결과를 유지합니다. 다른 도구를 열거나 프로젝트를 바꿔도 현재 앱 실행 중에는 같은 네트워크 화면으로 돌아올 수 있습니다.

선택한 SSH 연결은 자격 증명과 호스트 키 신뢰 기록 없이 JSON 파일로 교환할 수 있습니다. 내보내기는 선택 시점 이후 정의가 변경되면 중단하며 기존 파일을 덮어쓰지 않습니다. 가져오기는 파일을 검증하고 선택한 항목만 새 ID로 원자적으로 추가합니다. 미리보기 이후 파일이 변경되면 재확인이 필요하고 같은 이름의 기존 연결은 수정하지 않습니다. 가져오기와 내보내기는 작업 기록에 남기되 파일 경로와 연결 값은 기록하지 않습니다.

로컬 메타데이터는 SQLite 트랜잭션, 외래 키, 스키마 버전을 사용합니다. 버전 1~20에서 21로 이관하기 전 원본과 같은 폴더에 SQLite 스냅샷을 생성하고 무결성과 버전을 검사합니다. 이관 실패 시 원본 트랜잭션을 롤백하고 백업을 보존합니다. 지원하지 않는 버전이나 비어 있지 않은 미버전 파일은 변경하지 않고 거절합니다. 전체 메타데이터 DB의 자동 복구는 아직 구현하지 않았습니다. SSH와 PostgreSQL 연결 정의의 동시 수정은 감지하여 거절하며 자동 병합하지 않습니다. 프로젝트를 복제할 때 PostgreSQL 연결 정의도 복사합니다. 프로젝트 삭제는 연결 정의와 저장된 SSH 터널 설정을 삭제합니다. 현재 실행 중인 터널은 네트워크 화면에서 중단할 수 있습니다. 자격 증명 모델과 보안 저장소는 아직 없습니다.

앱을 다시 열면 선택한 프로젝트·SQLite 연결, 작업 도구 배치와 분할 비율, 탐색기 열림 상태를 복원합니다. 프로젝트가 보관되거나 삭제됐으면 활성 프로젝트 목록에서 기본값을 선택하고, 삭제된 연결은 다시 선택하지 않습니다. 저장하는 데이터는 프로젝트·프로필 ID, 열림 여부와 도구 배치입니다. SQL 초안, 터미널 출력, 자격 증명과 활성 연결은 저장하지 않습니다. SSH·SFTP·RDP 재연결과 로컬 셸 실행은 사용자가 시작합니다.

배치 저장은 작업 공간의 현재·이전 스냅샷과 버전을 한 SQLite 트랜잭션으로 갱신합니다. 현재 배치의 형식이 손상되면 이전에 검증된 배치를 읽습니다. 다른 창이 먼저 저장한 변경은 보존하고, 사용자가 **이 창의 배치 저장**을 선택하면 다시 시도합니다. 일반 변경은 짧은 지연 후 저장하고, 정상 종료 시 대기 중인 저장을 마친 다음 창을 닫습니다.

프로젝트 복제는 SQLite·SSH 연결 정의의 이름·대상·환경을 새 프로젝트와 새 연결 ID로 복사합니다. 두 프로젝트는 같은 SQLite 파일과 SSH 서버를 참조합니다. 원본 파일과 활성 세션, SQL 초안, 작업 기록은 복사하지 않습니다. 복제와 작업 기록을 같은 트랜잭션에 저장하며 실패 시 새 프로젝트나 일부 연결이 남지 않습니다.

프로젝트 보관은 보관한 시각을 기록하고 프로젝트를 활성 선택 목록에서 숨깁니다. 보관된 프로젝트 목록에서 다시 활성화하면 같은 프로젝트와 연결 ID로 작업을 계속할 수 있습니다. 보관과 재활성화는 각각 작업 기록과 함께 한 트랜잭션으로 저장합니다. 보관은 탐색기에서 프로젝트를 정리하는 기능이며 기존 연결 정의와 파일, 열린 SSH 세션을 보존합니다.

Windows에서 EXE 인자 `--portable` 또는 EXE 옆 파일 `StackPort.portable`을 사용하면 메타데이터 및 SSH 호스트 키 저장소를 인접한 `StackPort-data`에 두고, 앱이 요청하는 WebView2 프로필도 그 안에 둡니다. 디렉터리 쓰기 권한과 WebView2 Runtime이 필요합니다. `STACKPORT_DATA_DIR`을 설정하면 표시 파일보다 우선하며, 명시적 인자와 동시에 제공하면 시작 오류를 표시합니다. 지정 경로와 표준 모드에서는 WebView2의 기본 동작을 유지합니다. OS·관리자 WebView 정책이 적용될 수 있습니다. 앱 상단에 Rust 빌드에 포함된 버전과 선택한 데이터 모드를 표시합니다. 기존 사용자 파일의 자동 이동, 서명 검증 업데이트, 플러그인 또는 자격 증명 저장은 제공하지 않습니다.

**데이터 복사**는 원본 경로, 새 폴더와 대상 파일을 미리 보여줍니다. `workspace.sqlite`와 선택한 `ssh-trust.sqlite`를 SQLite 온라인 백업으로 각각 복사하고 무결성과 SHA-256을 확인합니다. 대상과 같은 부모 아래에 임시 폴더를 만든 뒤 [Windows MoveFileW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefilew)로 새 폴더에 게시합니다. 기존 폴더는 덮어쓰지 않습니다. DB 두 개의 스냅샷 시점은 다를 수 있으므로, 다른 앱에서 동시에 변경하지 않는 동안 복사하면 일관된 구성을 얻을 수 있습니다. 연결이 참조하는 원본 파일, WebView 데이터, 외부 자격 증명 및 메모리 초안은 복사 대상에서 제외합니다. 현재 실행은 원본 작업 공간을 계속 사용하며 다음 실행에서 경로를 선택할 수 있습니다. 원본 작업 기록에는 복사 결과와 파일 수만 남기며 경로·체크섬은 기록하지 않습니다.

프로젝트·연결 정의 변경은 메타데이터와 감사 이벤트를 같은 트랜잭션에 저장합니다. SQLite 백업·복원·결과 내보내기와 셀 변경은 시작과 완료·실패를 별도 이벤트로 기록합니다. 작업이 성공한 뒤 완료 기록이 실패하면 작업 성공과 기록 실패를 함께 표시합니다. 이벤트에는 ID, UTC 시각, 로컬 사용자 표시, 작업 종류, 대상 ID, 환경, 결과, 정책과 영향 개수를 저장하며 SQL, 행 값, 파일 경로와 자격 증명은 저장하지 않습니다. 개별 OS 사용자 식별, 변조 방지와 보존 기간 설정은 아직 없습니다. 앱이 작업 완료와 기록 저장 사이에 비정상 종료되면 시작 이벤트만 남을 수 있습니다.

SQLite SQL 조회는 기존 파일을 읽기 전용으로 열고 `query_only`와 SQLite authorizer를 함께 사용합니다. 임의 SQL의 첨부·PRAGMA·쓰기와 확장 로딩은 거부합니다. 요청별 연결은 작업 종료 시 닫힙니다. 중단 요청은 해당 SQLite 연결에 인터럽트를 보내며 실행 결과로 중단·시간 초과·완료를 구분합니다. 10초 제한은 SQLite 진행 콜백에서 확인하므로 긴 단일 연산·파일 I/O·잠금 대기 중에는 실제 중단이 지연될 수 있습니다. SQL과 원본 행은 로그에 기록하지 않으며 초안은 현재 프로세스의 메모리에만 둡니다. 결과는 한 번에 최대 100행을 반환하고 추가 행 존재 여부를 별도로 표시합니다. OFFSET 페이지는 조회 중 원본이 바뀌거나 순서가 불안정하면 중복·누락될 수 있습니다.

탐색기에서 테이블이나 뷰를 열면 SQL 편집기를 접고 해당 객체의 데이터와 구조를 표시합니다. 객체나 연결을 오가는 동안 SQL 탭과 연결마다 선택한 탭이 유지됩니다. 탭에 초점을 두고 좌우 방향키로 전환하고 `Delete`로 닫을 수 있습니다. 편집기를 접어도 실행 중인 쿼리는 같은 위치에서 중단할 수 있습니다.

SQL 편집기에서 최대 1 MiB의 `.sql` 파일을 새 탭에 열 수 있습니다. **자동**은 BOM으로 UTF-8 또는 UTF-16 LE·BE를 확인하고, BOM이 없으면 UTF-8을 사용합니다. BOM 없는 UTF-16, Windows-949(EUC-KR), Windows-1252 파일은 인코딩을 직접 선택합니다. 파일 인코딩은 편집기로 읽거나 디스크에 쓸 때 사용하며, SQL 실행에는 각 연결의 기존 문자 전송 방식을 사용합니다. [WHATWG 인코딩 표준](https://encoding.spec.whatwg.org/)

`Ctrl+S`는 현재 탭의 새 파일 저장 창을 엽니다. 기본값은 원본 인코딩과 BOM이며, 다른 인코딩을 선택해 변환할 수 있습니다. 줄바꿈은 원본의 LF 또는 CRLF를 유지합니다. 저장 형식으로 표현할 수 없는 문자가 있으면 경고하고 입력한 내용을 열린 탭에 유지합니다. UTF-8이나 UTF-16으로 바꿔 다시 저장할 수 있습니다. 1 MiB 한도는 디스크에 쓰는 바이트 수로 확인합니다. 탭을 닫기 전에 변경 내용을 파일로 저장하거나 버릴 수 있습니다.

MySQL·MariaDB, SQL Server, Oracle, Snowflake도 PostgreSQL과 같은 연결별 SQL 문서 탭과 파일 열기·저장을 사용합니다. 파일을 열면 내용과 파일 이름을 표시하고 실행은 별도 버튼이나 단축키로 시작합니다. 한 번의 실행 요청은 MySQL 계열에서 128 KiB, SQL Server·Oracle·Snowflake에서 256 KiB까지 받습니다. 실행 중이거나 매개변수 입력이 열려 있으면 해당 탭에서 작업을 끝낸 뒤 탭을 전환합니다. 같은 연결 세션에서 탭별 결과를 유지하고, 연결을 끊거나 다른 연결을 열어도 초안과 파일 정보는 앱을 닫을 때까지 메모리에 유지합니다.

쓰기 가능한 SQL 편집기는 실행 범위에 포함된 문장과 배치의 위험을 서버 실행 전에 검토합니다. 행을 제한하는 `WHERE`가 없는 `UPDATE`·`DELETE`, `WHERE TRUE`·`WHERE 1=1`, `TRUNCATE`, 객체·권한 변경, `INSERT … SELECT`, `MERGE`, 대량 로드와 `CALL`·`EXECUTE` 같은 호출을 구분합니다. PostgreSQL의 변경 CTE도 검사하며 SQL Server의 `GO` 반복 횟수를 경고에 표시합니다. MySQL 계열의 실행 가능한 주석과 Oracle의 PL/SQL 블록은 내부 영향이 달라질 수 있는 작업으로 표시합니다. [PostgreSQL의 변경 CTE](https://www.postgresql.org/docs/18/queries-with.html) · [SQL Server GO](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/sql-server-utilities-statements-go?view=sql-server-ver17) · [MySQL 실행 주석](https://dev.mysql.com/doc/refman/8.4/en/extensions-to-ansi.html)

검토 창에는 연결 이름·환경·기본 데이터베이스, 실행 범위, 문장 줄 번호와 구문에서 확인한 영향을 표시합니다. 실제 변경 행 수는 서버에서 실행한 뒤 확정됩니다. 운영 PostgreSQL과 MySQL 계열 스크립트는 실행마다 `PROD`를 입력하며, SQL Server·Oracle·Snowflake는 변경 가능성이 식별된 운영 요청에서 네이티브 실행 경로도 `PROD`를 확인합니다.

SQL을 선택하면 실행 버튼이 **선택 영역 실행**으로 바뀝니다. `Ctrl+Enter`와 실행 계획도 선택한 부분을 대상으로 합니다. 선택 영역이 없으면 편집기의 전체 입력을 사용합니다. **현재 문장** 또는 `Ctrl+Shift+Enter`는 커서가 속한 문장을 사용합니다. 따옴표나 주석 안의 세미콜론은 문장 끝으로 보지 않으며, SQLite 트리거 본문은 `END;`까지 같은 문장으로 읽습니다. 한 번에 실행 가능한 범위는 SQLite 읽기 전용 문장 하나입니다. [SQLite 문장 경계](https://www.sqlite.org/c3ref/complete.html) · [SQLite 주석 구문](https://www.sqlite.org/lang_comment.html)

열린 SQL 탭마다 마지막 조회 결과의 현재 페이지와 실행 계획을 메모리에 유지합니다. 다른 탭이나 연결을 거쳐 돌아와도 같은 페이지가 표시됩니다. 실행 후 편집한 SQL은 다음 실행부터 적용되며, 기존 결과의 페이지 이동과 내보내기에는 원래 실행한 입력을 사용합니다. 편집 내용이 바뀌면 이전 실행 계획은 닫힙니다.

관계형 SQL 편집기의 **SQL 템플릿**에서 문서 전체 또는 선택 영역을 프로젝트에 저장합니다. 템플릿은 이름·폴더·방언·즐겨찾기와 함께 로컬 저장소에 기록됩니다. 명령 팔레트에서도 프로젝트의 템플릿을 관리할 수 있습니다. 같은 프로젝트의 SQL 편집기에서 템플릿을 선택하면 이름이 붙은 새 탭으로 가져옵니다. 방언이 다르면 편집기에서 실행하기 전에 구문을 확인할 수 있도록 안내합니다. 작업 공간 스키마 v20은 기존 템플릿의 이름·폴더·본문·즐겨찾기를 보존하며 방언을 `공통 SQL`로 설정합니다.

관계형 SQL 편집기의 **최근 SQL**은 연결별로 실행 범위·시작 시간·소요 시간·결과 상태를 보관합니다. 미리보기 행 수와 드라이버가 알려 준 변경 행 수를 구분해 표시합니다. 현재 문장이나 배치를 실행하면 엔진이 선택한 범위만 원문으로 보관합니다. MySQL 계열에서 선택 범위의 구분 기호가 세미콜론과 다르면 새 탭에서 다시 사용할 수 있도록 `DELIMITER`를 포함합니다. 매개변수로 전달한 값과 서버 오류 상세는 기록에서 제외합니다.

목록과 상세 미리보기는 SQL 값과 식별자를 가립니다. 원문 보관은 연결마다 이번 앱 세션에서 끌 수 있고, 그 시점에 해당 연결에 보관된 원문도 지웁니다. 기록은 연결별 최대 30건, 전체 최대 120건이며 원문 합계는 UTF-16 코드 단위 1,048,576개로 제한합니다. 긴 SQL이나 실행 범위를 확인할 수 없는 요청은 원문 없이 실행 정보를 남깁니다. 보관한 SQL을 새 탭에 열면 일반 편집과 같은 확인 흐름으로 실행할 수 있습니다.

앱을 닫을 때 미저장 SQL이 있으면 탭 제목과 프로젝트·연결 이름을 표시합니다. 필요한 탭을 골라 새 파일로 저장하거나 계속 작업할 수 있습니다. 저장에 실패하면 해당 초안은 목록에 남습니다. 종료 후에는 저장한 파일을 편집기에서 다시 열 수 있습니다.

SQL 편집기의 매개변수는 SQLite가 준비한 문장에서 찾습니다. 같은 이름이 반복되면 값 하나를 공유하며, 위치 매개변수는 슬롯 번호로 표시합니다. 최대 32개 슬롯에 텍스트, 64비트 정수, 유한한 실수, NULL 또는 16진수 BLOB을 바인딩할 수 있습니다. 텍스트는 UTF-8로 16 KiB, BLOB은 8 KiB까지 받습니다. 입력을 숨길 수 있으며, SQL에서 그 값을 반환하면 결과 그리드에 표시됩니다. 실행한 바인딩 값은 해당 조회의 페이지 이동에 필요한 동안 메모리에 유지합니다. 다른 실행에서 일반 값을 재사용하려면 매개변수 세트에 저장합니다.

SQL 편집기의 실행 계획은 실제 페이지 조회와 같은 읽기 전용 문장에 SQLite `EXPLAIN QUERY PLAN`을 적용합니다. 매개변수를 묻고 쿼리 본문은 실행하지 않습니다. 반환된 계획을 트리 순서와 엔진 설명으로 표시하고 스캔·조건 검색·임시 B-Tree 단계를 구분합니다. 최대 200단계를 표시하며 SQLite가 제공하지 않는 비용·실제 행 수·실행 시간은 표시하지 않습니다.

테이블·뷰의 그리드에서는 최대 16개의 비교·포함·범위·NULL 조건을 AND 또는 OR로 결합하고 최대 8개 열에 정렬 방향과 NULL 순서를 지정할 수 있습니다. 날짜 입력은 `YYYY-MM-DD` 텍스트로 비교하며, 시간이 포함된 열에는 저장 형식에 맞는 텍스트나 숫자 조건을 선택해야 합니다. 스키마에서 확인한 객체·열과 고정된 연산자만 SQL에 넣고 값은 개별 매개변수로 전달합니다. 적용된 조건과 순서로 SQLite가 먼저 조회한 뒤 페이지를 나눕니다. 정렬값이 같은 경우 기본 키가 있으면 보조 정렬에 사용합니다. 키가 없거나 NULL 기본 키가 중복된 결과에서는 정렬 동률의 순서가 보장되지 않습니다. 조회 SQL에 값 대신 물음표를 표시하며, 조건을 디스크에 저장하거나 다시 불러오는 기능은 아직 제공하지 않습니다.

결과 내보내기는 그리드에 마지막으로 적용한 테이블 필터·정렬 또는 실행한 SQL·매개변수로 한 번 더 읽기 전용 조회를 실행합니다. 화면 페이지는 무시하며 SQL에 직접 쓴 LIMIT는 적용합니다. 행을 64 KiB 버퍼를 통해 임시 파일에 기록하고 동기화 후 새 경로에 게시합니다. 조회가 다시 실행되므로 원본 DB가 바뀌면 그리드에서 보았던 값과 달라질 수 있습니다. 진행 행 수를 표시하고, 완료 전 중단과 5분 제한을 지원합니다. 긴 SQLite 연산이나 디스크 쓰기 중에는 중단 확인이 지연될 수 있습니다. 취소·오류는 최종 파일을 게시하지 않으며 앱 강제 종료 시 임시 파일이 남을 수 있습니다. CSV와 JSON은 UTF-8 평문 파일입니다.

- CSV에서 열 이름은 선택 사항입니다. 쉼표·빈 문자열·개행을 포함한 텍스트는 인용하고, NULL은 인용하지 않은 `\N`, BLOB은 `X'16진수'` 형태로 기록합니다. 수식처럼 보이는 텍스트 앞에 작은따옴표를 붙이는 옵션이 기본으로 켜져 있으며 해당 텍스트와 열 이름을 바꿉니다.
- JSON은 `format: "stackport.sqlite-results"`, `version: 1`, `columns`와 `rows` 배열을 담습니다. 열 이름은 SQLite가 반환한 이름을 사용하고, 각 행은 열 순서와 일치하는 배열로 저장합니다. 같은 별칭은 SQLite가 `name`, `name:1`처럼 구분할 수 있습니다. 값은 JSON 문자열 또는 `null`, 10진수 문자열을 담은 `{"integer":"9223372036854775807"}`와 `{"real":"1.5"}`, 대문자 16진수 문자열을 담은 `{"blob_hex":"00FF"}`입니다. 실수의 무한대는 `"inf"`와 `"-inf"`로 기록합니다.

SQLite 행 편집은 5분 동안 한 행의 최대 16개 열에 입력한 값을 메모리에 보관합니다. 열을 전환하면서 초안을 편집할 수 있고 변경된 열의 전후 값을 함께 확인합니다. 편집 창이나 앱을 닫을 때 미적용 변경을 버릴지 묻습니다. 미리보기와 적용 시 전체 행의 SHA-256 지문, 구조와 파일 식별을 다시 확인합니다. 적용은 `BEGIN IMMEDIATE`에서 한 `UPDATE OR ABORT`로 실행하고, 승인한 모든 열의 저장 값과 다른 열의 변경 여부를 확인한 뒤 커밋합니다. 제약 위반이나 값 형식 변환이 있으면 전체를 롤백합니다. 커밋 결과가 불명확하면 재시도 전에 재조회를 안내합니다. 지원 범위는 읽을 수 있는 기본 키가 있고 사용자 트리거 및 생성·숨김 열이 없는 일반 테이블입니다. 기본 키·고유 열과 BLOB·긴 값은 조회할 수 있습니다. 운영 환경은 `PROD` 입력을 요구합니다. 감사 기록에는 변경한 행 수를 남기고, 입력한 값은 편집 세션의 메모리에서 관리합니다. [SQLite UPDATE](https://sqlite.org/lang_update.html) [SQLite 충돌 처리](https://sqlite.org/lang_conflict.html)

SQLite의 **선택한 행 편집**은 현재 페이지의 2~100행에서 행당 16개, 전체 256개 셀까지 바꿉니다. 같은 열에 현재 입력값을 채우거나 행별로 다른 값을 지정할 수 있습니다. 창에서 행마다 기본 키와 변경 전후 값을 확인한 뒤 한 번 승인합니다. 변경할 각 행을 다시 검사하고 한 `BEGIN IMMEDIATE` 트랜잭션에서 적용합니다. 다른 연결이 뒤쪽 행을 수정했거나 제약조건이 위반되면 앞서 처리한 행도 롤백합니다. 완료 화면에서 실제 저장 값과 변경 행·셀 수를 확인할 수 있습니다. 현재 값이 큰 범위는 선택한 행 수를 줄여야 합니다. [SQLite 트랜잭션](https://www.sqlite.org/lang_transaction.html)

지원되는 SQLite 테이블의 그리드에서는 기본 키가 있는 일반 테이블을 대상으로 한 행을 추가하거나 삭제할 수 있습니다. 추가 미리보기는 명시적 NULL, 빈 문자열, 숫자와 생략한 열을 구분합니다. 적용 시 SQLite가 생략한 열의 기본값과 자동 기본 키를 계산하고, 그리드에서 저장된 행을 펼쳐 확인할 수 있습니다. 키 충돌은 다른 행을 대체하지 않고 중단합니다. 삭제 미리보기는 기본 키로 현재 행을 다시 읽고 적용 트랜잭션에서 전체 행을 재검증합니다. 삭제 시 연쇄 수정이 가능한 외래 키, 대상 테이블의 트리거와 생성 열은 지원 범위에서 제외합니다. `PROD`는 `PROD` 입력을 요구하고, 감사 기록에는 대상 테이블과 성공 여부·영향 행 수를 남깁니다. [SQLite INSERT](https://sqlite.org/lang_insert.html) [SQLite ROWID와 기본 키](https://sqlite.org/lang_createtable.html#rowid)

**행 붙여넣기**에서 탭으로 구분된 범위를 최대 100행·64열·256 KiB까지 추가할 수 있습니다. 첫 행의 제목이나 입력 순서로 대상 열을 제안합니다. 사용자가 대상 열, 문자열·정수·실수 형식, 빈 셀의 빈 문자열·NULL·DB 기본값을 지정합니다. 큰 정수는 문자열로 전달해 64비트 정수로 검증하며, 따옴표로 묶인 셀 안의 탭과 줄바꿈도 유지합니다. 미리보기에는 매핑한 입력값과 생략한 열을 표시합니다. SQLite는 적용 시 열의 형식에 따라 값을 저장하고 기본값과 자동 키를 계산합니다. 한 트랜잭션에서 새 행을 추가하며 제약조건 위반 시 전체를 롤백합니다. 운영 환경에서는 `PROD` 확인을 요구합니다. [SQLite INSERT](https://sqlite.org/lang_insert.html)

테이블·뷰의 열, 복합 기본 키, 생성 열, 인덱스, 외래 키 및 생성 SQL을 확인할 수 있습니다. 구조 조회는 별도의 읽기 전용 연결에서 허용 목록에 있는 메타데이터 PRAGMA만 실행하며 객체 이름은 바인딩합니다. 일반 SQL 입력에는 이 권한을 부여하지 않습니다. 표시한 구조는 조회 시점의 값입니다.

SQLite 백업은 온라인 백업 API를 사용해 WAL을 포함한 일관된 스냅샷을 대상 폴더의 임시 파일에 만듭니다. 독립 파일로 전환한 뒤 `integrity_check`를 통과하면 동기화하고 기존 파일을 교체하지 않는 방식으로 저장합니다. 실패 시 최종 경로에 불완전한 파일을 게시하지 않습니다. 백업은 암호화되지 않으며 무결성 검사는 사용자가 별도 환경에서 수행하는 복원 테스트와 구분합니다.

Windows의 **백업 → 백업 계획**에서 SQLite 연결별 폴더, 파일 이름 접두어, 보존 기간과 첫 실행 시각을 저장합니다. 실행 간격은 분 단위로 지정합니다. 첫 실행 시각은 장치의 시간대에서 입력해 저장할 때 UTC로 변환합니다. 파일 이름은 접두어, UTC 시작 시각과 고유 ID를 조합합니다. **용량 확인**은 원본 페이지로 추정한 크기와 현재 계정에 허용된 공간을 보여 줍니다. 실행 직전에도 용량을 확인합니다. [Windows 디스크 여유 공간](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getdiskfreespaceexw)

Windows 앱이 켜져 있을 때 계획을 실행합니다. 종료 중 지난 예약이 여러 건이면 재시작 후 한 번 실행하고 다음 주기를 이어 갑니다. **예약 실패 시 자동 재시도**에서 최대 5회, 실패가 끝난 시점부터 1~1,440분 간격을 설정합니다. 기본값은 1분 뒤 한 번입니다. 계획마다 대기 중인 재시도 한 건을 관리합니다. 상태 표시줄에서 예약 결과를 알리고 실행 이력에 재시도 차수를 표시합니다. **예약 중지**는 예정분과 대기 중인 재시도를 취소합니다. **백업 취소**는 실행 중인 앱에서 최종 파일을 저장하기 전까지 예약 또는 수동 백업을 중지합니다. 취소한 실행은 이력에 **취소됨**으로 표시하며 자동 재시도 대상에서 제외합니다. 작업 공간을 다른 위치에서 열면 계획의 저장 폴더와 일정을 다시 검토합니다. 보관된 프로젝트의 계획은 보관 해제 후 다시 실행 대상이 됩니다.

**작업 공간 동시 백업 한도**는 기본 1개이며 최대 4개입니다. 같은 작업 공간을 연 모든 앱은 SQLite·PostgreSQL의 예약과 수동 백업에 이 한도를 적용합니다. 한 연결의 백업은 한 번에 하나씩 실행합니다. 자리가 비면 먼저 예약된 백업부터 시작합니다. 한도를 낮추면 새 실행은 실행 중인 개수가 새 한도보다 적어질 때 시작합니다. 백업을 실행하던 앱이 종료되면 다른 백업은 계속 진행하고, 빈 자리에 기록된 이전 실행은 **완료 확인 필요**로 표시합니다.

**최대 실행 시간**은 백업 시작부터 파일을 최종 저장하기 직전까지 적용합니다. 1~86,400초를 설정할 수 있고 0은 전체 시간 제한을 해제합니다. 기존 계획과 새 계획의 기본값은 SQLite 0초, PostgreSQL 1,800초입니다. 제한을 넘긴 실행은 최종 파일을 게시하기 전에 중단하고 이력에 **시간 초과**, 실행 시간과 적용된 제한을 표시합니다. 시간 초과로 끝난 예약 실행에는 저장된 재시도 정책을 적용합니다. 각 재시도는 시작 시점부터 새 제한 시간을 사용합니다.

SQLite와 PostgreSQL의 **달력 일정**은 분·시·일·월·요일을 지정하는 5필드 cron 식과 IANA 시간대를 사용합니다. **일정 미리보기**에서 다음 실행 시각을 최대 다섯 개까지 확인합니다. 서머타임으로 사라진 시각은 건너뛰고, 두 번 나타난 시각은 첫 번째에 실행합니다. 사용자가 입력한 휴일과 제외 날짜에는 지난 예약 실행과 자동 재시도도 건너뜁니다. 예약을 중지해도 cron 식, 시간대와 제외 날짜는 보존합니다. [cronexpr 예약 문법](https://docs.rs/cronexpr/latest/cronexpr/)

실행 이력에는 예약과 재시도의 **예정 시각**이 표시됩니다. 달력 제외일에 해당하는 예약과 재시도는 **건너뜀**으로 남습니다. 한 제외일에 여러 cron 시각이 있으면 첫 시각을 기준으로 한 번 기록하고, 앱이 닫혀 있는 동안 지난 여러 제외일은 한 줄로 묶습니다. 밀린 반복 또는 달력 예약을 백업 한 번으로 처리하면 나머지 예약도 한 줄로 남습니다. 정기 예약과 대기 재시도는 각각 예정 시각에 처리합니다. 제외일에도 **지금 백업**으로 실행할 수 있습니다.

PostgreSQL 작업 공간의 **백업 계획**은 Windows에 저장한 자격 증명으로 전체 데이터베이스를 `.backup` 파일로 저장합니다. 작업 공간에 열린 PostgreSQL 세션 없이 실행할 수 있습니다. 운영 계획을 저장하거나 즉시 실행하려면 `PROD`를 입력합니다. 계획은 저장할 때 검토한 PostgreSQL 연결 버전에 묶입니다. **용량 확인**에 표시되는 원본 크기는 서버의 디스크 사용량이며 압축된 파일의 실제 크기는 실행 이력에서 확인할 수 있습니다. [PostgreSQL 크기 함수](https://www.postgresql.org/docs/15/functions-admin.html) · [PostgreSQL pg_dump](https://www.postgresql.org/docs/16/app-pgdump.html)

**백업 연결 경로**에서 직접 TLS 연결이나 같은 프로젝트에서 실행 중인 로컬 SSH 터널을 선택합니다. 계획에 터널과 경유 SSH 연결의 버전 및 순서를 저장합니다. 지정한 경로로 터널을 다시 열면 현재 로컬 포트를 사용하고 PostgreSQL 인증서는 원래 호스트 이름으로 검증합니다. 백업을 실행하는 앱 인스턴스에서 해당 터널을 시작해 둡니다. 터널이 중단되거나 경유 순서가 달라지면 해당 실행을 실패로 기록합니다. 터널이나 연결 정의를 편집하면 계획을 다시 검토합니다. [libpq 연결 설정](https://www.postgresql.org/docs/16/libpq-connect.html)

백업 계획은 최근 실행 40건에 파일 크기, 무결성 검사 결과와 보존 만료일을 표시합니다. SQLite는 온라인 스냅샷을 검사하고 PostgreSQL은 `pg_restore`로 아카이브를 읽어 검사합니다. 새 파일을 게시하기 전에 SHA-256과 Windows 파일 ID를 확인합니다. **파일 지문 확인**은 현재 파일을 생성 당시 값과 대조하고 확인 시각을 기록합니다. 작업 공간 v31 이관은 기존 계획과 실행 이력, 파일 지문을 보존합니다. v26까지 자동 재시도를 사용하던 계획에는 기존과 같은 1회·1분 정책을 적용합니다. [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)

**작업 기록 → 백업 실행**에서 작업 공간 전체의 SQLite·PostgreSQL 백업 계획 실행을 최신순으로 확인합니다. 프로젝트, 실행 상태, 예약·수동·재시도로 필터링할 수 있습니다. 첫 페이지는 자동으로 갱신되며 이전 실행은 40건씩 조회합니다. 보관된 프로젝트의 기록에는 보관 상태가 표시됩니다. 활성 프로젝트의 기록에서 **백업 계획 열기**를 선택하면 해당 연결의 현재 계획을 검토하고 **지금 백업**으로 다시 실행할 수 있습니다. PostgreSQL 운영 계획은 `PROD` 확인을 거칩니다.

**계획 검증**은 저장 전 입력에서 예약 시각과 파일 이름·보존·재시도 설정을 검사합니다. 저장 폴더에 쓰는 데 사용한 임시 파일은 정리하며 원본 읽기와 여유 공간 확인 결과를 표시합니다. PostgreSQL은 저장된 Windows 자격 증명과 선택한 직접 TLS 또는 SSH 경유 TLS로 접속한 뒤 `pg_dump`와 `pg_restore` 버전을 확인합니다. 운영 연결에는 `PROD`를 입력합니다. PostgreSQL의 압축 아카이브 크기는 원본과 달라질 수 있어 원본보다 여유 공간이 작으면 확인 필요로 표시합니다. 검증 결과는 현재 입력과 연결 상태를 기준으로 하며 계획 저장과 실제 백업은 각각 실행합니다.

**만료 파일** 목록에서 최근 40건보다 오래된 항목도 **더 보기**로 찾을 수 있습니다. Windows의 **만료 파일 삭제**는 보존 기간이 지난 백업 한 개의 경로·용량·지문을 미리 보여 줍니다. 확인은 5분 동안 한 번만 사용합니다. 삭제할 때 저장된 위치·파일 ID·크기·SHA-256을 다시 확인하고, 쓰기나 이름 변경이 겹치지 않도록 연 파일 핸들로 대상을 영구 삭제합니다. 변경되거나 교체된 파일, 링크, 복사한 작업 공간의 백업은 보존합니다. 삭제 결과와 시각을 실행 이력에 기록합니다. 앱이 파일 작업 도중 종료되면 완료 확인 필요로 표시합니다. 공용 감사 기록에는 백업 경로나 지문을 저장하지 않습니다. [Windows 파일 삭제 핸들](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info) · [Windows 파일 ID](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)

SQLite 복원은 독립된 백업의 경로·크기·SHA-256·사용자 버전·객체 수·일반 테이블의 전체 행 수를 미리 보여줍니다. 허용된 대상은 다른 보조 파일이 없는 새 절대 경로입니다. 확인은 5분 동안 유효하며 한 번만 사용할 수 있습니다. 확인 후 백업을 임시 파일로 옮겨 담고 새 연결에서 무결성과 테이블별 행 수를 검사합니다. 백업과 같은 SHA-256을 확인한 뒤 기존 파일을 덮어쓰지 않는 방식으로 게시합니다. 입력 및 대상 위치에 저널·WAL 보조 파일이 존재하면 진행하지 않습니다. 가상 테이블과 그 내부 테이블은 일반 테이블 행 수에서 제외합니다. 파일은 암호화되지 않으며 앱을 강제 종료하면 복원 중인 임시 파일이 남을 수 있습니다. 작업 기록에는 경로·체크섬·행 데이터를 저장하지 않습니다. 복원은 프로필 등록이나 워크스페이스 메타데이터 교체를 수행하지 않습니다.

## 현재 증거

- `crates/stackport-core/tests/workspace.rs`: 실제 임시 SQLite 파일을 사용해 프로젝트 지속성·삭제, 객체 조회, 페이지 경계, 쓰기·첨부 거부, 유효하지 않은 파일, 새 스키마 버전 보존 및 큰 텍스트 표시를 검사합니다.
- `crates/stackport-core/tests/backup.rs`: WAL 스냅샷을 독립 DB로 열어 데이터와 인덱스를 검사하고, 덮어쓰기 및 실패 시 부분 파일 생성을 방지하는지 검사합니다.
- `crates/stackport-core/src/backup_schedule.rs`의 테스트는 지난 예약의 합산 처리, 작업 공간별 잠금, 비정상 종료 이력, 복사한 계획의 재검토 및 예약 중지를 확인합니다.
- `tests/sqlite-backup-plan-smoke.cjs`는 Windows 앱에서 용량 확인, 수동 백업, 앱 재시작 뒤 지난 예약과 복원, 실패 알림 및 1분 뒤 재시도를 확인합니다. 생성된 파일의 SHA-256을 독립 계산하고, 미리보기 뒤 변경된 파일은 보존하고 검토한 만료 파일만 삭제되는지도 확인합니다. 같은 격리 작업 공간으로 두 번 시작합니다. 먼저 `STACKPORT_BACKUP_TEST_PHASE=prepare`로 실행하고 `schedule.json`의 `due` 시각이 지난 뒤 앱을 다시 열어 `STACKPORT_BACKUP_TEST_PHASE=resume`으로 실행합니다.
- `STACKPORT_BACKUP_TEST_PHASE=cancel`은 예약된 SQLite 스냅샷을 진행 중에 취소하고 임시 파일 정리, 취소 알림과 다음 실행 시각을 확인합니다. `STACKPORT_POSTGRES_TUNNEL_PLAN_ONLY=1`은 터널에서 응답을 대기 중인 `pg_dump`를 백업 계획에서 취소하고 이전 아카이브가 보존되는지 확인합니다.
- `STACKPORT_BACKUP_TEST_PHASE=timeout`은 SQLite 예약의 시간 초과 이력, 임시 파일 정리와 재시도 예약을 확인합니다. PostgreSQL 터널 테스트는 연결 확인과 `pg_dump` 대기 중 저장된 시간 제한을 별도로 확인합니다.
- `STACKPORT_BACKUP_TEST_PHASE=concurrency`와 `STACKPORT_TEST_APP_EXE`로 같은 작업 공간을 연 Windows 앱 두 개의 동시 실행 한도와 중복 실행 차단을 확인합니다. 이어 앱 한 개에서 예약 두 건을 함께 실행하고 세 번째가 대기한 뒤 시작하는지 확인합니다.
- `STACKPORT_BACKUP_TEST_PHASE=skip`은 실제 달력 제외일을 만나 건너뛴 예약의 이력·알림과 다음 예정 시각을 확인합니다. 같은 날 수동 백업을 실행해 파일 무결성을 확인합니다.
- `STACKPORT_BACKUP_TEST_PHASE=history`는 Windows에서 두 프로젝트의 백업 이력을 조회하고 페이지와 필터를 바꾸며 실패 기록에서 저장된 계획을 다시 실행합니다. `STACKPORT_POSTGRES_HISTORY_ONLY=1`은 PostgreSQL 운영 계획의 `PROD` 확인과 재실행을 검증합니다.
- `STACKPORT_BACKUP_TEST_PHASE=validate`는 SQLite 초안의 잘못된 저장 폴더와 cron을 찾아내고 정상 입력 검증 뒤 임시 파일이 정리되는지 확인합니다. PostgreSQL 기록 및 SSH 경유 백업 테스트에서 운영 확인, TLS 경로와 백업 도구 검증을 확인합니다.
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
- `crates/stackport-core/tests/table_query.rs`: 실제 SQLite 파일에서 바인딩 값, 스키마 확인, NULL과 다중 열 정렬, 날짜 범위, 페이지 이동을 검사합니다.
- `crates/stackport-core/tests/result_export.rs`에서 여러 페이지 분량의 결과, 필터·정렬·매개변수 보존, CSV 인코딩과 JSON 타입 보존, 취소·오류 시 정리와 감사 기록의 값 제외를 검사합니다.
- `crates/stackport-core/tests/ports.rs`, `crates/stackport-core/tests/network.rs`, `tests/ports-smoke.cjs`: Windows에서 직접 연 루프백 소켓으로 포트 주소·상태·PID·프로세스, 필터·새로고침, DNS·TCP, Ping과 경로 추적을 검사합니다.
- `crates/stackport-core/tests/web_check.rs`, `tests/ports-smoke.cjs`에서 HTTP 헤더와 상태 코드, 반복 간격, IPv6, 리디렉션과 쿠키 차단을 검사합니다. 임시 자체 서명 인증서와 키 파일을 `STACKPORT_TEST_TLS_CERT`, `STACKPORT_TEST_TLS_KEY`로 지정하면 인증서 거부를 추가로 검사합니다. 신뢰된 HTTPS URL을 `STACKPORT_TEST_HTTPS_URL`로 지정하면 실서버의 TLS 버전과 암호 모음도 검사합니다.
- `crates/stackport-core/src/rdp.rs` 단위 테스트와 `tests/rdp-smoke.cjs`에서 연결 파일의 유효성, Windows `mstsc.exe` 실행, 독립 클라이언트 두 개, 개별 연결 끊기와 앱 종료 시 정리를 검사합니다. RDP 서버의 실제 로그인·화면 렌더링과 주변 장치 전달은 Windows 원격 호스트로 별도 검증해야 합니다.
- `crates/stackport-core/src/sftp.rs` 단위 테스트와 `tests/sftp-smoke.cjs`에서 로컬·원격 탐색, `PROD`와 정의 버전 확인, 암호·암호화 키 인증, 폴더 이동·권한·숨김 파일 표시, 호스트 키 변경 시 사용자 인증 차단을 검사합니다.
- `crates/stackport-core/src/sftp/download.rs` 단위 테스트와 `tests/sftp-smoke.cjs`에서 SFTP 다운로드의 바이트·체크섬·빈 파일, 전송 전과 전송 중 충돌, 중단과 원격 변경 시 임시 파일 정리를 검사합니다.
- `tests/sftp-smoke.cjs`에서 SFTP 업로드의 실제 바이트와 SHA-256, 빈 파일, 업로드 후 목록 갱신, 충돌·중단·해시 불일치의 임시 파일 정리와 상위 경로 입력 차단을 검사합니다.
- `tests/sftp-smoke.cjs`는 경유 서버 두 곳을 거치는 SFTP와 SSH 터미널을 검사합니다. 각 지문 승인 전 인증 차단, 운영 경유지 확인, TCP·인증·PTY 요청 거부, 터미널 입출력·크기 변경·종료 코드·다시 열기, 닫기 후 연결 해제를 확인합니다. `STACKPORT_SFTP_ROUTE_ONLY=1`로 경유 흐름을 따로 실행할 수 있습니다.
- `STACKPORT_SFTP_LINK_ONLY=1`은 Windows 앱에서 SSH 암호·암호화 개인 키로 파일 탐색을 함께 여는 흐름을 검사합니다. SFTP 승인보다 먼저 도착한 SSH 흐름 제어 메시지, SFTP 거부와 승인 후 채널 종료, 같은 연결의 재시도, 원격 파일 편집과 재조회, 독립 연결로 돌아갔을 때 폴더 복원을 확인합니다.
- `crates/stackport-core/tests/ssh_tunnel.rs`와 `tests/ssh-tunnel-smoke.cjs`는 터널 정의의 저장·복제·이관, 로컬 포트 충돌, SOCKS5의 도메인·IPv4·IPv6 CONNECT와 거부 응답, 원격 수신·미등록 채널 차단·포트 해제, 바이너리 전달과 카운터를 검사합니다.
- `crates/stackport-core/src/sftp/preview.rs` 단위 테스트와 `tests/sftp-smoke.cjs`에서 로컬 UTF-8과 키보드 조작, 원격 HTML의 원문 표시, 정적 PNG, HEX 표시 범위, 빈 파일과 읽기 중 변경을 검사합니다.
- `crates/stackport-core/src/sftp/audit.rs` 단위 테스트는 시작 기록과 결과 기록 실패를 검사합니다. `tests/sftp-smoke.cjs`에서 전송 시작과 완료·실패·중단의 작업 ID 연결, 민감 정보 제외와 작업 기록 화면을 확인합니다.
- `tests/sftp-smoke.cjs`에서 원격 폴더 생성·열기, 권한·자동 목록 갱신, 경로 입력 차단, 기존 항목과 동시 생성 충돌 처리, 권한 거부 및 폴더 생성 작업 기록을 확인합니다.
- `tests/sftp-smoke.cjs`에서 원격 파일과 하위 파일이 있는 폴더의 이름 변경, 이름 충돌 시 원본 보존, 권한 거부, 목록 조회 이후 속성 변경 감지와 작업 기록을 확인합니다.
- `tests/sftp-smoke.cjs`에서 원격 경로 직접 입력과 상·하위 탐색, 서버가 해석한 대상 경로 표시, 폴더 경로 변경·이름 충돌·하위 폴더로 이동 차단, 파일과 폴더의 실제 이동 및 작업 기록을 확인합니다.
- `tests/sftp-smoke.cjs`에서 같은 폴더와 다른 폴더로 복사, 실제 원격 바이트·SHA-256·권한, 빈 파일, 기존 파일·게시 중 충돌, 원본 변경, 체크섬 불일치, 중단과 작업 기록을 확인합니다.
- `tests/sftp-smoke.cjs`에서 원격 파일·빈 폴더 삭제, `PROD` 확인, 확인 재사용 차단, 연결 설정·원본 속성 변경과 권한 거부, 하위 항목 및 요청 중 생성된 숨김 파일 보존, 작업 기록을 확인합니다.
- `tests/sftp-smoke.cjs`에서 원격 편집 후 재조회, BOM·CRLF·소유자·권한 보존, 저장 전·임시 파일 게시 전의 동일 크기 내용 변경 감지, 편집 내용 유지, 새 이름 저장과 작업 기록을 확인합니다. 격리된 `STACKPORT_TEST_WINDOW_PID`가 주어지면 저장 중 그리고 미저장 초안이 있을 때 앱 종료 동작도 검사합니다.
- `tests/portable-smoke.cjs`: 새 폴더에 복사한 Windows EXE에서 지정 모드, 버전 표시, 데이터 파일과 휴대형 WebView2 프로필 위치를 확인합니다.
- `crates/stackport-core/tests/workspace_copy.rs`: Windows에서 WAL이 있는 작업 공간의 복사, 선택한 신뢰 저장소, 체크섬, 기존 대상 거절 및 실패 시 대상 폴더 부재를 확인합니다.
- `crates/stackport-core/tests/query_parameters.rs`: SQLite 슬롯 감지, 정밀한 값 바인딩, 실제 쿼리를 실행하지 않는 인덱스·정렬 계획, 쓰기 차단을 검사합니다.
- `crates/stackport-core/tests/restore.rs`: 백업 복원 후 객체·행 수·체크섬 검증, 미리보기 이후 백업 변경, 기존 대상·저널 충돌과 작업 기록의 민감 정보 제외를 검사합니다.
- `tests/desktop-smoke.cjs`: 독립된 테스트 앱과 실제 SQLite 파일에서 그리드 필터·정렬·페이지 이동, 조회 중단·재조회, 단일·다중 행의 셀 편집 미리보기와 적용, 뒤쪽 행의 동시 수정에 따른 일괄 롤백, 행 추가·삭제, 운영 환경 확인, 별도 파일 복원 후 원본 보존·재조회 및 작업 기록을 검사합니다.
- `tests/structured-preview.test.mjs`, `crates/stackport-core/tests/edit.rs`, `tests/desktop-smoke.cjs`: 탭 구분 입력의 따옴표·빈 셀·범위를 확인하고, SQLite의 제목 매핑, 큰 정수 보존과 중복 오류 시 전체 붙여넣기 롤백을 검사합니다.
- `tests/appearance-smoke.cjs`: 격리된 Windows 앱에서 테마와 창 모양 전환, SQLite 목록 밀도 및 집중 모드, 분할 위치·탐색기 상태·SQL 초안·터미널 세션 유지, 재시작 후 설정 복원을 검사합니다. 첫 프로세스에서 `STACKPORT_THEME_PHASE=write`로 실행하고, 같은 WebView2 프로필을 사용해 앱을 다시 띄운 뒤 `STACKPORT_THEME_PHASE=read`로 실행합니다.
- `tests/desktop-smoke.cjs`와 `tests/terminal-smoke.cjs`에서 도구의 키보드 전환, 다른 도구에서 탐색기 접기·펼치기와 SQLite 객체 열기, 전환 뒤 열린 터미널 유지 및 개수 표시를 확인합니다.
- `crates/stackport-core/tests/workspace_resume.rs` 및 `tests/workspace-resume-smoke.cjs`에서 배치 저장 충돌, 손상 시 이전 설정 복원, 보관된 프로젝트 제외, 새 Windows 프로세스에서 프로젝트·프로필·4분할 복원과 수동 연결 정책을 검사합니다. Windows 테스트는 `STACKPORT_RESUME_PHASE=write`로 먼저 실행한 뒤, 같은 `STACKPORT_DATA_DIR`과 새 WebView2 프로필로 앱을 시작해 `STACKPORT_RESUME_PHASE=read`로 실행합니다. 쓰기 단계는 격리된 앱의 `STACKPORT_TEST_WINDOW_PID`가 필요합니다.
- `tests/terminal-smoke.cjs`: 격리된 Windows 앱에서 PowerShell·CMD와 한글 입력·24비트 색상 출력, 탭별 스크롤백 검색, 비활성 탭의 새 출력 표시와 확인, 탭 전환·키보드 이동, 여러 줄 붙여넣기 거부와 창 종료 확인을 검사합니다. 실제 IME 조합 입력과 스크린 리더 사용성은 별도 검증이 필요합니다.
- `crates/stackport-core/tests/terminal_output.rs`와 `tests/terminal-smoke.cjs`에서 터미널 TXT/ANSI 내보내기의 UTF-8, 화면 줄바꿈 복원, 한글·색상·스크롤백, 탭 범위, 파일 크기 제한과 기존 파일 보존을 검사합니다.
- `tests/ssh-smoke.cjs`: 루프백 SSH 서버에서 DNS·TCP 진단, 지문 대조, 암호 로그인, 대화형 인증의 서버 안내·다중 프롬프트·표시 정책, 인증 실패 제한, 키 변경 차단과 교체, 운영 연결 확인 및 신뢰 기록을 검사합니다.
- `tests/ssh-key-smoke.cjs`: 합성 RSA 키와 루프백 SSH 서버에서 다중 키, 중복 경로 차단, 암호화 키의 암호 입력, 지정 키 실패 시 암호 인증 차단, 저장된 운영 연결 및 자격 증명 비저장을 검사합니다.
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

## 연결 복제

탐색기에서 데이터베이스·SSH 연결의 복제 버튼을 누르면 새 이름과 원본 설정이 채워집니다. 이름, 환경과 엔진별 설정을 확인한 뒤 같은 프로젝트에 새 연결로 저장합니다. SQLite는 선택한 파일 경로를 연결 정의에 저장합니다. 암호와 토큰은 새 연결을 열 때 입력합니다. 복제를 저장하면 현재 작업 화면과 세션으로 돌아갑니다.

## 데이터베이스 연결 교환 형식

탐색기의 데이터베이스 그룹에서 여러 엔진의 연결을 골라 JSON으로 내보낼 수 있습니다. 가져오기에서 파일을 미리 확인하고 필요한 연결만 선택합니다. 가져올 이름을 바꿀 수 있으며, 중복 이름으로 인해 하나라도 저장에 실패하면 선택한 연결을 모두 되돌립니다. 저장을 마치면 현재 프로젝트의 연결 목록을 새로 읽습니다.

UTF-8 JSON 형식 이름은 `stackport.database-profiles`이며 `version`은 숫자 `1`입니다. 파일 하나에 연결을 1~200개, 최대 1 MiB까지 담습니다. `connection.engine`의 값은 `sqlite`, `postgres`, `mysql`, `redis`, `mongodb`, `sql_server`, `oracle`, `snowflake`입니다. `mysql`은 MySQL과 MariaDB에 공통으로 쓰입니다. `connection.settings`에는 엔진별 이름, 환경과 접속 설정을 넣습니다. 다음 예시는 사용자 지정 CA를 쓰는 PostgreSQL 연결과 SQLite 정의를 함께 내보낸 파일입니다.

~~~json
{
  "format": "stackport.database-profiles",
  "version": 1,
  "profiles": [
    {
      "connection": {
        "engine": "postgres",
        "settings": {
          "name": "보고서",
          "host": "db.example.com",
          "port": 5432,
          "database": "reports",
          "username": "reader",
          "environment": "STAGING"
        }
      },
      "local_requirements": { "ca_certificate": true, "client_identity": false }
    },
    {
      "connection": {
        "engine": "sqlite",
        "settings": { "name": "분석 자료", "file_name": "reports.sqlite", "environment": "DEV" }
      },
      "local_requirements": { "ca_certificate": false, "client_identity": false }
    }
  ]
}
~~~

`local_requirements`의 각 플래그 기본값은 `false`입니다. 사용자 지정 CA나 MySQL 클라이언트 인증이 필요한 연결은 가져오는 장치에서 인증서와 키 파일을 선택해야 합니다. SQLite 정의에는 원래 파일 이름만 들어가며, 가져올 때 실제 DB 파일을 선택합니다. 암호와 토큰은 접속할 때 입력합니다. 앱은 내보낸 JSON에 로컬 인증서 경로와 연결 ID를 기록하지 않으며, JSON에 포함된 인증서 경로를 거부합니다.

내보내기는 현재 연결 버전을 확인한 뒤 새 파일을 만들고, 가져오기는 미리보기 당시의 SHA-256과 파일을 비교한 뒤 선택 항목을 하나의 트랜잭션으로 등록합니다. 작업 기록에는 가져오기·내보내기 건수와 결과를 남깁니다. `crates/stackport-core/tests/database_exchange.rs`에서 엔진별 설정 왕복과 선택·충돌·파일 검증을, `tests/desktop-smoke.cjs`에서 Windows 탐색기의 선택과 가져온 연결 표시를 검사합니다.

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

MongoDB 검사는 `tests/mongo-smoke.cjs`를 사용합니다. `STACKPORT_CDP_URL`에 격리 앱의 디버깅 주소, `STACKPORT_TEST_ROOT`에 빈 테스트 폴더, `STACKPORT_MONGO_BIN`에 Windows ZIP에서 꺼낸 `mongod.exe`의 절대 경로를 지정합니다. `STACKPORT_TEST_PYTHON`으로 PyMongo가 설치된 Python을 실행해 임시 서버의 문서와 제한 계정을 만듭니다. `STACKPORT_TEST_OPENSSL`은 테스트용 TLS 인증서 생성에 사용합니다. `STACKPORT_MONGO_TOOLS_BIN`에 공식 데이터베이스 도구 폴더의 절대 경로를 지정하면 아카이브 백업·복원도 검사합니다.

Windows의 MongoDB 8.0.38에서 제한 계정의 데이터베이스 범위, TLS 호스트 이름 검증, 운영 환경 확인, 컬렉션·뷰·인덱스 탐색, BSON 타입 보존과 문서 필터·표시 필드·정렬·페이지를 확인했습니다. 문서 편집은 네 가지 변경, 표시 필드를 제한한 조회에서 전체 문서 편집, 쓰기 권한 확인, BSON 타입만 바뀐 원본과 같은 이름으로 다시 생성한 컬렉션의 변경 거절을 검사합니다. 스키마 분석은 같은 계정에서 배열 내부 유형의 문서별 집계, 점이 포함된 필드와 중첩 경로 구분, 크기 초과 문서 제외, 권한 범위와 뷰를 검사합니다. 집계는 단계 이동과 비활성화의 결과 차이, 중간 및 전체 미리보기, 프로젝트 저장·다시 열기·JSON 교환, 중첩 쓰기 단계 차단을 검사합니다. 레플리카 세트와 Atlas의 DNS SRV 접속은 실서버 검증이 남았습니다.

SQL Server 검사는 `tests/sql-server-smoke.cjs`를 사용합니다. `STACKPORT_SQL_SERVER_PORT`에 루프백 테스트 인스턴스의 TCP 포트, `STACKPORT_SQL_SERVER_CA`에 PEM CA 경로, `STACKPORT_SQL_SERVER_SA_PASSWORD`에 테스트 인스턴스의 관리자 암호를 지정합니다. 스크립트는 Node의 `tedious` 패키지로 실행마다 별도 데이터베이스, 테이블·뷰와 제한 계정을 생성합니다. 패키지 경로는 `STACKPORT_TEDIOUS_PATH`로 지정할 수 있습니다. 격리 인스턴스에서 검사하고, 앱의 디버깅 주소는 `STACKPORT_CDP_URL`에 지정합니다.

서버가 TDS 8.0을 제공하면 `STACKPORT_SQL_SERVER_TEST_STRICT=1`을 지정해 엄격한 TLS 연결도 검사합니다.

격리 서버의 쓰기 가능한 백업 폴더를 `STACKPORT_SQL_SERVER_BACKUP_DIR`로 지정하면 백업·검증·앱 복원을 검사합니다. `STACKPORT_SQL_SERVER_BACKUP_ONLY=1`은 이 흐름만 실행합니다. 제한 계정의 권한, 기존 백업 세트 보존, 운영 확인, 체크섬 및 판독 검증, 검토 이후 생긴 DB·파일 이름 충돌을 확인합니다. Windows 앱에서 새 DB로 복원한 뒤 온라인 상태와 파일 경로, 행 수·큰 정수·바이너리를 비교합니다.

SQL Server 2022 CU28과 2025 CU11에서 Windows 앱의 SQL 로그인, 필수 TLS와 인증서·호스트 이름 검증, 제한 계정의 스키마·테이블·뷰, 열 타입, 복합 기본 키 페이징, 큰 정수·소수·HEX·유니코드 보존을 확인했습니다. 2025 CU11에서는 TDS 8.0 엄격한 TLS 연결과 미등록 CA 차단도 확인했습니다. Windows 통합 인증은 도메인 환경에서의 실서버 확인이 남았습니다.

SQL Server 2022와 Oracle Database 26ai Free의 Windows 검사에서 큰 소수와 시각 조건, 문자열 포함, 여러 열·NULL 정렬, 조건이 적용된 페이지 이동과 저장된 조건의 재적용을 확인합니다.

같은 검사에서 두 스키마에 있는 동명 객체, 권한이 없는 객체 제외, 열 검색의 리터럴 `%_`, 검색 결과에서 키보드로 열 구조 이동, Escape로 검색 버튼에 포커스 복귀를 확인합니다. SQL Server의 열 이름 검색은 한 객체에 일치하는 열이 여러 개여도 한 건으로 표시하고, 51개 결과의 두 페이지를 검사합니다.

SQL Server 구조 검사는 내림차순 복합 기본 키, 포함 열과 필터가 있는 인덱스, 컬럼스토어 열의 정렬 방향 생략, 비활성 인덱스·고유 키·CHECK, DEFAULT, 51개 제약조건의 두 페이지를 확인합니다. 교차 스키마·자기 참조 외래 키, 접근할 수 없는 참조 대상 가림, 키보드로 부모·자식 테이블에 오가는 동작도 확인합니다.

정의 SQL 검사는 SQL Server 뷰의 권한 제한·암호화, Oracle의 소유 객체 정의와 타 스키마 메타데이터 제한, 두 엔진에서의 원문 복사 및 UTF-8 파일 저장을 확인합니다.

SQL Server 테이블 검사는 사용자 정의 타입, XML 스키마 모음, 한글·대괄호 이름, IDENTITY, 계산 열, 마스킹, 포함 열과 필터, 비활성 인덱스와 제약조건을 포함합니다. Windows 앱에서 저장한 스크립트를 동일 의존성이 있는 별도 데이터베이스에 실행하고, 재생성한 테이블의 SQL을 다시 읽어 원본 스크립트와 비교합니다.

Oracle 검사는 `tests/oracle-smoke.cjs`를 사용합니다. `STACKPORT_ORACLE_PORT`와 `STACKPORT_ORACLE_TCPS_PORT`에 시험용 루프백 TCP·TCPS 포트, `STACKPORT_ORACLE_CA`에 `localhost` 서버 인증서의 PEM CA 경로, `STACKPORT_ORACLE_SYS_PASSWORD`에 폐기 가능한 인스턴스의 관리자 암호를 지정합니다. `STACKPORT_ORACLE_SERVICE` 기본값은 `FREEPDB1`입니다. `STACKPORT_TEST_PYTHON`으로 지정한 Python에 `oracledb`가 필요하며, 실행할 때마다 별도 테이블스페이스와 제한 계정을 생성합니다.

Oracle AI Database 26ai Free 23.26.4.0.0에서 Windows 앱의 서비스 이름·SID 로그인, 네이티브 TCPS와 인증서·호스트 이름 검증, 제한 계정의 스키마·테이블·뷰·구체화 뷰, NUMBER·유니코드·RAW·LOB 표시와 복합 기본 키 페이징을 확인했습니다.

시험용 CDB에 SID로 연결할 수 있으면 `STACKPORT_ORACLE_TEST_SID`를 지정해 SID 로그인도 확인합니다. TCP로 필터·정렬 등 데이터 탐색만 검증하는 환경에서는 `STACKPORT_ORACLE_TEST_TCP_ONLY=1`로 TCPS 검사를 생략할 수 있습니다.

격리 Oracle 서버가 쓸 수 있는 폴더를 `STACKPORT_ORACLE_PUMP_DIRECTORY_PATH`에 지정하면 Data Pump 검사를 실행합니다. 테스트는 권한이 다른 계정과 Oracle 디렉터리를 생성해 운영 확인, 기존 파일 보존, 진행 중인 서버 작업의 중단, 세 가지 백업과 가져오기 방식을 검사합니다. 앱에서 생성한 덤프를 읽기 전용 디렉터리 권한으로 별도 테스트 스키마에 적용합니다. 검토 후 변경한 원본 덤프와 대상 객체를 차단하고, 기존 행의 보존과 새 객체의 테이블스페이스·행 수·38자리 숫자·RAW·유니코드를 대조합니다.

Snowflake는 격리된 HTTPS 서버에서 인증 헤더, 인증서 검증, 상태 확인, gzip 분할 응답, 진행 중 조회 취소, 완전한 객체 경로가 지정된 정의 SQL 응답과 크기 제한을 검증합니다. 코어 테스트에서 정밀 소수와 문자열 필터의 바인딩, 정렬과 행 제한의 적용 순서, 스키마·객체·열 검색 SQL과 값 바인딩을 확인합니다. Windows 공통 탐색기 검사에서는 연결 등록과 검색, PAT·OAuth 입력 화면을 확인합니다.

실제 계정에 대한 Windows 검사는 `tests/snowflake-smoke.cjs`를 사용합니다. 시험용 계정의 `STACKPORT_SNOWFLAKE_TEST_ACCOUNT`, `STACKPORT_SNOWFLAKE_TEST_DATABASE`, `STACKPORT_SNOWFLAKE_TEST_SCHEMA`, `STACKPORT_SNOWFLAKE_TEST_OBJECT`, `STACKPORT_SNOWFLAKE_TEST_TOKEN`을 지정합니다. 객체에는 미리보기에 사용할 행이 한 개 이상 있어야 합니다. 필요하면 `STACKPORT_SNOWFLAKE_TEST_WAREHOUSE`, `STACKPORT_SNOWFLAKE_TEST_ROLE`, OAuth 사용 시 `STACKPORT_SNOWFLAKE_TEST_AUTH=oauth`를 지정합니다. 현재 역할에 객체 정의가 공개된 경우 `STACKPORT_SNOWFLAKE_TEST_DEFINITION=1`로 원문 복사와 파일 저장을 검증합니다. 소량의 시험 데이터로 `STACKPORT_SNOWFLAKE_TEST_EXPORT=1`을 설정하면 전체 결과의 JSON 저장도 검증합니다. 격리된 Windows 앱의 디버깅 주소는 `STACKPORT_CDP_URL`로 지정합니다.

MySQL 계열 E2E는 `tests/mysql-smoke.cjs`를 사용합니다. `STACKPORT_TEST_ROOT`에 빈 테스트 폴더, `STACKPORT_MYSQL_BIN`에 Windows ZIP에서 꺼낸 `mysqld.exe` 또는 `mariadbd.exe`의 절대 경로, `STACKPORT_MYSQL_ENGINE`에 `MySQL` 또는 `MariaDB`를 지정합니다. 테스트용 앱에 `STACKPORT_CDP_URL`을 연결하고 필요한 경우 `STACKPORT_TEST_OPENSSL`을 설정합니다. MySQL 8.4.13과 MariaDB 11.8.10에서 TLS 서버 검증과 `REQUIRE X509` 클라이언트 인증, SSH 점프 경유 및 터널 중단 후 재연결, 예상 실행 계획과 실제 분석 및 중단, 테이블·뷰 탐색, 그리드 필터·정렬과 조건 재적용, 읽기 전용 SQL 실행과 중단·시간 초과 후 재조회, 50행·128열을 넘는 전체 결과 저장, CSV·JSON 값 보존과 내보내기 중단을 확인합니다. 스크립트의 범위, 프로시저의 여러 결과 집합, 운영 환경 확인과 계정 권한, 저장점·커밋·롤백, 중단과 서버 시간 초과 후의 데이터도 검증합니다.

`STACKPORT_MYSQL_BACKUP_ONLY=1`은 논리 백업과 복원 검증을 실행합니다. Windows 앱과 MySQL 8.4.13·MariaDB 11.4.10을 사용해 클라이언트 인증서가 필요한 계정의 SQL 백업, SHA-256, 같은 경로 저장 차단, 사전 취소와 권한 검사를 확인했습니다. 앱과 공식 클라이언트에서 SQL을 복원해 한글·바이너리·큰 정수 값, 뷰·트리거·루틴·이벤트와 기본 콜레이션을 확인했습니다. 앱 경로에서는 구조 전용 백업, 구조와 데이터를 나눈 백업, 승인 뒤 원본 파일 교체, 대상 DB 이름 충돌, 부분 복원과 행 수 확인도 검증합니다.

같은 테스트에서 복합 기본 키 행의 여러 셀을 미리 보고 적용하거나 취소합니다. 조회 미리보기 범위를 벗어난 값 변경, 테이블 구조 변경, 제약·길이 오류가 적용을 막는지 확인합니다.

구조 검사는 인덱스 순서·접두 길이·가시성, 권한별 제약조건 조회, 전체 101개 제약조건의 두 페이지, 교차 데이터베이스 복합 외래 키와 자기 참조, 공개되지 않은 참조 대상, 뷰 정의 권한과 SQL 파일 저장을 다룹니다.

모니터 검사는 두 엔진에서 실제 행 잠금 대기를 만들고 차단 ID, 실행 시간 필터, SQL 표시 한도 및 권한 제한을 확인합니다. MySQL에서는 잠금 테이블을 읽을 수 있지만 다른 계정의 세션이 보이지 않는 계정도 검증합니다. Windows 화면은 SQL 표시 옵션, 자동 갱신, 모니터를 나간 뒤 객체 화면 복귀를 확인합니다.

PostgreSQL 검사는 PostgreSQL의 `bin` 폴더에 있는 `initdb.exe`, `postgres.exe`, `pg_ctl.exe`, `libpq.dll`과 OpenSSL, Python 3을 사용합니다. 실서버는 격리된 테스트 폴더에서 새로 초기화되고 루프백에만 바인딩됩니다. 테스트 스키마는 `libpq`로 TLS 연결을 열어 생성합니다. Python 실행 파일을 직접 지정하려면 `STACKPORT_TEST_PYTHON`을 설정합니다. 임시 CA와 DNS 이름이 있는 인증서로 직접 연결과 로컬 SSH 터널의 인증서 검증을 확인합니다. PostgreSQL 18.6에서 조회 제한, SQL 쓰기 차단, 매개변수 바인딩과 Latin-1 인코딩 오류, 예상·실제 실행 계획, 서버 취소·시간 제한, SQL 파일, 전체 CSV·JSON 내보내기와 중단·파일 충돌을 검사합니다. [libpq 명령 실행](https://www.postgresql.org/docs/18/libpq-exec.html)

SSH 점프 호스트와 게이트웨이를 각각 루프백에서 실행해 두 호스트 키를 확인하고, 경유 연결에서 PostgreSQL 조회와 서버 취소를 검증합니다. 터널을 중단하거나 점프 연결을 끊었을 때의 안내와 복구 버튼, 중단된 터널 선택 시 연결 제한, 같은 터널을 다시 시작한 뒤 남은 SQL 초안 실행도 확인합니다. 내보내기 매개변수를 입력하는 도중 연결이 끊기면 저장을 중단하고 결과 파일을 만들지 않는지 검사합니다.

객체 검색 검사는 두 스키마의 동명 객체, 리터럴 `%`와 `_`, 열 주석, 표시 한도보다 긴 SQL 정의 뒤쪽의 일치, 접근 권한이 없는 객체, 종류 필터와 40개 단위 페이지 이동을 확인합니다. 검색 결과에서 해당 구조로 이동한 뒤 데이터 보기를 직접 열어 확인합니다.

서버 모니터 검사는 작업용 세션에서 쿼리를 실행하는 동안 별도의 연결로 실행 시간과 실제 자문 잠금의 차단 PID를 조회합니다. 권한이 다른 역할의 실행 SQL·상태·대기 정보 가림, 모니터의 5초 새로 고침, 작업 연결 종료와 SSH 터널 중단 시 모니터 정리를 확인합니다.

누적 쿼리 검사는 `pg_stat_statements` 서버 모듈과 확장 설치 파일을 사용합니다. 큰따옴표가 포함된 스키마에 확장을 설치하고, 같은 이름의 다른 뷰가 있어도 확장 소유 뷰를 조회하는지 확인합니다. 실제 실행 시간·호출 수·세션 역할, 정렬·페이지·하한, 타 DB 통계 제외, SQL·쿼리 ID 가림, 확장 미설치·사전 로드 누락·권한 부족 안내를 각각 확인합니다.

객체 구조 검사에서는 복합 외래 키 열 순서, 생성 열, 부분 인덱스, 비활성 트리거, 하위 파티션의 직접 조회 권한, 구조 목록의 페이지 이동과 뷰 정의 파일의 내용을 확인합니다.

그리드 검사는 날짜 범위와 NULL 순서, 정밀한 `numeric` 일치, 다른 열 페이지의 필터 조건, 입력 형식 오류 후 수정, 적용한 조건의 페이지 이동과 전체 CSV·JSON 행 순서를 확인합니다.

조회 조건 저장 검사는 PostgreSQL 재접속 후 날짜 범위와 정렬 복원, SQLite에서 저장·적용·갱신·삭제, 작업 공간 재열기 후 데이터 보존, 변경된 연결과 오래된 조건 버전의 재사용 거절을 확인합니다. 버전 10에서 이관하기 전 백업과 이관 실패 시 원본 보존도 검사합니다.

PostgreSQL 그리드 편집 검사는 복합 기본 키, 정확한 숫자 미리보기, `PROD` 확인, NULL과 서버 기본값 적용, 활성 행 수준 보안 정책의 변경 거절, 동시 수정 충돌을 확인합니다. 두 열의 조합을 검사하는 제약조건으로 여러 셀이 동시에 적용되는지 확인하고, 변경을 거절했을 때 두 값이 보존되는지 별도 연결에서 검사합니다. Windows 편집 창에서 미적용 초안 경고와 취소도 확인합니다.

PostgreSQL 다중 행 편집 검사는 Windows 그리드에서 같은 열 채우기, 행별 입력, 전후 비교와 저장 후 재조회를 확인합니다. 두 번째 행의 동시 수정·행 수준 보안·제약조건 오류와 커밋에서 확인되는 지연 외래 키 위반을 발생시켜 앞 행의 변경도 롤백되는지 별도 연결에서 검사합니다. 긴 셀의 편집 제한과 미리보기에서 확정한 상대 시간의 저장도 확인합니다.

Windows 파일 가져오기 검사는 실제 SQLite 파일에 UTF-16 CSV 120행을, 테스트 PostgreSQL 서버에 Windows-949 TSV 105행을 추가합니다. 25행 미리보기, 큰 숫자, NULL과 빈 문자열, 따옴표 안의 줄바꿈, 운영 확인을 검사합니다. SQLite의 중복 키와 PostgreSQL의 마지막 행 수준 보안 오류에서 앞서 처리한 데이터도 롤백되는지 확인합니다.

JSON 검사는 Windows에서 SQLite와 PostgreSQL의 결과를 내보낸 파일을 다른 테이블에 가져와 큰 정수·소수, BLOB·`bytea` 및 중첩 JSON을 다시 조회합니다. SQLite 형식 결과를 PostgreSQL의 `numeric`·`bytea` 열로 매핑하는 흐름도 검사합니다. 일반 객체 배열의 NULL·빈 문자열·생략한 기본값과 SQLite가 타입을 바꿀 때의 전체 롤백도 확인합니다.

XML 검사는 Windows의 두 엔진에서 레코드 경로 선택과 속성 매핑 후 큰 숫자, NULL, 빈 문자열과 기본값을 따로 조회합니다. SQLite에서 UTF-16 입력, 접두사가 다른 같은 네임스페이스, CDATA와 DTD 거절을 검사합니다. PostgreSQL에서 중첩 요소를 `xml` 열에 저장해 네임스페이스를 지정한 XPath로 확인합니다.

행 추가·삭제 검사는 UPDATE 권한 없이 INSERT와 DELETE를 실행할 수 있는지, 미리보기 중 행이 생기지 않는지, 서버 기본값과 자동 생성 키가 적용되는지 확인합니다. 이미 사용한 승인, 행 수준 보안의 삽입 거부, 연쇄 삭제와 다른 연결이 수정한 행의 삭제를 검사합니다. Windows 화면에서 초안 보존, 운영 환경 확인, 저장된 행 보기와 삭제 취소도 확인합니다.

붙여넣기 검사는 PostgreSQL의 숫자 타입 변환과 미리보기 시각 보존, 빈 셀·기본값 처리, 행 수준 보안 및 지연 외래 키 제약조건에 의한 전체 롤백을 확인합니다. Windows 화면에서 열 매핑, 운영 환경 확인, 두 번째 행의 중복으로 첫 번째 행도 롤백되는 흐름을 검사합니다.

셀 원본 검사는 PostgreSQL의 72,003자 유니코드 텍스트와 90,002바이트 바이너리를 페이지로 읽고 새 파일의 전체 바이트를 비교합니다. 빈 값과 NULL 구분, 행 수준 보안, 조회 뒤 변경된 행의 미리보기·저장 거절, 같은 이름의 기존 파일 보존과 저장 감사 기록도 확인합니다.

셀 형식 검사는 긴 JSON의 중복 키와 큰 정수, 원문 페이지 복귀, XML 트리와 처리 지시문 원문 표시, PNG 렌더링·HEX 전환을 확인합니다. 크기 제한을 넘은 자료를 원문에서 계속 읽을 수 있는지 확인하고, PNG 미리보기에서 제외한 메타데이터가 실제 파일 저장 결과에는 보존되는지 비교합니다.

열 설정 검사는 SQLite에서 기본 키를 숨긴 채 행 편집을 열고 WebView2 페이지를 다시 열어 배치와 보기 프로필을 복원합니다. PostgreSQL에서는 이전 페이지 범위 밖의 열을 앞으로 옮겨 고정한 뒤 폭, 가로 스크롤 위치와 다음 열 페이지에서의 표시를 확인합니다. 조회 SQL, 필터 매개변수와 기본 배치 복귀를 함께 확인합니다.

표시 형식 검사는 SQLite와 PostgreSQL의 큰 정수·고정밀 숫자 표시, 날짜 형식, 타입별 색상과 프로필 복원을 확인합니다. SQLite 행 편집과 두 엔진의 CSV 내보내기에서 원래 숫자 값도 확인합니다.

```powershell
$env:STACKPORT_TEST_ROOT = '<출력된 테스트 폴더>'
$env:STACKPORT_POSTGRES_BIN = '<PostgreSQL 설치 폴더>\bin'
$env:STACKPORT_TEST_OPENSSL = '<OpenSSL 경로>\openssl.exe'
node tests/postgres-smoke.cjs
```

Windows 자격 증명 검사에서는 `STACKPORT_POSTGRES_CREDENTIAL_ONLY=1`, `STACKPORT_TEST_APP_EXE`에 격리 앱 실행 파일, `STACKPORT_POSTGRES_TOOLS_DIR`에 백업 도구 폴더를 지정합니다. 테스트용 암호만 저장해 별도 앱 프로세스에서 TLS 연결 및 모니터를 열고, 기존 앱에서 백업과 새 DB 복원을 수행한 뒤 저장 항목을 삭제합니다.

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
3. 편집 복구를 확장하고 다른 DB 어댑터를 개별 지원 매트릭스 및 실제 서버 테스트에 연결합니다.
4. 파일 전송, 원격 화면, 모델링, 이관·백업, 자동화, BI, AI, 협업과 게이트웨이를 명세의 각 SP ID 및 수용 테스트에 연결합니다. 미구현 기능은 지원되는 것처럼 표시하지 않습니다.
