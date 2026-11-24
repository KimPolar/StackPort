use rusqlite::Connection;
use stackport_core::Store;

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
