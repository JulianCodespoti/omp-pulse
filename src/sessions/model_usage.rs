//! Read omp's model usage index without taking a SQLite lock.
//!
//! The daemon deliberately does not depend on SQLite: the model picker only
//! needs two columns from one small table, so it reads the database file and
//! walks the ordinary SQLite table b-tree. A malformed, changing, missing, or
//! unsupported database is treated as no history; model browsing must never be
//! allowed to make omp unavailable.

use std::{collections::HashMap, fs::File, io::Read, path::Path};

const MAX_DATABASE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_BTREE_DEPTH: usize = 32;

/// One decoded column of a record, borrowing its text straight out of the page
/// buffer. The buffer is a plain `&[u8]` that outlives the walk, so the text
/// needs no per-field copy; only the model keys that survive sorting are
/// materialized as owned `String`s.
#[derive(Debug)]
enum Field<'a> {
    Text(&'a str),
    Integer(i64),
    Other,
}

#[derive(Debug)]
struct Usage<'a> {
    key: &'a str,
    last_used_at: i64,
}

/// Return model keys in omp's most-recently-used order.
///
/// `sessions_root` is normally `<data root>/omp/sessions`, making its parent
/// the same `<data root>/omp` directory where omp stores `agent.db`. The file
/// is opened and read once, then closed before this function returns.
pub fn recent_model_keys(sessions_root: &Path) -> Vec<String> {
    load_db(sessions_root).map_or_else(Vec::new, |db| read_usage(&db))
}

/// Providers holding a usable stored credential (`auth_credentials` rows that
/// are not disabled), sorted and de-duplicated. Only the provider and
/// disabled-cause columns are decoded, never the credential itself.
pub fn signed_in_providers(sessions_root: &Path) -> Vec<String> {
    load_db(sessions_root).map_or_else(Vec::new, |db| read_signed_in(&db))
}

/// `agent.db` with its committed WAL frames merged in; `None` when it is
/// missing, empty or oversized.
fn load_db(sessions_root: &Path) -> Option<Vec<u8>> {
    let db_path = sessions_root.parent().map(|p| p.join("agent.db"))?;
    let metadata = std::fs::metadata(&db_path).ok()?;
    if metadata.len() == 0 || metadata.len() > MAX_DATABASE_BYTES {
        return None;
    }
    let mut file = File::open(&db_path).ok()?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).ok()?;
    drop(file);
    // omp uses WAL mode. Merge only complete frames through the last commit;
    // otherwise a raw main-file read can lag behind the terminal's latest
    // model selection while it is writing the usage index.
    if let Ok(wal_metadata) = std::fs::metadata(db_path.with_file_name("agent.db-wal"))
        && wal_metadata.len() <= MAX_DATABASE_BYTES
        && let Ok(mut wal_file) = File::open(db_path.with_file_name("agent.db-wal"))
    {
        let mut wal = Vec::with_capacity(wal_metadata.len() as usize);
        if wal_file.read_to_end(&mut wal).is_ok() {
            merge_wal(&mut bytes, &wal);
        }
    }
    Some(bytes)
}

