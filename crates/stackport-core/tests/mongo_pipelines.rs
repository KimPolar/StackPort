use rusqlite::Connection;
use serde_json::{json, Value};
use stackport_core::{MongoPipelineWrite, SqlTemplateWrite, Store};

fn write(name: &str, stages: &Value, replaces: Option<(&str, i64)>) -> MongoPipelineWrite {
    serde_json::from_value(json!({
        "name": name,
        "stages": stages,
        "replaces": replaces.map(|(id, revision)| json!({ "id": id, "revision": revision })),
    }))
    .unwrap()
}

#[test]
fn migrates_v20_and_keeps_project_pipeline_drafts_and_revisions() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("원본").unwrap();
    let other = store.create_project("다른 프로젝트").unwrap();
    let legacy_template = store.save_sql_template(&project.id, serde_json::from_value::<SqlTemplateWrite>(json!({
        "kind": "create", "template": { "name": "기존", "folder": "", "sql": "SELECT $1", "favorite": false, "dialect": "postgres" },
    })).unwrap()).unwrap();
    drop(store);
    let db = Connection::open(&path).unwrap();
    db.execute_batch("DROP TABLE mongo_pipelines; PRAGMA user_version = 20;")
        .unwrap();
    drop(db);

    let store = Store::open(&path).unwrap();
    assert_eq!(
        store
            .read_sql_template(&project.id, &legacy_template.summary.id)
            .unwrap()
            .summary
            .dialect,
        "postgres"
    );
    assert!(directory.path().read_dir().unwrap().any(|entry| entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .starts_with("workspace.sqlite.v20-")));
    let stages = json!([
        { "operator": "$match", "enabled": true, "expression": "{\"max\":{\"$numberLong\":\"9223372036854775807\"}}" },
        { "operator": "$group", "enabled": false, "expression": "{ 아직 작성 중" },
    ]);
    let saved = store
        .save_mongo_pipeline(&project.id, write("요약", &stages, None))
        .unwrap();
    assert_eq!(saved.summary.revision, 1);
    let id = &saved.summary.id;
    assert_eq!(serde_json::to_value(&saved.stages).unwrap(), stages);
    assert!(store.list_mongo_pipelines(&other.id).unwrap().is_empty());
    assert!(store.read_mongo_pipeline(&other.id, id).is_err());
    assert!(store
        .save_mongo_pipeline(&other.id, write("타 프로젝트 수정", &stages, Some((id, 1))))
        .is_err());
    assert!(store
        .save_mongo_pipeline(&project.id, write("요약", &stages, None))
        .is_err());
    let updated = store
        .save_mongo_pipeline(&project.id, write("새 이름", &stages, Some((id, 1))))
        .unwrap();
    assert_eq!(updated.summary.revision, 2);
    assert!(store.delete_mongo_pipeline(&project.id, id, 1).is_err());

    let duplicate = store.duplicate_project(&project.id, "복제본").unwrap();
    let copies = store.list_mongo_pipelines(&duplicate.id).unwrap();
    assert_eq!(copies.len(), 1);
    assert_ne!(&copies[0].id, id);
    assert_eq!(copies[0].revision, 1);
    assert_eq!(
        serde_json::to_value(
            store
                .read_mongo_pipeline(&duplicate.id, &copies[0].id)
                .unwrap()
                .stages
        )
        .unwrap(),
        stages
    );
    store.delete_mongo_pipeline(&project.id, id, 2).unwrap();
    assert!(store.list_mongo_pipelines(&project.id).unwrap().is_empty());
}
