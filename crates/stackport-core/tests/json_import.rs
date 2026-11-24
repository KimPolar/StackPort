use serde_json::{json, Value};
use stackport_core::parse_json_import;

fn parsed(source: &str) -> Value {
    serde_json::to_value(parse_json_import(source).unwrap()).unwrap()
}

#[test]
fn records_keep_raw_numeric_tokens_nested_values_and_missing_members() {
    let table = parsed(
        r#"[{"__proto__":"safe","label":"","n":9007199254740993,"doc":{"amount":1.234567890123456789e40},"note":null},
            {"n":1e3090,"flag":true}]"#,
    );
    assert_eq!(
        table["headers"],
        json!(["__proto__", "label", "n", "doc", "note", "flag"])
    );
    assert_eq!(table["columnCount"], 6);
    assert_eq!(
        table["rows"],
        json!([
            [
                {"kind":"text","value":"safe"},
                {"kind":"text","value":""},
                {"kind":"integer","value":"9007199254740993"},
                {"kind":"json","value":r#"{"amount":1.234567890123456789e40}"#},
                {"kind":"null","value":""},
                null
            ],
            [null, null, {"kind":"number","value":"1e3090"}, null, null, {"kind":"boolean","value":"true"}]
        ])
    );
}

#[test]
fn reads_both_stackport_result_formats_by_position() {
    let sqlite = parsed(
        r#"{"format":"stackport.sqlite-results","version":1,"columns":["v","v","blob","float"],
        "rows":[[{"integer":"9223372036854775807"},"001",{"blob_hex":"00FF"},{"real":"-inf"}]]}"#,
    );
    assert_eq!(sqlite["headers"], json!(["v", "v", "blob", "float"]));
    assert_eq!(
        sqlite["rows"][0],
        json!([
            {"kind":"integer","value":"9223372036854775807"},
            {"kind":"text","value":"001"},
            {"kind":"blob","value":"00FF"},
            {"kind":"real","value":"-inf"}
        ])
    );
    let postgres = parsed(
        r#"{"format":"stackport.postgres-results","version":1,
        "columns":[{"name":"v","data_type":"numeric"},{"name":"v","data_type":"jsonb"},
                   {"name":"blob","data_type":"bytea"},{"name":"flag","data_type":"boolean"}],
        "rows":[["9007199254740993.123456789","{\"v\":1e42}","\\x00ff","true"],
                [null,null,"A\\377\\\\","false"]]}"#,
    );
    assert_eq!(
        postgres["columnTypes"],
        json!(["numeric", "jsonb", "bytea", "boolean"])
    );
    assert_eq!(
        postgres["rows"][0][0],
        json!({"kind":"number","value":"9007199254740993.123456789"})
    );
    assert_eq!(
        postgres["rows"][0][1],
        json!({"kind":"json","value":r#"{"v":1e42}"#})
    );
    assert_eq!(
        postgres["rows"][0][2],
        json!({"kind":"blob","value":"00ff"})
    );
    assert_eq!(
        postgres["rows"][1][2],
        json!({"kind":"blob","value":"41ff5c"})
    );
    assert_eq!(
        postgres["rows"][1][3],
        json!({"kind":"boolean","value":"false"})
    );
}

#[test]
fn rejects_invalid_records_versions_and_values_without_echoing_file_data() {
    for (source, diagnostic) in [
        (r#"[{"private":1,"\u0070rivate":2}]"#, "1번째 레코드"),
        ("[{},4]", "2번째 레코드"),
        (r#"[{"x":1}, {"private":"\ud800"}]"#, "문자열"),
        (
            r#"{"format":"stackport.sqlite-results","version":2,"columns":["v"],"rows":[["secret"]]}"#,
            "버전",
        ),
        (
            r#"{"format":"stackport.sqlite-results","version":1,"columns":["v"],"rows":[[{"blob_hex":"1z"}]]}"#,
            "BLOB",
        ),
        (
            r#"{"format":"stackport.sqlite-results","version":1,"columns":["v"],"rows":[["secret",null]]}"#,
            "열 수",
        ),
    ] {
        let error = parse_json_import(source).unwrap_err();
        assert!(error.contains(diagnostic), "{error}");
        assert!(
            !error.contains("private") && !error.contains("secret"),
            "{error}"
        );
    }
    let too_many_rows = format!("[{}{{\"x\":true}}]", "{\"x\":true},".repeat(1000));
    assert!(parse_json_import(&too_many_rows)
        .unwrap_err()
        .contains("1000행"));
}