fn merge_wal(db: &mut Vec<u8>, wal: &[u8]) {
    if wal.len() < 32 {
        return;
    }
    let magic = read_u32(wal, 0);
    if magic != Some(0x377f0682) && magic != Some(0x377f0683) {
        return;
    }
    let Some(wal_page_size) = read_u32(wal, 8)
        .and_then(|n| usize::try_from(n).ok())
        .and_then(decode_page_size)
    else {
        return;
    };
    if db.len() < 100 {
        return;
    }
    // WAL frames index the SAME page grid as the main file, so a frame laid
    // out for another page size describes pages this database does not have.
    let db_raw_page_size = u16::from_be_bytes([db[16], db[17]]) as usize;
    if decode_page_size(db_raw_page_size) != Some(wal_page_size) {
        return;
    }
    let salt1 = read_u32(wal, 16);
    let salt2 = read_u32(wal, 20);
    let Some(frame_size) = 24usize.checked_add(wal_page_size) else {
        return;
    };
    let frame_count = (wal.len() - 32) / frame_size;
    let mut last_commit = None;
    for index in 0..frame_count {
        let at = 32 + index * frame_size;
        if read_u32(wal, at + 8) != salt1 || read_u32(wal, at + 12) != salt2 {
            continue;
        }
        if read_u32(wal, at + 4).unwrap_or(0) != 0 {
            last_commit = Some(index);
        }
    }
    let Some(last_commit) = last_commit else {
        return;
    };
    let commit_at = 32 + last_commit * frame_size;
    let Some(db_pages) = read_u32(wal, commit_at + 4).and_then(|n| usize::try_from(n).ok()) else {
        return;
    };
    let Some(target_len) = db_pages.checked_mul(wal_page_size) else {
        return;
    };
    if db_pages == 0 || target_len < 100 || db_pages > 16_384 {
        return;
    }
    let mut latest: HashMap<u32, usize> = HashMap::new();
    for index in 0..=last_commit {
        let at = 32 + index * frame_size;
        if read_u32(wal, at + 8) == salt1
            && read_u32(wal, at + 12) == salt2
            && let Some(page) = read_u32(wal, at)
            && page > 0
            && usize::try_from(page).ok().is_some_and(|p| p <= db_pages)
        {
            latest.insert(page, at + 24);
        }
    }
    db.resize(target_len, 0);
    for (page, source) in latest {
        let Some(page) = usize::try_from(page).ok() else {
            continue;
        };
        let Some(target) = page
            .checked_sub(1)
            .and_then(|p| p.checked_mul(wal_page_size))
        else {
            continue;
        };
        let Some(end) = target.checked_add(wal_page_size) else {
            continue;
        };
        if end <= db.len()
            && source
                .checked_add(wal_page_size)
                .is_some_and(|end| end <= wal.len())
        {
            db[target..end].copy_from_slice(&wal[source..source + wal_page_size]);
        }
    }
}

/// Visit every decodable row of the table named `table`. Rows are skipped, never
/// guessed at, when the file is not a readable SQLite database.
fn walk_named_table<'a, F: FnMut(&[Field<'a>])>(db: &'a [u8], table: &str, mut visit: F) {
    if db.len() < 100 || &db[..16] != b"SQLite format 3\0" {
        return;
    }
    let Some(page_size) = decode_page_size(u16::from_be_bytes([db[16], db[17]]) as usize) else {
        return;
    };
    let reserved = db[20] as usize;
    if reserved >= page_size {
        return;
    }
    let usable = page_size - reserved;
    let Some(root) = find_table_root(db, page_size, usable, table) else {
        return;
    };
    let mut seen = Vec::new();
    walk_table(db, page_size, usable, root, 0, &mut seen, &mut visit);
}

fn read_usage(db: &[u8]) -> Vec<String> {
    // Each key borrows straight out of `db`, which outlives this function, so
    // the walk never copies record text; the final collect is the one place an
    // owned `String` is created, for the keys that are actually returned.
    let mut rows: Vec<Usage<'_>> = Vec::new();
    walk_named_table(db, "model_usage", |fields| {
        let (Some(&Field::Text(key)), Some(&Field::Integer(last_used_at))) =
            (fields.first(), fields.get(1))
        else {
            return;
        };
        if !key.is_empty() {
            rows.push(Usage { key, last_used_at });
        }
    });
    rows.sort_by(|a, b| {
        b.last_used_at
            .cmp(&a.last_used_at)
            .then_with(|| a.key.cmp(b.key))
    });
    rows.into_iter().map(|row| row.key.to_owned()).collect()
}

// shortcut: a credential row whose payload overflows its leaf page is skipped
// by the walker, so a very large stored credential reads as not signed in;
// upgrade by following overflow chains if that is ever observed.
fn read_signed_in(db: &[u8]) -> Vec<String> {
    let mut providers = std::collections::BTreeSet::new();
    // Columns: id (rowid alias, stored NULL), provider, credential_type, data,
    // disabled_cause. Rows written before that column existed are shorter and
    // count as enabled.
    walk_named_table(db, "auth_credentials", |fields| {
        let Some(&Field::Text(provider)) = fields.get(1) else {
            return;
        };
        if !provider.is_empty() && !matches!(fields.get(4), Some(Field::Text(_))) {
            providers.insert(provider.to_owned());
        }
    });
    providers.into_iter().collect()
}

