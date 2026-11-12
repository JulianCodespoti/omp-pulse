use super::*;

/// A canonical full collab link (22-char room, 64-char full secret) that
/// `linkscrape::scrape_text` validates. The room ids below are unique per
/// test so the pane cooldown static never leaks between tests.
fn collab_link(room: &str) -> String {
    format!("wss://localhost:7682/r/{room}.{}", "A".repeat(64))
}

#[test]
fn identity_is_required_before_any_link_is_taken() {
    // THE REGRESSION: a pane that is sharing but shows a different
    // conversation must never contribute its link.
    assert_eq!(pane_verdict(&[], true), PaneVerdict::NotThisSession);
    assert_eq!(pane_verdict(&[], false), PaneVerdict::NotThisSession);
}

#[test]
fn stale_view_is_refused_even_when_sharing() {
    assert_eq!(pane_verdict(&[1, 3], true), PaneVerdict::Behind);
    assert_eq!(pane_verdict(&[2], false), PaneVerdict::Behind);
}

#[test]
fn current_view_decides_between_reuse_and_enable() {
    assert_eq!(pane_verdict(&[0, 2], true), PaneVerdict::TakeExistingLink);
    assert_eq!(pane_verdict(&[0], false), PaneVerdict::EnableSharing);
}

#[test]
fn poll_schedule_is_adaptive_and_bounded() {
    // 120 ms for the first second, 400 ms until the third, then 800 ms —
    // the total is still bounded by LINK_TIMEOUT.
    assert_eq!(
        poll_delay(Duration::from_millis(0)),
        Duration::from_millis(120)
    );
    assert_eq!(
        poll_delay(Duration::from_millis(999)),
        Duration::from_millis(120)
    );
    assert_eq!(
        poll_delay(Duration::from_secs(1)),
        Duration::from_millis(400)
    );
    assert_eq!(
        poll_delay(Duration::from_millis(2999)),
        Duration::from_millis(400)
    );
    assert_eq!(
        poll_delay(Duration::from_secs(3)),
        Duration::from_millis(800)
    );
    assert_eq!(
        poll_delay(Duration::from_secs(9)),
        Duration::from_millis(800)
    );
}

#[tokio::test]
async fn already_sharing_pane_returns_link_without_submitting() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "a1".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    fake.fallback(&format!(
        "conversation text the newest assistant message {}",
        collab_link("rAAAAAAAAAAAAAAAAAAAAA")
    ));
    let backend = TerminalBackend::Fake(fake);
    let prints = vec!["the newest assistant message".to_string()];

    let out = adopt_with_budget(
        &backend,
        "/sessions/a.jsonl",
        None,
        &prints,
        Duration::from_secs(2),
    )
    .await;

    let link = out.expect("an already-sharing pane must return the printed link");
    assert!(link.contains("rAAAAAAAAAAAAAAAAAAAAA"));
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(
                f.submit_count(),
                0,
                "no /collab may be typed when the pane already shares"
            )
        }
        _ => unreachable!(),
    }
}

/// The pane's REAL render (room key replaced by a synthetic one of equal
/// length) right after a successful `/collab`: the quoted `omp join`
/// hint with the link split mid-secret, then the web deep link split
/// again, then the prose. Neither raw pass yields a whole secret, so only
/// the de-wrapped pass finds it — and what it finds must be registrable,
/// or adoption hands the write path a link `register_and_tap` refuses.
#[test]
fn real_pane_render_scrapes_to_a_registrable_link() {
    let text = concat!(
        " Join in browser  Collab session started!\n",
        "  • Join from another terminal: omp join\n",
        " \"ws://127.0.0.1:7682/r/mBt_wHzBvIWPIRUePrxrnA.BwgJCgsMDQ4PEBESExQVFhcYGRo\n",
        " bHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2\"\n",
        "  • or any web browser:\n",
        " 127.0.0.1:7682/#ws://127.0.0.1:7682/r/mBt_wHzBvIWPIRUePrxrnA.BwgJCgsMDQ4P\n",
        " EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2\n",
        " Anyone with the link can read the session and prompt the agent. Read-only\n",
        " link: /collab view\n",
    );
    let found = registrable_link(text).expect("the real render must yield a usable link");
    assert_eq!(found.room, "mBt_wHzBvIWPIRUePrxrnA");
    assert_eq!(
        found.link,
        "ws://127.0.0.1:7682/r/mBt_wHzBvIWPIRUePrxrnA.BwgJCgsMDQ4PEBESExQVFhcYGRo\
             bHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2"
    );
}

