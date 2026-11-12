//! Pure-file compatibility diagnostics. Never starts an app, service or fork.
use omp_pulse::{sessions::branch, sessions::jsonl};
use serde_json::{Value, json};
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture(PathBuf);
impl Fixture {
    fn new(rows: &[Value], suffix: &str) -> Self {
        let dir = std::env::temp_dir().join(format!(
            "omp-active-leaf-audit-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&dir).unwrap();
        let path = dir.join("synthetic.jsonl");
        let mut content = rows
            .iter()
            .map(Value::to_string)
            .collect::<Vec<_>>()
            .join("\n");
        content.push('\n');
        content.push_str(suffix);
        assert!(content.len() < 32 * 1024);
        std::fs::write(&path, content).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(self.0.parent().unwrap()).unwrap();
    }
}
fn message(id: &str, parent: &str, role: &str) -> Value {
    json!({"type":"message","id":id,"parentId":parent,
        "message":{"role":role,"content":id}})
}
fn common() -> Vec<Value> {
    vec![
        json!({"type":"session","version":3,"id":"session-header"}),
        message("u1", "session-header", "user"),
        message("a1", "u1", "assistant"),
        message("u2", "a1", "user"),
        message("a2", "u2", "assistant"),
        message("u3", "a1", "user"),
        message("a3", "u3", "assistant"),
    ]
}
fn usage(id: &str, parent: &str, marker: Option<Value>) -> Value {
    let mut v = json!({"type":"model_usage","id":id,"parentId":parent});
    if let Some(m) = marker {
        v["activeLeafId"] = m;
    }
    v
}
fn verify(case: &str, rows: Vec<Value>, expected: &[&str], suffix: &str) {
    let fixture = Fixture::new(&rows, suffix);
    let before = std::fs::read(&fixture.0).unwrap();
    let tree = jsonl::read_tree(&fixture.0);
    let branch = branch::user_messages(&fixture.0).unwrap();
    let active: Vec<_> = tree
        .iter()
        .filter(|r| r.active)
        .map(|r| r.id.as_str())
        .collect();
    let current: Vec<_> = tree
        .iter()
        .filter(|r| r.current)
        .map(|r| r.id.as_str())
        .collect();
    let branch_ids: Vec<_> = branch.iter().map(|r| r.entry_id.as_str()).collect();
    let display: Vec<_> = tree.iter().map(|r| r.id.as_str()).collect();
    println!(
        "{}",
        json!({"case":case,"expected_active_and_branch":expected,
        "actual_active":active,"actual_current":current,"actual_branch":branch_ids,
        "actual_display":display})
    );
    assert_eq!(
        std::fs::read(&fixture.0).unwrap(),
        before,
        "reader changed source"
    );
    assert_eq!(tree.len(), 3, "all user turns must remain present");
    assert_eq!(active, expected, "active path for {case}");
    assert_eq!(branch_ids, expected, "branch path for {case}");
    assert_eq!(
        current,
        expected.last().copied().into_iter().collect::<Vec<_>>(),
        "current for {case}"
    );
}
macro_rules! case {
    ($name:ident,$marker:expr,$expected:expr) => {
        #[test]
        fn $name() {
            let mut rows = common();
            rows.push(usage("usage", "a2", $marker));
            verify(stringify!($name), rows, $expected, "");
        }
    };
}
case!(
    late_usage_selects_current_sibling,
    Some(json!("a3")),
    &["u1", "u3"]
);
case!(null_clears_active_leaf, Some(Value::Null), &[]);
case!(
    stale_target_falls_back_to_latest_self_selected,
    Some(json!("missing")),
    &["u1", "u3"]
);
case!(
    header_is_not_a_session_entry_target,
    Some(json!("session-header")),
    &["u1", "u3"]
);
case!(absent_marker_preserves_ordinary_usage, None, &["u1", "u2"]);
case!(
    self_marker_selects_usage,
    Some(json!("usage")),
    &["u1", "u2"]
);
case!(
    malformed_numeric_marker_preserves_legacy_fallback,
    Some(json!(7)),
    &["u1", "u2"]
);
case!(
    malformed_object_marker_preserves_legacy_fallback,
    Some(json!({"id":"a3"})),
    &["u1", "u2"]
);
#[test]
fn marker_on_non_usage_is_ignored() {
    let mut rows = common();
    rows.push(json!({"type":"custom","id":"c","parentId":"a2","activeLeafId":"a3"}));
    verify("non-usage", rows, &["u1", "u2"], "");
}
#[test]
fn later_ordinary_entry_supersedes_marker() {
    let mut rows = common();
    rows.push(usage("usage", "a2", Some(json!("a3"))));
    rows.push(message("a4", "a2", "assistant"));
    verify("later-ordinary", rows, &["u1", "u2"], "");
}
#[test]
fn stale_marker_skips_earlier_null_and_redirects() {
    let mut rows = common();
    rows.push(usage("m1", "a2", Some(json!("a3"))));
    rows.push(usage("m2", "a2", Some(Value::Null)));
    rows.push(usage("m3", "a2", Some(json!("removed"))));
    verify("stale-after-markers", rows, &["u1", "u3"], "");
}
#[test]
fn captured_marker_target_is_not_recursively_resolved() {
    let mut rows = common();
    rows.push(usage("m1", "a2", Some(json!("a3"))));
    rows.push(usage("m2", "a3", Some(json!("m1"))));
    verify("marker-target-one-hop", rows, &["u1", "u2"], "");
}
#[test]
fn torn_tail_does_not_override_last_complete_marker() {
    let mut rows = common();
    rows.push(usage("usage", "a2", Some(json!("a3"))));
    verify(
        "torn-tail",
        rows,
        &["u1", "u3"],
        "{\"type\":\"message\",\"id\":",
    );
}
#[test]
fn version_two_without_marker_preserves_parent_graph() {
    let mut rows = common();
    rows[0]["version"] = json!(2);
    rows.push(usage("usage", "a2", None));
    verify("version-two", rows, &["u1", "u2"], "");
}
#[test]
fn legacy_branch_ids_and_linear_parenting_are_unchanged() {
    let rows = vec![
        json!({"type":"session","id":"old"}),
        json!({"type":"message","id":"u1","message":{"role":"user","content":"first"}}),
        json!({"type":"message","id":"a1","message":{"role":"assistant","content":"answer"}}),
        json!({"type":"message","message":{"role":"user","content":"second"}}),
        json!({"type":"model_usage","id":"m"}),
    ];
    let fixture = Fixture::new(&rows, "");
    let actual = branch::user_messages(&fixture.0).unwrap();
    assert_eq!(
        actual
            .iter()
            .map(|r| r.entry_id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "#2"]
    );
}
case!(
    malformed_bool_marker_preserves_legacy_fallback,
    Some(json!(false)),
    &["u1", "u2"]
);
case!(
    malformed_array_marker_preserves_legacy_fallback,
    Some(json!(["a3"])),
    &["u1", "u2"]
);
#[test]
fn stale_marker_can_fall_back_to_self_selecting_usage() {
    let mut rows = common();
    rows.push(usage("m1", "a3", Some(json!("m1"))));
    rows.push(usage("m2", "a2", Some(json!("missing"))));
    verify("fallback-self-usage", rows, &["u1", "u3"], "");
}
#[test]
fn missing_or_invalid_id_marker_is_not_accepted() {
    for id in [None, Some(json!(3))] {
        let mut rows = common();
        let mut tail = usage("discarded", "a2", Some(Value::Null));
        if let Some(id) = id {
            tail["id"] = id;
        } else {
            tail.as_object_mut().unwrap().remove("id");
        }
        rows.push(tail);
        verify("unaccepted-id", rows, &["u1", "u3"], "");
    }
}
#[test]
fn title_change_remains_a_valid_target() {
    let mut rows = common();
    rows.push(json!({"type":"title_change","id":"title-change","parentId":"a3"}));
    rows.push(usage("m1", "a2", Some(json!("title-change"))));
    verify("title-change", rows, &["u1", "u3"], "");
}
#[test]
fn real_entry_can_share_the_header_id() {
    let mut rows = common();
    rows[1]["parentId"] = Value::Null;
    rows.push(message("session-header", "a3", "assistant"));
    rows.push(usage("m1", "a2", Some(json!("session-header"))));
    verify("header-id-real-entry", rows, &["u1", "u3"], "");
}
#[test]
fn cyclic_non_user_parent_chain_still_terminates() {
    let mut rows = common();
    rows.push(json!({"type":"custom","id":"c1","parentId":"c2"}));
    rows.push(json!({"type":"custom","id":"c2","parentId":"c1"}));
    rows.push(usage("m1", "a2", Some(json!("c1"))));
    verify("cycle", rows, &[], "");
}
#[test]
fn duplicate_id_parser_policies_remain_distinct() {
    let mut rows = common();
    rows.push(message("a3", "a2", "assistant"));
    rows.push(usage("m1", "a2", Some(json!("a3"))));
    let fixture = Fixture::new(&rows, "");
    let tree = jsonl::read_tree(&fixture.0);
    let messages = branch::user_messages(&fixture.0).unwrap();
    assert_eq!(
        tree.iter()
            .filter(|r| r.active)
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "u2"]
    );
    assert_eq!(
        messages
            .iter()
            .map(|m| m.entry_id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "u3"]
    );
}
#[test]
fn malformed_late_header_preserves_physical_tail_behavior() {
    let mut rows = common();
    rows.push(usage("m1", "a2", Some(json!("a3"))));
    rows.push(json!({"type":"session","id":"late-header","parentId":"a2"}));
    verify("late-header-legacy", rows, &["u1", "u2"], "");
}
#[test]
fn pre_v2_marker_does_not_override_linear_branch() {
    let mut rows = common();
    rows[0]["version"] = json!(1);
    rows.push(usage("m1", "a2", Some(Value::Null)));
    let fixture = Fixture::new(&rows, "");
    let messages = branch::user_messages(&fixture.0).unwrap();
    assert_eq!(
        messages
            .iter()
            .map(|m| m.entry_id.as_str())
            .collect::<Vec<_>>(),
        ["u1", "u2", "u3"]
    );
}