fn find_table_root(db: &[u8], page_size: usize, usable: usize, table: &str) -> Option<u32> {
    let mut root = None;
    let mut seen = Vec::new();
    walk_table(db, page_size, usable, 1, 0, &mut seen, &mut |fields| {
        if root.is_some() {
            return;
        }
        let (
            Some(&Field::Text(kind)),
            Some(&Field::Text(name)),
            Some(&Field::Text(_table_name)),
            Some(&Field::Integer(page)),
        ) = (fields.first(), fields.get(1), fields.get(2), fields.get(3))
        else {
            return;
        };
        if kind == "table" && name == table && page > 0 {
            root = u32::try_from(page).ok();
        }
    });
    root
}

fn walk_table<'a, F: FnMut(&[Field<'a>])>(
    db: &'a [u8],
    page_size: usize,
    usable: usize,
    page: u32,
    depth: usize,
    seen: &mut Vec<u32>,
    visit: &mut F,
) {
    if page == 0 || depth > MAX_BTREE_DEPTH || seen.contains(&page) {
        return;
    }
    let Some(start) = page_offset(db, page_size, page) else {
        return;
    };
    let page_base = start - if page == 1 { 100 } else { 0 };
    let Some(&flags) = db.get(start) else {
        return;
    };
    seen.push(page);
    match flags {
        0x05 => {
            let Some(header_end) = start.checked_add(12) else {
                return;
            };
            let Some(&count_hi) = db.get(start + 3) else {
                return;
            };
            let Some(&count_lo) = db.get(start + 4) else {
                return;
            };
            let count = u16::from_be_bytes([count_hi, count_lo]) as usize;
            let Some(rightmost) = read_u32(db, start + 8) else {
                return;
            };
            for index in 0..count {
                let Some(ptr_at) = start.checked_add(12 + index * 2) else {
                    return;
                };
                let Some(cell_at) = read_u16(db, ptr_at).map(|v| page_base + v as usize) else {
                    return;
                };
                let Some(child) = read_u32(db, cell_at) else {
                    return;
                };
                walk_table(db, page_size, usable, child, depth + 1, seen, visit);
            }
            if header_end <= db.len() {
                walk_table(db, page_size, usable, rightmost, depth + 1, seen, visit);
            }
        }
        0x0d => {
            let Some(count_hi) = db.get(start + 3) else {
                return;
            };
            let Some(count_lo) = db.get(start + 4) else {
                return;
            };
            let count = u16::from_be_bytes([*count_hi, *count_lo]) as usize;
            for index in 0..count {
                let Some(ptr_at) = start.checked_add(8 + index * 2) else {
                    return;
                };
                let Some(cell_at) = read_u16(db, ptr_at).map(|v| page_base + v as usize) else {
                    return;
                };
                let Some((payload, _next)) = read_leaf_cell(db, cell_at, page_base + usable) else {
                    continue;
                };
                if let Some(fields) = decode_record(payload) {
                    visit(&fields);
                }
            }
        }
        _ => {}
    }
}

fn page_offset(db: &[u8], page_size: usize, page: u32) -> Option<usize> {
    let page = usize::try_from(page).ok()?.checked_sub(1)?;
    // The boundary is the WHOLE page, measured from the page BASE. Page 1's
    // first 100 bytes are the file header, so that offset is added only after
    // the page itself is proven to lie inside the file; measuring after the
    // add would accept a page whose tail is missing, and the walk below would
    // then read cell offsets off the end of a truncated write.
    let base = page.checked_mul(page_size)?;
    if base.checked_add(page_size)? > db.len() {
        return None;
    }
    Some(base + if page == 0 { 100 } else { 0 })
}

fn read_leaf_cell(db: &[u8], at: usize, page_end: usize) -> Option<(&[u8], usize)> {
    let (payload_len, after_len) = read_varint(db, at)?;
    let (_, after_rowid) = read_varint(db, after_len)?;
    let payload_len = usize::try_from(payload_len).ok()?;
    let payload_end = after_rowid.checked_add(payload_len)?;
    if payload_end > db.len() || payload_end > page_end {
        return None;
    }
    Some((&db[after_rowid..payload_end], payload_end))
}

