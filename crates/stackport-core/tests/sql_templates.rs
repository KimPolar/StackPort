use rusqlite::Connection;
use stackport_core::{SqlTemplateInput, SqlTemplateWrite, Store};

fn template(name: &str, folder: &str, sql: &str) -> SqlTemplateInput {
    SqlTemplateInput {
        name: name.into(),
        folder: folder.into(),
        sql: sql.into(),
        favorite: false,
    }
}

#[test]
fn stores_and_updates_templates_with_project_and_revision_boundaries() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("workspace.sqlite");
    let store = Store::open(&path).unwrap();
    let project = store.create_project("프로젝트 A").unwrap();
    let other = store.create_project("프로젝트 B").unwrap();
    let sql = "-- 한글😀\nSELECT :minimum AS threshold;";
    let item = store
        .save_sql_template(
            &project.id,
            SqlTemplateWrite::Create {
                template: template("  Report  ", " daily ", sql),
            },
        )
        .unwrap();
    assert_eq!(item.summary.name, "Report");
    assert_eq!(item.summary.folder, "daily");
    assert_eq!(item.sql, sql);
    assert!(store.list_sql_templates(&other.id).unwrap().is_empty());
    assert!(store
        .read_sql_template(&other.id, &item.summary.id)
        .is_err());
    assert!(store
        .save_sql_template(
            &project.id,
            SqlTemplateWrite::Create {
                template: template("report", "DAILY", "SELECT 2;"),
            }
        )
        .unwrap_err()
        .contains("동일한 이름"));
    assert!(store
        .save_sql_template(
            &project.id,
            SqlTemplateWrite::Create {
                template: template("report", "weekly", "SELECT 2;"),
            }
        )
        .is_ok());
    let favorite = store
        .save_sql_template(
            &project.id,
            SqlTemplateWrite::Favorite {
                id: item.summary.id.clone(),
                revision: item.summary.revision,
                favorite: true,
            },
        )
        .unwrap();
    assert!(favorite.summary.favorite);
    assert_eq!(favorite.summary.revision, 2);
    assert!(store
        .delete_sql_template(&project.id, &item.summary.id, 1)
        .is_err());
    assert!(store
        .save_sql_template(
            &other.id,
            SqlTemplateWrite::Update {
                id: item.summary.id.clone(),
                revision: 2,
                template: template("wrong", "", "SELECT 3;"),
            }
        )
        .is_err());
    let store = Store::open(&path).unwrap();
    assert_eq!(
        store.list_sql_templates(&project.id).unwrap()[0].id,
        item.summary.id
    );
    assert_eq!(
        store
            .read_sql_template(&project.id, &item.summary.id)
            .unwrap()
            .sql,
        sql
    );
    let duplicate = store.duplicate_project(&project.id, "복제본").unwrap();
    let duplicate_items = store.list_sql_templates(&duplicate.id).unwrap();
    assert_eq!(duplicate_items.len(), 2);
    assert_ne!(duplicate_items[0].id, item.summary.id);
    assert_eq!(duplicate_items[0].revision, 1);
    assert_eq!(
        store
            .read_sql_template(&duplicate.id, &duplicate_items[0].id)
            .unwrap()
            .sql,
        sql
    );
    store
        .delete_sql_template(&project.id, &item.summary.id, 2)
        .unwrap();
    assert_eq!(store.list_sql_templates(&project.id).unwrap().len(), 1);
    assert_eq!(store.list_sql_templates(&duplicate.id).unwrap().len(), 2);
    store.delete_project(&project.id).unwrap();
    let db = Connection::open(&path).unwrap();
    assert_eq!(
        db.query_row(
            "SELECT count(*) FROM sql_templates WHERE project_id=?1",
            [&project.id],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn rejects_invalid_inputs_and_changes_to_archived_projects() {
    let directory = tempfile::tempdir().unwrap();
    let store = Store::open(directory.path().join("workspace.sqlite")).unwrap();
    let project = store.create_project("project").unwrap();
    for input in [
        template("bad\nname", "", "SELECT 1;"),
        template("a", "", "SELECT '\0';"),
        template("b", "", &"가".repeat(100_000)),
        template("c", "", "  "),
    ] {
        assert!(store
            .save_sql_template(&project.id, SqlTemplateWrite::Create { template: input })
            .is_err());
    }
    store.archive_project(&project.id).unwrap();
    assert!(store.list_sql_templates(&project.id).is_err());
    assert!(store
        .save_sql_template(
            &project.id,
            SqlTemplateWrite::Create {
                template: template("valid", "", "SELECT 1;")
            }
        )
        .is_err());
    store.unarchive_project(&project.id).unwrap();
    assert!(store.list_sql_templates(&project.id).unwrap().is_empty());
}
