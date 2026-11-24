use rusqlite::Connection;
use stackport_core::{SchemaDifferenceStatus, Store};

const COMMON: &str = "CREATE TABLE parents (id INTEGER PRIMARY KEY);";
const SOURCE: &str = r#"
CREATE TABLE changing (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'base', owner INTEGER REFERENCES parents(id) ON DELETE CASCADE);
CREATE INDEX expression_idx ON changing (lower(name));
CREATE TRIGGER watched AFTER UPDATE ON changing BEGIN SELECT NEW.id; END;
CREATE TABLE "new""table" (id INTEGER PRIMARY KEY);
CREATE INDEX new_idx ON "new""table"(id);
CREATE TRIGGER new_trigger AFTER INSERT ON "new""table" BEGIN SELECT NEW.id; END;
CREATE VIEW observed AS SELECT name FROM changing;
"#;
const TARGET: &str = r#"
CREATE TABLE changing (id INTEGER PRIMARY KEY, name BLOB, owner INTEGER REFERENCES parents(id) ON DELETE SET NULL);
CREATE INDEX expression_idx ON changing (upper(name));
CREATE TRIGGER watched AFTER UPDATE ON changing BEGIN SELECT NEW.name; END;
CREATE TABLE "old""table" (value TEXT);
CREATE VIEW observed AS SELECT id FROM changing;
"#;

#[test]
fn compares_sqlite_member_changes_and_proposes_reviewable_statements() {
    let root = tempfile::tempdir().unwrap();
    let source = root.path().join("source.sqlite");
    let target = root.path().join("target.sqlite");
    let db = Connection::open(&source).unwrap();
    db.execute_batch(&format!("{COMMON}{SOURCE}")).unwrap();
    db.execute_batch("INSERT INTO changing (name) VALUES ('private schema test row');")
        .unwrap();
    drop(db);
    let db = Connection::open(&target).unwrap();
    db.execute_batch(&format!("{COMMON}{TARGET}")).unwrap();
    drop(db);
    let source_bytes = std::fs::read(&source).unwrap();
    let target_bytes = std::fs::read(&target).unwrap();
    let store = Store::open(root.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("compare scope").unwrap();
    let left = store
        .create_sqlite_profile(&project.id, "Source", source.to_str().unwrap(), "DEV")
        .unwrap();
    let right = store
        .create_sqlite_profile(&project.id, "Target", target.to_str().unwrap(), "PROD")
        .unwrap();
    let alias = store
        .create_sqlite_profile(&project.id, "Same file", source.to_str().unwrap(), "DEV")
        .unwrap();

    let result = store.compare_sqlite_schema(&left.id, &right.id).unwrap();
    assert_eq!(result.unchanged, 1);
    let different = result
        .changes
        .iter()
        .find(|change| change.name == "changing")
        .unwrap();
    assert_eq!(different.status, SchemaDifferenceStatus::Changed);
    assert!(different.draft_sql.is_none());
    assert!(different
        .members
        .iter()
        .any(|member| member.category == "열"
            && member.name == "name"
            && member
                .source
                .as_deref()
                .unwrap()
                .contains("TEXT · NOT NULL · DEFAULT 'base'")
            && member.target.as_deref().unwrap().contains("BLOB")));
    assert!(different
        .members
        .iter()
        .any(|member| member.category == "외래 키"
            && member.source.as_deref().unwrap().contains("삭제 CASCADE")
            && member.target.as_deref().unwrap().contains("삭제 SET NULL")));
    assert!(different
        .members
        .iter()
        .any(|member| member.category == "인덱스 SQL"
            && member.source.as_deref().unwrap().contains("lower(name)")));
    assert!(different
        .members
        .iter()
        .any(|member| member.category == "트리거"
            && member
                .target
                .as_deref()
                .unwrap()
                .contains("SELECT NEW.name")));
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("private schema test row"));

    let scratch = Connection::open_in_memory().unwrap();
    scratch.execute_batch(&format!("{COMMON}{TARGET}")).unwrap();
    for (name, status) in [
        ("new\"table", SchemaDifferenceStatus::SourceOnly),
        ("old\"table", SchemaDifferenceStatus::TargetOnly),
        ("observed", SchemaDifferenceStatus::Changed),
    ] {
        let change = result
            .changes
            .iter()
            .find(|change| change.name == name)
            .unwrap();
        assert_eq!(change.status, status);
        let sql = change.draft_sql.as_deref().unwrap();
        scratch.execute_batch(sql).unwrap();
    }
    let objects = scratch
        .prepare("SELECT name FROM sqlite_schema ORDER BY name")
        .unwrap()
        .query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<Vec<_>>>()
        .unwrap();
    assert!(objects.contains(&"new\"table".to_owned()));
    assert!(objects.contains(&"new_idx".to_owned()));
    assert!(objects.contains(&"new_trigger".to_owned()));
    assert!(!objects.contains(&"old\"table".to_owned()));
    assert_eq!(
        scratch
            .prepare("SELECT * FROM observed")
            .unwrap()
            .column_names(),
        ["name"]
    );

    let matching = store.compare_sqlite_schema(&left.id, &alias.id).unwrap();
    assert_eq!(matching.unchanged, 4);
    assert!(matching.changes.is_empty());
    assert!(store.compare_sqlite_schema(&left.id, &left.id).is_err());
    let other_project = store.create_project("other project").unwrap();
    let outside = store
        .create_sqlite_profile(
            &other_project.id,
            "Outside",
            target.to_str().unwrap(),
            "DEV",
        )
        .unwrap();
    assert_eq!(
        store
            .compare_sqlite_schema(&left.id, &outside.id)
            .unwrap()
            .changes
            .len(),
        result.changes.len(),
    );
    let choices = store.schema_comparison_connections().unwrap();
    assert!(choices
        .iter()
        .any(|profile| profile.id == outside.id && profile.project_name == "other project"));
    assert_eq!(std::fs::read(source).unwrap(), source_bytes);
    assert_eq!(std::fs::read(target).unwrap(), target_bytes);
}
