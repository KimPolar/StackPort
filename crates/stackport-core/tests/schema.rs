use rusqlite::Connection;
use stackport_core::{SchemaDocumentFormat, Store};

#[test]
fn reports_columns_composite_keys_indexes_foreign_keys_and_ddl() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("schema.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(r#"
        CREATE TABLE parent (code TEXT, revision INTEGER, PRIMARY KEY (code, revision));
        CREATE TABLE sqliteX_visible (id INTEGER);
        CREATE TABLE "odd""name" (
            parent_code TEXT NOT NULL DEFAULT 'missing',
            parent_revision INTEGER,
            calculated TEXT GENERATED ALWAYS AS (parent_code || parent_revision) VIRTUAL,
            FOREIGN KEY (parent_code, parent_revision) REFERENCES parent (code, revision) ON DELETE CASCADE
        );
        CREATE UNIQUE INDEX idx_expression ON "odd""name" (lower(parent_code), parent_revision DESC)
            WHERE parent_revision IS NOT NULL;
        CREATE VIEW preview AS SELECT parent_code FROM "odd""name";
    "#).unwrap();
    drop(db);
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("schema").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "fixture", source.to_str().unwrap(), "DEV")
        .unwrap();

    let parent = store.describe_object(&profile.id, "parent").unwrap();
    assert!(store
        .objects(&profile.id)
        .unwrap()
        .iter()
        .any(|object| object.name == "sqliteX_visible"));
    assert_eq!(
        store
            .describe_object(&profile.id, "sqliteX_visible")
            .unwrap()
            .columns[0]
            .name,
        "id"
    );
    assert_eq!(parent.columns[0].primary_key_position, 1);
    assert_eq!(parent.columns[1].primary_key_position, 2);
    let child = store.describe_object(&profile.id, "ODD\"NAME").unwrap();
    assert_eq!(child.object.name, "odd\"name");
    assert!(child.object.ddl.as_ref().unwrap().contains("CREATE TABLE"));
    assert_eq!(child.columns.len(), 3);
    assert!(child.columns[0].not_null);
    assert_eq!(child.columns[0].default_value.as_deref(), Some("'missing'"));
    assert_eq!(child.columns[2].hidden, 2);
    let index = child
        .indexes
        .iter()
        .find(|index| index.name == "idx_expression")
        .unwrap();
    assert!(index.unique && index.partial);
    assert_eq!(index.columns[0].name, None);
    assert_eq!(index.columns[1].name.as_deref(), Some("parent_revision"));
    assert!(index.columns[1].descending);
    assert_eq!(child.foreign_keys.len(), 2);
    assert_eq!(child.foreign_keys[0].target_table, "parent");
    assert_eq!(child.foreign_keys[0].on_delete, "CASCADE");
    assert_eq!(child.foreign_keys[1].to_column.as_deref(), Some("revision"));
    let view = store.describe_object(&profile.id, "preview").unwrap();
    assert_eq!(view.object.kind, "view");
    assert!(view.indexes.is_empty());
    let diagram = store.schema_diagram(&profile.id).unwrap();
    assert_eq!(
        diagram.iter().map(|table| table.name.as_str()).collect::<Vec<_>>(),
        ["odd\"name", "parent", "sqliteX_visible"]
    );
    assert_eq!(diagram[0].columns[2].name, "calculated");
    assert_eq!(diagram[0].foreign_keys.len(), 2);
    assert_eq!(diagram[0].foreign_keys[0].on_delete, "CASCADE");
    assert_eq!(diagram[1].columns[1].primary_key_position, 2);
    assert!(store
        .describe_object(&profile.id, "parent'); DROP TABLE parent; --")
        .is_err());
    assert!(store
        .query(&profile.id, "SELECT * FROM pragma_table_xinfo('parent')", 0)
        .is_err());
    assert_eq!(
        store
            .query(&profile.id, "SELECT count(*) FROM parent", 0)
            .unwrap()
            .rows[0][0]
            .display,
        "0"
    );
}