/// Decode one record's columns, borrowing any text straight out of `payload`.
///
/// The header's serial types and the record body are walked in a single pass:
/// each body's start depends only on the widths already decoded, so buffering
/// the serial types first would allocate a second `Vec` per record for no
/// gain. Every rejection here — a header that does not end exactly on
/// `header_len`, a body that runs past the payload, an unknown serial type, or
/// text that is not valid UTF-8 — still drops the whole record, which is the
/// same set of records a two-pass walk would have accepted.
fn decode_record(payload: &[u8]) -> Option<Vec<Field<'_>>> {
    let (header_len, mut pos) = read_varint(payload, 0)?;
    let header_len = usize::try_from(header_len).ok()?;
    if header_len == 0 || header_len > payload.len() {
        return None;
    }
    let mut body = header_len;
    let mut fields = Vec::new();
    while pos < header_len {
        let (serial, next) = read_varint(payload, pos)?;
        pos = next;
        match serial {
            0 => fields.push(Field::Other),
            1..=6 => {
                let width = match serial {
                    1 => 1,
                    2 => 2,
                    3 => 3,
                    4 => 4,
                    5 => 6,
                    6 => 8,
                    _ => unreachable!(),
                };
                let end = body.checked_add(width)?;
                if end > payload.len() {
                    return None;
                }
                let mut value = 0i64;
                for byte in &payload[body..end] {
                    value = (value << 8) | i64::from(*byte);
                }
                let bits = width * 8;
                if bits < 64 && value & (1i64 << (bits - 1)) != 0 {
                    value |= !0i64 << bits;
                }
                fields.push(Field::Integer(value));
                body = end;
            }
            8 => fields.push(Field::Integer(0)),
            9 => fields.push(Field::Integer(1)),
            12.. => {
                let length = usize::try_from((serial - 12) / 2).ok()?;
                let end = body.checked_add(length)?;
                if end > payload.len() {
                    return None;
                }
                if serial % 2 == 1 {
                    fields.push(Field::Text(std::str::from_utf8(&payload[body..end]).ok()?));
                } else {
                    fields.push(Field::Other);
                }
                body = end;
            }
            _ => return None,
        }
    }
    if pos != header_len {
        return None;
    }
    Some(fields)
}

/// Decode a SQLite page-size field, where `1` is the encoded form of 65536.
/// Shared by the WAL header and the database header so both agree on what a
/// page size is; anything outside the on-disk range that is not a power of two
/// is rejected rather than used as a stride over arbitrary offsets.
fn decode_page_size(raw: usize) -> Option<usize> {
    let page_size = if raw == 1 { 65_536 } else { raw };
    ((512..=65_536).contains(&page_size) && page_size.is_power_of_two()).then_some(page_size)
}

fn read_u16(bytes: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_be_bytes([*bytes.get(at)?, *bytes.get(at + 1)?]))
}

fn read_u32(bytes: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes([
        *bytes.get(at)?,
        *bytes.get(at + 1)?,
        *bytes.get(at + 2)?,
        *bytes.get(at + 3)?,
    ]))
}

