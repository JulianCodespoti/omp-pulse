use super::*;

mod file_read;
mod file_write;
mod internal_resources;
mod path_containment;

#[test]
fn failed_downloads_have_error_status_not_successful_file_bytes() {
    for (kind, status) in [
        (std::io::ErrorKind::NotFound, StatusCode::NOT_FOUND),
        (std::io::ErrorKind::PermissionDenied, StatusCode::FORBIDDEN),
        (std::io::ErrorKind::Other, StatusCode::INTERNAL_SERVER_ERROR),
    ] {
        assert_eq!(
            download_error(&std::io::Error::new(kind, "fixture")).status(),
            status
        );
    }
}

#[test]
fn missing_project_folder_is_a_structured_404_not_a_fallback() {
    let root = std::env::temp_dir().join(format!(
        "pulse-project-root-{:032x}",
        rand::random::<u128>()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let project = root.join("project");
    std::fs::create_dir(&project).unwrap();
    let session = root.join("session.jsonl");
    std::fs::write(
        &session,
        json!({"type":"session","version":3,"cwd":project}).to_string(),
    )
    .unwrap();
    assert_eq!(project_cwd(&session).ok().unwrap(), project);
    std::fs::remove_dir(&project).unwrap();
    let response = *project_cwd(&session).err().unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(root).unwrap();
}