/// A `wss://` link on a REMOTE relay stays usable: the policy is about
/// plaintext, not locality.
#[test]
fn wss_remote_link_is_registrable() {
    let text = format!(
        "omp join \"wss://my.omp.sh/r/bbbbbbbbbbbbbbbbbbbbAA.{}\"",
        "A".repeat(64)
    );
    assert!(registrable_link(&text).is_some());
}

/// THE PLAINTEXT-RELAY BUG, end to end: the pane shares over a plaintext,
/// non-loopback relay, so `register_and_tap` refuses its link ("relay link
/// must be wss://") — and taking it anyway refused every phone send as
/// "session is owned by a desktop terminal" while the desktop VISIBLY
/// showed its collab box. A link the daemon will not register must not
/// count as "already sharing": the pane is typed into instead, and the
/// link that follows (on the configured, loopback relay) is used.
#[tokio::test]
async fn plaintext_remote_relay_link_is_ignored_and_reshared_locally() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "plaintext-relay".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    let prints = vec!["the newest assistant message".to_string()];
    // What omp prints when `collab.relayUrl` names a reachable but
    // non-loopback relay, or `/collab <relayUrl>` was run explicitly.
    let remote = format!(
        "the newest assistant message ws://laptop.tail1234.ts.net:7682/r/\
             mBt_wHzBvIWPIRUePrxrnA.{}",
        "A".repeat(64)
    );
    let local = format!(
        "the newest assistant message {}",
        collab_link("mBt_wHzBvIWPIRUePrxrnA")
    );
    fake.script("plaintext-relay", vec![remote, local]);
    let backend = TerminalBackend::Fake(fake);

    let out = adopt_with_budget(
        &backend,
        "/sessions/plaintext.jsonl",
        None,
        &prints,
        Duration::from_secs(2),
    )
    .await;

    let link = out.expect("the pane must be re-shared on a registrable relay");
    assert!(
        !link.contains("laptop.tail1234"),
        "the plaintext remote link is never returned: {link}"
    );
    assert!(link.starts_with("wss://localhost:7682/r/mBt_wHzBvIWPIRUePrxrnA"));
    match &backend {
        TerminalBackend::Fake(f) => assert_eq!(
            f.submit_count(),
            1,
            "the pane is typed into; it is NOT taken as already sharing"
        ),
        _ => unreachable!(),
    }
}