fn read_varint(bytes: &[u8], at: usize) -> Option<(u64, usize)> {
    let mut value = 0u64;
    for index in 0..9 {
        let byte = *bytes.get(at.checked_add(index)?)?;
        if index == 8 {
            return Some(((value << 8) | u64::from(byte), at + 9));
        }
        value = (value << 7) | u64::from(byte & 0x7f);
        if byte & 0x80 == 0 {
            return Some((value, at + index + 1));
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE_SIZE: usize = 512;

    #[derive(Clone)]
    enum Value {
        Text(String),
        Integer(i64),
    }

    fn varint(mut value: u64) -> Vec<u8> {
        let mut out = [0u8; 9];
        let mut pos = 8;
        out[pos] = (value & 0x7f) as u8;
        value >>= 7;
        while value != 0 {
            pos -= 1;
            out[pos] = ((value & 0x7f) as u8) | 0x80;
            value >>= 7;
        }
        out[pos..].to_vec()
    }

    fn record(values: Vec<Value>) -> Vec<u8> {
        let serials: Vec<u64> = values
            .iter()
            .map(|value| match value {
                Value::Text(text) => 13 + 2 * text.len() as u64,
                Value::Integer(value) if (0..=127).contains(value) => {
                    if *value == 0 {
                        8
                    } else if *value == 1 {
                        9
                    } else {
                        1
                    }
                }
                Value::Integer(_) => 1,
            })
            .collect();
        let header_len = 1 + serials
            .iter()
            .map(|serial| varint(*serial).len())
            .sum::<usize>();
        let mut payload = varint(header_len as u64);
        for serial in serials {
            payload.extend(varint(serial));
        }
        for value in values {
            match value {
                Value::Text(text) => payload.extend(text.as_bytes()),
                Value::Integer(value) if value == 0 || value == 1 => {}
                Value::Integer(value) => payload.push(value as u8),
            }
        }
        payload
    }

    fn cell(rowid: u64, payload: Vec<u8>) -> Vec<u8> {
        let mut out = varint(payload.len() as u64);
        out.extend(varint(rowid));
        out.extend(payload);
        out
    }

    fn put_u16(bytes: &mut [u8], at: usize, value: usize) {
        bytes[at..at + 2].copy_from_slice(&(value as u16).to_be_bytes());
    }

    fn put_u32(bytes: &mut [u8], at: usize, value: usize) {
        bytes[at..at + 4].copy_from_slice(&(value as u32).to_be_bytes());
    }

    fn leaf(db: &mut [u8], page: usize, cells: Vec<Vec<u8>>) {
        let base = (page - 1) * PAGE_SIZE;
        let header = base + if page == 1 { 100 } else { 0 };
        db[header] = 0x0d;
        put_u16(db, header + 3, cells.len());
        let mut cursor = base + PAGE_SIZE;
        let mut pointers = Vec::new();
        for cell in cells {
            cursor -= cell.len();
            db[cursor..cursor + cell.len()].copy_from_slice(&cell);
            pointers.push(cursor - base);
        }
        put_u16(db, header + 5, cursor - base);
        for (index, pointer) in pointers.into_iter().enumerate() {
            put_u16(db, header + 8 + index * 2, pointer);
        }
    }

    fn empty_db(pages: usize) -> Vec<u8> {
        let mut db = vec![0; pages * PAGE_SIZE];
        db[..16].copy_from_slice(b"SQLite format 3\0");
        db[16..18].copy_from_slice(&(PAGE_SIZE as u16).to_be_bytes());
        db[18] = 1;
        db[19] = 1;
        db[44..48].copy_from_slice(&1u32.to_be_bytes());
        db
    }

    fn make_db(rows: &[(u64, &str)]) -> Vec<u8> {
        let mut db = empty_db(2);
        let schema = record(vec![
            Value::Text("table".into()),
            Value::Text("model_usage".into()),
            Value::Text("model_usage".into()),
            Value::Integer(2),
            Value::Text("x".into()),
        ]);
        leaf(&mut db, 1, vec![cell(1, schema)]);
        let model_rows = rows
            .iter()
            .map(|(timestamp, key)| {
                cell(
                    *timestamp,
                    record(vec![
                        Value::Text((*key).into()),
                        Value::Integer(*timestamp as i64),
                    ]),
                )
            })
            .collect();
        leaf(&mut db, 2, model_rows);
        db
    }

    fn wal_for_page(page: usize, image: &[u8]) -> Vec<u8> {
        let mut wal = vec![0; 32];
        wal[0..4].copy_from_slice(&0x377f0682u32.to_be_bytes());
        wal[4..8].copy_from_slice(&3007000u32.to_be_bytes());
        wal[8..12].copy_from_slice(&(PAGE_SIZE as u32).to_be_bytes());
        wal[16..20].copy_from_slice(&1u32.to_be_bytes());
        wal[20..24].copy_from_slice(&2u32.to_be_bytes());
        wal.extend((page as u32).to_be_bytes());
        wal.extend(2u32.to_be_bytes());
        wal.extend(1u32.to_be_bytes());
        wal.extend(2u32.to_be_bytes());
        wal.extend([0u8; 8]);
        wal.extend(image);
        wal
    }

    #[test]
    fn orders_rows_by_usage_timestamp() {
        let db = make_db(&[(1, "old/model"), (9, "new/model"), (5, "middle/model")]);
        assert_eq!(read_usage(&db), ["new/model", "middle/model", "old/model"]);
    }

    #[test]
    fn empty_table_is_empty() {
        assert!(read_usage(&make_db(&[])).is_empty());
    }

    #[test]
    fn signed_in_providers_skip_disabled_and_deduplicate() {
        let mut db = empty_db(2);
        let schema = record(vec![
            Value::Text("table".into()),
            Value::Text("auth_credentials".into()),
            Value::Text("auth_credentials".into()),
            Value::Integer(2),
            Value::Text("x".into()),
        ]);
        leaf(&mut db, 1, vec![cell(1, schema)]);
        // id, provider, type, data, disabled_cause (Integer 0 stands in for NULL).
        let row = |id: u64, provider: &str, disabled: Value| {
            cell(
                id,
                record(vec![
                    Value::Integer(0),
                    Value::Text(provider.into()),
                    Value::Text("oauth".into()),
                    Value::Text("{}".into()),
                    disabled,
                ]),
            )
        };
        leaf(
            &mut db,
            2,
            vec![
                row(1, "openrouter", Value::Integer(0)),
                row(2, "anthropic", Value::Integer(0)),
                row(3, "anthropic", Value::Integer(0)),
                row(4, "xai", Value::Text("expired".into())),
            ],
        );
        assert_eq!(read_signed_in(&db), ["anthropic", "openrouter"]);
        assert!(read_signed_in(&make_db(&[(1, "a/b")])).is_empty());
    }

    #[test]
    fn oversized_leaf_payload_is_skipped_without_panicking() {
        let mut db = make_db(&[]);
        let header = PAGE_SIZE;
        db[header] = 0x0d;
        put_u16(&mut db, header + 3, 1);
        let cell_start = header + PAGE_SIZE - 14;
        put_u16(&mut db, header + 8, PAGE_SIZE - 14);
        // Payload length 500 exceeds the 477-byte local leaf threshold. The
        // fixture intentionally omits the overflow page: the reader must
        // reject it safely rather than indexing beyond the page.
        db[cell_start..cell_start + 3].copy_from_slice(&[0x83, 0x74, 1]);
        assert!(read_usage(&db).is_empty());
    }

    #[test]
    fn truncated_final_page_yields_nothing_without_panicking() {
        // The model picker reads a file omp is actively writing, so the last
        // page can be a partial write. A page that does not lie WHOLE inside
        // the file is not walked at all: its cell pointers would address bytes
        // the file does not have, and the model list must degrade to no
        // history rather than to a row read off the end of the buffer.
        let mut db = make_db(&[(1, "old/model")]);
        assert_eq!(read_usage(&db), ["old/model"]);
        db.truncate(2 * PAGE_SIZE - 4);
        assert!(read_usage(&db).is_empty());
        // The schema page is intact, so the walk reaches the model page and
        // declines it: the empty result is the bound, not a lost root page.
        assert_eq!(db[100], 0x0d);
    }

    #[test]
    fn wal_commit_supersedes_base_and_incomplete_tail_is_ignored() {
        let mut db = make_db(&[(1, "old/model")]);
        let fresh = make_db(&[(99, "new/model")]);
        let mut wal = wal_for_page(2, &fresh[PAGE_SIZE..2 * PAGE_SIZE]);
        wal.extend([0u8; 20]);
        merge_wal(&mut db, &wal);
        assert_eq!(read_usage(&db), ["new/model"]);
    }

    #[test]
    fn corruption_and_missing_schema_are_empty() {
        let mut truncated = empty_db(1);
        truncated.truncate(80);
        assert!(read_usage(&truncated).is_empty());
        assert!(read_usage(&[]).is_empty());
        assert!(read_usage(&[0; 100]).is_empty());
        let mut bad_page_size = empty_db(1);
        bad_page_size[16..18].copy_from_slice(&513u16.to_be_bytes());
        assert!(read_usage(&bad_page_size).is_empty());
        let mut missing_schema = empty_db(2);
        leaf(
            &mut missing_schema,
            1,
            vec![cell(
                1,
                record(vec![
                    Value::Text("table".into()),
                    Value::Text("other".into()),
                    Value::Text("other".into()),
                    Value::Integer(2),
                    Value::Text("x".into()),
                ]),
            )],
        );
        assert!(read_usage(&missing_schema).is_empty());
    }

    #[test]
    fn btree_cycle_and_excessive_depth_are_empty() {
        let mut cycle = empty_db(1);
        let header = 100;
        cycle[header] = 0x05;
        put_u32(&mut cycle, header + 8, 1);
        assert!(read_usage(&cycle).is_empty());

        let mut deep = empty_db(34);
        for page in 1..=34 {
            let header = (page - 1) * PAGE_SIZE + if page == 1 { 100 } else { 0 };
            deep[header] = 0x05;
            if page < 34 {
                put_u32(&mut deep, header + 8, page + 1);
            }
        }
        assert!(read_usage(&deep).is_empty());
    }
}