#[test]
fn exports_both_schema_formats_without_data_or_overwriting_files() {
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("document-source.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(r#"
        CREATE TABLE "코드|<script>" (
            /* 원본 SQL 주석 </code></pre> */
            "키|열" TEXT NOT NULL,
            revision INTEGER NOT NULL CHECK (revision > 0),
            label TEXT DEFAULT '<img>',
            calculated INTEGER GENERATED ALWAYS AS (revision + 1) STORED,
            PRIMARY KEY ("키|열", revision)
        );
        CREATE TABLE detail (
            ref TEXT, rev INTEGER,
            FOREIGN KEY (ref, rev) REFERENCES "코드|<script>" ON DELETE CASCADE
        );
        CREATE INDEX "검색|인덱스" ON detail (lower(ref), rev DESC) WHERE rev > 1;
        CREATE TRIGGER record_revision AFTER UPDATE ON detail BEGIN SELECT NEW.rev; END;
        CREATE VIEW snapshot_view AS SELECT label FROM "코드|<script>";
        INSERT INTO "코드|<script>" ("키|열", revision, label) VALUES ('sample', 1, 'private record sentinel');
    "#).unwrap();
    drop(db);
    let original = std::fs::read(&source).unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("문서 검증").unwrap();
    let profile = store
        .create_sqlite_profile(&project.id, "검증 <연결>", source.to_str().unwrap(), "DEV")
        .unwrap();
    let markdown = directory.path().join("table.md");
    let report = store
        .export_schema_document(
            &profile.id,
            Some("코드|<SCRIPT>"),
            SchemaDocumentFormat::Markdown,
            markdown.to_str().unwrap(),
        )
        .unwrap();
    let md = std::fs::read_to_string(&markdown).unwrap();
    assert_eq!(report.objects, 1);
    assert_eq!(report.size_bytes, md.len());
    assert!(md.contains(r"## 테이블 코드\|\<script\>"));
    assert!(md.contains(r"| 키\|열 | TEXT | 예 | — | PK 1 |"));
    assert!(md.contains("    /* 원본 SQL 주석 </code></pre> */"));
    assert!(md.contains("저장 생성 열"));
    assert!(!md.contains("snapshot_view"));
    assert!(!md.contains("private record sentinel"));

    let html = directory.path().join("workspace.html");
    let report = store
        .export_schema_document(
            &profile.id,
            None,
            SchemaDocumentFormat::Html,
            html.to_str().unwrap(),
        )
        .unwrap();
    let rendered = std::fs::read_to_string(&html).unwrap();
    assert_eq!(report.objects, 3);
    assert_eq!(report.size_bytes, rendered.len());
    assert!(rendered.contains("코드|&lt;script&gt;"));
    assert!(rendered.contains("&lt;/code&gt;&lt;/pre&gt;"));
    assert!(rendered.contains("검증 &lt;연결&gt;"));
    assert!(rendered.contains("기본 키 2번째 열"));
    assert!(rendered.contains("CREATE INDEX"));
    assert!(rendered.contains("CREATE TRIGGER"));
    assert!(rendered.contains("CHECK (revision &gt; 0)"));
    assert!(rendered.contains("snapshot_view"));
    assert!(!rendered.contains("<script>"));
    assert!(!rendered.contains("<img>"));
    assert!(!rendered.contains("private record sentinel"));
    assert!(store
        .export_schema_document(
            &profile.id,
            None,
            SchemaDocumentFormat::Html,
            html.to_str().unwrap()
        )
        .is_err());
    assert_eq!(std::fs::read_to_string(html).unwrap(), rendered);
    assert_eq!(std::fs::read(&source).unwrap(), original);
    let audit = store.list_audit_events(None).unwrap();
    let operations: Vec<_> = audit
        .events
        .iter()
        .filter(|event| event.operation == "sqlite.schema.export")
        .collect();
    assert_eq!(operations.len(), 6);
    assert_eq!(operations[0].outcome, "failed");
    assert_eq!(operations[2].affected_count, Some(3));
    assert!(operations.iter().all(|event| event.object_name.is_none()));
}