/// …and when the pane keeps printing only that unusable link, the failure
/// names the relay it was sharing over, instead of the bare "owned by a
/// terminal" boilerplate that reads as "the desktop is not sharing".
#[tokio::test]
async fn unusable_relay_is_named_in_the_refusal() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "plaintext-only".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    fake.fallback(&format!(
        "the newest assistant message ws://laptop.tail1234.ts.net:7682/r/\
             mBt_wHzBvIWPIRUePrxrnA.{}",
        "A".repeat(64)
    ));
    let backend = TerminalBackend::Fake(fake);
    let prints = vec!["the newest assistant message".to_string()];

    let err = adopt_with_budget(
        &backend,
        "/sessions/plaintext.jsonl",
        None,
        &prints,
        Duration::from_millis(400),
    )
    .await
    .unwrap_err();

    assert!(
        err.contains("ws://laptop.tail1234.ts.net:7682"),
        "the refusal must name the relay omp is sharing over: {err}"
    );
    assert!(
        !err.contains("AAAA"),
        "the refusal must never carry the room key: {err}"
    );
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(f.submit_count(), 1, "it still asks the pane to share")
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn owner_resolved_untitled_pane_adopts_without_fingerprints() {
    // Untitled/new sessions can have no qualifying message text yet.
    // The guard's owner proof is still sufficient for a herdr pane, so
    // adoption must not fall back to asking the phone for a manual link.
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "untitled-owner".to_string(),
        cwd: String::new(),
        owner_resolved: true,
    }]);
    let link = collab_link("uAAAAAAAAAAAAAAAAAAAAA");
    fake.script(
        "untitled-owner",
        vec![
            "an untitled conversation with no fingerprints".to_string(),
            format!("an untitled conversation with no fingerprints {link}"),
        ],
    );
    let backend = TerminalBackend::Fake(fake);

    let out = adopt_with_budget(
        &backend,
        "/sessions/untitled.jsonl",
        None,
        &[],
        Duration::from_secs(2),
    )
    .await
    .expect("owner proof must allow adoption without message fingerprints");

    assert!(out.contains("uAAAAAAAAAAAAAAAAAAAAA"));
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(f.submit_count(), 1, "exactly one /collab submit")
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn submit_once_then_link_appears_on_second_read() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "b1".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    let prints = vec![
        "the newest assistant message".to_string(),
        "an older message".to_string(),
    ];
    let before = "conversation text an older message and the newest assistant message";
    let after = format!("{before} {}", collab_link("sAAAAAAAAAAAAAAAAAAAAA"));
    fake.script("b1", vec![before.to_string(), after]);
    let backend = TerminalBackend::Fake(fake);

    let out = adopt_with_budget(
        &backend,
        "/sessions/b.jsonl",
        None,
        &prints,
        Duration::from_secs(2),
    )
    .await;

    let link = out.expect("the link printed after /collab must be returned");
    assert!(link.contains("sAAAAAAAAAAAAAAAAAAAAA"));
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(f.submit_count(), 1, "exactly one /collab submit")
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn stale_pane_is_refused_without_submitting() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "c1".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    // Shows an older message but not the newest one: a stale view.
    fake.fallback("conversation text an older message but not the newest one");
    let backend = TerminalBackend::Fake(fake);
    let prints = vec![
        "the newest assistant message".to_string(),
        "an older message".to_string(),
    ];

    let err = adopt_with_budget(
        &backend,
        "/sessions/c.jsonl",
        None,
        &prints,
        Duration::from_secs(2),
    )
    .await
    .unwrap_err();

    assert!(
        err.contains("behind"),
        "refusal must explain the stale view: {err}"
    );
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(
                f.submit_count(),
                0,
                "a stale view must never be made the host"
            )
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn wrong_conversations_link_is_never_taken() {
    // THE REGRESSION that leaked fixture prompts into a live conversation:
    // a pane that is sharing a DIFFERENT conversation prints a link that
    // must never be returned for this session, even though it appears
    // first.
    let mut fake = FakeHost::new(vec![
        PaneRef {
            id: "d1".to_string(),
            cwd: "/project/other".to_string(),
            owner_resolved: false,
        },
        PaneRef {
            id: "d2".to_string(),
            cwd: String::new(),
            owner_resolved: false,
        },
    ]);
    let prints = vec![
        "the newest assistant message".to_string(),
        "an older message".to_string(),
    ];
    let wrong_link = format!(
        "unrelated chat about the weather {}",
        collab_link("wAAAAAAAAAAAAAAAAAAAAA")
    );
    let before = "conversation text an older message and the newest assistant message";
    let right_link = format!("{before} {}", collab_link("rAAAAAAAAAAAAAAAAAAAAA"));
    fake.script("d1", vec![wrong_link]);
    fake.script("d2", vec![before.to_string(), right_link]);
    let backend = TerminalBackend::Fake(fake);

    let out = adopt_with_budget(
        &backend,
        "/sessions/d.jsonl",
        None,
        &prints,
        Duration::from_secs(2),
    )
    .await;

    let link = out.expect("the pane displaying this session must yield its link");
    assert!(
        link.contains("rAAAAAAAAAAAAAAAAAAAAA"),
        "the RIGHT conversation's link is returned"
    );
    assert!(
        !link.contains("wAAAAAAAAAAAAAAAAAAAAA"),
        "the wrong conversation's link is never returned"
    );
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(f.submit_count(), 1, "only the matching pane is typed into")
        }
        _ => unreachable!(),
    }
}

#[tokio::test]
async fn no_link_is_bounded_and_cooldown_suppresses_resubmit() {
    let mut fake = FakeHost::new(vec![PaneRef {
        id: "e1".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    }]);
    let prints = vec!["the newest assistant message".to_string()];
    fake.script(
        "e1",
        vec!["conversation text the newest assistant message but never a link".to_string()],
    );
    let backend = TerminalBackend::Fake(fake);
    let budget = Duration::from_millis(150);

    // First attempt: /collab is typed once, the poll burns the budget, no
    // link ever appears — a bounded error.
    let first = adopt_with_budget(&backend, "/sessions/e.jsonl", None, &prints, budget).await;
    assert!(
        first.is_err(),
        "a pane that never prints a link must time out, not hang"
    );
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(f.submit_count(), 1, "first attempt types exactly once")
        }
        _ => unreachable!(),
    }

    // Second attempt within the 60 s cooldown: read-only detection only —
    // no second /collab into the same pane, still bounded.
    let second = adopt_with_budget(&backend, "/sessions/e.jsonl", None, &prints, budget).await;
    assert!(second.is_err(), "cooldown still bounds the second attempt");
    match &backend {
        TerminalBackend::Fake(f) => {
            assert_eq!(
                f.submit_count(),
                1,
                "cooldown suppresses a second /collab into the same pane"
            )
        }
        _ => unreachable!(),
    }
}

#[test]
fn backends_follow_authority_order_for_a_synthetic_environment() {
    // The detection ordering is the contract: herdr first (most
    // authority), then kitty, then tmux, and an empty list when nothing
    // is usable. Synthetic booleans drive `ordered_backends` so the test
    // does not depend on what this machine actually has installed.
    let names = |v: Vec<BackendKind>| v.into_iter().map(BackendKind::name).collect::<Vec<_>>();
    assert_eq!(
        names(ordered_backends(true, true, true)),
        vec!["herdr", "kitty", "tmux"]
    );
    assert_eq!(names(ordered_backends(true, false, false)), vec!["herdr"]);
    assert_eq!(
        names(ordered_backends(false, true, true)),
        vec!["kitty", "tmux"]
    );
    assert_eq!(names(ordered_backends(false, false, true)), vec!["tmux"]);
    assert!(ordered_backends(false, false, false).is_empty());
}

#[test]
fn owner_resolved_pane_bypasses_not_this_session_and_behind() {
    let pane = PaneRef {
        id: "owner".to_string(),
        cwd: String::new(),
        owner_resolved: true,
    };
    assert_eq!(
        pane_verdict_for(&pane, &[], false),
        PaneVerdict::EnableSharing
    );
    assert_eq!(
        pane_verdict_for(&pane, &[4], false),
        PaneVerdict::EnableSharing
    );
}

#[test]
fn enumerated_pane_remains_gated_by_both_identity_verdicts() {
    let pane = PaneRef {
        id: "enumerated".to_string(),
        cwd: String::new(),
        owner_resolved: false,
    };
    assert_eq!(
        pane_verdict_for(&pane, &[], true),
        PaneVerdict::NotThisSession
    );
    assert_eq!(pane_verdict_for(&pane, &[2], false), PaneVerdict::Behind);
}

#[test]
fn owner_resolved_pane_prefers_an_existing_link() {
    let pane = PaneRef {
        id: "owner-link".to_string(),
        cwd: String::new(),
        owner_resolved: true,
    };
    assert_eq!(
        pane_verdict_for(&pane, &[], true),
        PaneVerdict::TakeExistingLink
    );
}

#[test]
fn strip_markdown_matches_what_a_terminal_renders() {
    // Inline code: the pane shows `AccessBlocked` without backticks.
    assert_eq!(
        strip_markdown("surface (e.g. `AccessBlocked`/`IsFrozen` fields) to confirm?"),
        "surface (e.g. AccessBlocked/IsFrozen fields) to confirm?"
    );
    // A trailing code fence (the end of a fenced block) renders away.
    // strip_markdown alone leaves the separator space; the fingerprints
    // pipeline collapses whitespace AFTER stripping, so the tail carries
    // no stray space either way. Assert the real pipeline shape.
    let collapsed = |s: &str| {
        strip_markdown(s)
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
    };
    assert_eq!(
        collapsed("Wall time: 102.86 seconds ```"),
        "Wall time: 102.86 seconds"
    );
    // Link labels: only the label is visible on the pane.
    assert_eq!(
        strip_markdown("see [the docs](https://example.com/x) for it"),
        "see the docs for it"
    );
    // Emphasis runs render as nothing.
    assert_eq!(
        strip_markdown("**important** ~struck~ detail"),
        "important struck detail"
    );
    // Underscores are literal in rendered code — MUST survive, or
    // snake_case identifiers would never match.
    assert_eq!(
        strip_markdown("the `approval_mode` field stays"),
        "the approval_mode field stays"
    );
    // Bare URLs render as themselves.
    assert_eq!(
        strip_markdown("see https://example.com/x now"),
        "see https://example.com/x now"
    );
}

#[tokio::test]
async fn no_backend_error_tells_the_user_the_manual_path() {
    // The degradation contract: with no usable backend the error must say
    // what to do instead, not fail with backend jargon. The empty list
    // stands in for an unsupported machine (Windows) or one with no
    // backend at all.
    let err = adopt_with_detected("/sessions/n.jsonl", None, Some(12345), &[])
        .await
        .unwrap_err();
    assert_eq!(err, no_backend_message());
    assert!(
        err.contains("run /collab once"),
        "the error must name the manual path: {err}"
    );
    assert!(
        err.contains("open the conversation"),
        "the error must tell the user what to open: {err}"
    );
}
