#!/usr/bin/env python3
"""Hermetic native receipt tests. Requires Python stdlib and the installed JDK only.

Exact production Java is mechanically extracted, hashed and compiled with lint-as-error.
JSON/Android/HTTP/executor/attachment boundaries in Java remain synthetic. Migration SQL
runs separately against genuine Python sqlite3, not Android SQLiteOpenHelper lifecycle.
No sockets, daemons, models, Android builds, emulators, ADB, or device operations.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app/NativeOutbox.java'
VALIDATOR = SOURCE.with_name('NativeReceiptValidator.java')


def block(text: str, anchor: str) -> str:
    """Return the exact declaration and balanced body, ignoring Java strings/comments."""
    if text.count(anchor) != 1:
        raise AssertionError(f'Expected one source anchor: {anchor!r}')
    start = text.index(anchor)
    opening = text.index('{', start)
    i, depth, state = opening, 0, 'code'
    while i < len(text):
        char = text[i]
        nxt = text[i:i+2]
        if state == 'line':
            if char == '\n': state = 'code'
        elif state == 'comment':
            if nxt == '*/': state = 'code'; i += 1
        elif state in ('string', 'char'):
            if char == '\\': i += 1
            elif char == ('"' if state == 'string' else "'"): state = 'code'
        elif nxt == '//': state = 'line'; i += 1
        elif nxt == '/*': state = 'comment'; i += 1
        elif char == '"': state = 'string'
        elif char == "'": state = 'char'
        elif char == '{': depth += 1
        elif char == '}':
            depth -= 1
            if depth == 0: return text[start:i+1] + '\n'
        i += 1
    raise AssertionError(f'Unclosed source block: {anchor}')


def sql_statements(method: str) -> list[str]:
    expressions = re.findall(r'db\.execSQL\((.*?)\);', method, re.S)
    result = []
    for expression in expressions:
        literals = re.findall(r'"(?:\\.|[^"\\])*"', expression)
        residue = re.sub(r'"(?:\\.|[^"\\])*"', '', expression)
        assert re.fullmatch(r'[\s+]*', residue), f'Unexpected SQL expression: {expression}'
        result.append(''.join(json.loads(literal) for literal in literals))
    return result


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_blob(data: bytes) -> str:
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()


def migration_proof(source: str, output: Path) -> int:
    baseline = json.loads((FIXTURES / 'baseline-v1-schema.json').read_text())
    assert baseline['source_blob'] == 'e7dd7f70c0b1308690e6b5c49411af511e858c69'
    fresh = sql_statements(block(source, '        @Override public void onCreate('))
    alters = sql_statements(block(source, '        @Override public void onUpgrade('))
    tables = ['commands', 'attachments', 'tombstones', 'clear_markers']
    checks = 0
    def check(label: str, ok: bool) -> None:
        nonlocal checks
        assert ok, label
        checks += 1
        print('PASS SQLITE ' + label, flush=True)
    upgraded_path = output / 'upgraded.sqlite'
    if upgraded_path.exists(): upgraded_path.unlink()
    db = sqlite3.connect(upgraded_path)
    for sql in baseline['create_sql']: db.execute(sql)
    db.execute('PRAGMA user_version=1')
    columns = {table: [r[1] for r in db.execute(f'PRAGMA table_info({table})')] for table in tables}
    for index, state in enumerate(['saved','uncertain','running','completed','forwarded','failed']):
        data = {
            'namespace': 'cred-fixture' if index < 4 else 'cred-other',
            'origin': 'https://fixture.invalid' if index % 2 else 'https://other.invalid',
            'command_id': f'id-{index}', 'session_path': '/raw/alias +?#/α.jsonl',
            'text': f'payload-{index}\x00 exact Unicode α\n', 'created_at': index + 1,
            'updated_at': 1000 + index, 'state': state,
            'receipt': None if index == 0 else json.dumps({'commandId': f'id-{index}', 'state': state, 'marker': 'preserve bytes  α'}, ensure_ascii=False),
            'error': None if index % 2 else 'retained error', 'legacy': index % 2,
            'may_post': int(index == 0), 'payload_hash': f'exact-hash-{index}',
            'payload_bytes': 123 + index, 'notification_reply': index % 2,
            'notify_title': 'title α', 'notify_body': 'body\nbytes', 'notify_kind': 'agent_end', 'notify_tag': f'tag-{index}',
        }
        assert set(data) == set(columns['commands'])
        db.execute('INSERT INTO commands(' + ','.join(data) + ') VALUES(' + ','.join('?' for _ in data) + ')', tuple(data.values()))
        db.execute('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)', (data['namespace'],data['origin'],data['command_id'],0,'image/png',f'/retained/private/{index}.b64',999 + index))
    db.execute('INSERT INTO tombstones VALUES(?,?,?,?)', ('cred-fixture','https://fixture.invalid','deleted-forever',42))
    db.execute('INSERT INTO clear_markers VALUES(?,?,?,?)', ('cred-fixture','https://fixture.invalid','',43))
    db.execute('INSERT INTO clear_markers VALUES(?,?,?,?)', ('cred-other','https://other.invalid','/raw/alias +?#/α.jsonl',44))
    before = {table: db.execute('SELECT ' + ','.join(columns[table]) + f' FROM {table} ORDER BY rowid').fetchall() for table in tables}
    db.commit(); db.close()
    db = sqlite3.connect(upgraded_path)
    with db:
        for sql in alters: db.execute(sql)
    db.close(); db = sqlite3.connect(upgraded_path)
    for table in tables:
        after = db.execute('SELECT ' + ','.join(columns[table]) + f' FROM {table} ORDER BY rowid').fetchall()
        check(table + ' retains every previous column and exact value', after == before[table])
    fresh_path = output / 'fresh.sqlite'
    if fresh_path.exists(): fresh_path.unlink()
    fresh_db = sqlite3.connect(fresh_path)
    for sql in fresh: fresh_db.execute(sql)
    def schema(conn: sqlite3.Connection, table: str) -> dict:
        # ALTER appends columns: logical schema is compared by name, not physical ordinal.
        return {row[1]: row[2:] for row in conn.execute(f'PRAGMA table_info({table})')}
    for table in tables: check(table + ' fresh and upgraded logical schemas match', schema(db, table) == schema(fresh_db, table))
    binding = '{"version":1,"requestedSessionPath":"/raw/alias +?#/α.jsonl","canonicalSessionPath":"/real/α.jsonl"}'
    with db: db.execute('UPDATE commands SET receipt_binding=?,receipt_revision=7 WHERE command_id=?', (binding,'id-2'))
    db.close(); db = sqlite3.connect(upgraded_path)
    check('bound evidence and local revision survive subsequent reopen', db.execute('SELECT receipt_binding,receipt_revision FROM commands WHERE command_id=?',('id-2',)).fetchone() == (binding,7))
    try:
        db.execute('INSERT INTO tombstones VALUES(?,?,?,?)',('cred-fixture','https://fixture.invalid','deleted-forever',99))
        unique = False
    except sqlite3.IntegrityError: unique = True
    check('tombstone uniqueness remains enforced', unique)
    db.close(); fresh_db.close()
    (output / 'migration-source.json').write_text(json.dumps({'baseline':baseline, 'fresh_create_sql':fresh,'upgrade_sql':alters},indent=2)+'\n')
    return checks


ANCHORS = [
    '    public static String namespace(',
    '    static JSONArray list(',
    '    static JSONObject get(',
    '    static JSONArray images(',
    '    static JSONObject editBegin(',
    '    private static boolean sameExpectedIntent(',
    '    static boolean editFinish(',
    '    private static List<String> removeRecord(',
    '    static boolean remove(',
    '    static JSONObject enqueue(',
    '    private static final class InsertResult ',
    '    private static void routeSavedCommand(',
    '    private static final class StatusKey ',
    '    private static void requestStatus(',
    '    private static void inspectSavedReceipt(',
    '    private static final class StoredIntent ',
    '    private static StoredIntent readIntent(Context ',
    '    private static StoredIntent readIntent(SQLiteDatabase ',
    '    private static String encodeBinding(',
    '    private static Object decodeBinding(',
    '    static void clear(',
    '    private static void assertNoPendingSessionEdit(',
    '    private static InsertResult insert(',
    '    private static JSONObject findExisting(',
    '    private static void assertSamePayload(',
    '    private static JSONObject prompt(',
    '    private static String delivery(',
    '    private static List<String> attachmentPaths(',
    '    private static boolean isTombstoned(',
    '    private static boolean wasCleared(',
    '    private static void validateState(',
    '    private static long utf8Length(',
    '    private static void digestField(',
    '    private static long decodedLength(',
    '    private static boolean versionCurrentlyVerified(',
    '    private static void deliver(',
    '    private static JSONObject postCommand(',
    '    private static List<Attachment> getAttachments(',
    '    private static void writeJsonString(',
    '    private static final class Attachment ',
    '    private static JSONObject lookupReceipt(',
    '    private static int responseCode(',
    '    private static JSONObject parseResponse(',
    '    private static String readResponse(',
    '    private static NativeReceiptValidator.Evidence applyReceipt(',
    '    private static void scheduleDeliveryRetryIfPending(',
    '    private static long followUpDelay(',
    '    private static void afterDeliveryReceipt(',
    '    private static void reportTerminalNotification(',
    '    private static JSONObject notificationData(',
    '    private static StoredIntent changePostingAuthority(',
    '    private static void assertNotDispatching(',
    '    private static String responseError(',
    '    private static void assertStoreScope(',
    '    private static void assertCurrentScope(',
    '    private static boolean markIfCurrent(',
    '    private static boolean isTerminal(',
    '    private static void checkDeadline(',
    '    private static String origin(',
    '    private static String hex(',
    '    private static final class PreparedImage ',
    '    private static final class HttpSession ',
    '    private static final class Helper ',
]


def run(output: Path, source_path: Path, mutations: bool) -> None:
    source = source_path.read_text()
    output.mkdir(parents=True, exist_ok=True)
    segments = {anchor.strip(): block(source, anchor) for anchor in ANCHORS}
    bridge_source = (ROOT / 'mobile/android/app/src/main/java/com/omppulse/app/NativeOutboxBridge.java').read_text()
    bridge_execute = block(bridge_source, '    private static Object execute(')
    segments['NativeOutboxBridge.execute'] = bridge_execute
    constant_names = ['DATABASE','DATABASE_VERSION','MAX_ROWS','MAX_BYTES','HTTP_DEADLINE_MS','MAX_RESPONSE_BYTES','VERSION_CACHE_MS','FOLLOW_UP_CAP_MS','FOLLOW_UP_GIVE_UP_MS']
    constants = []
    for name in constant_names:
        found = re.findall(r'^    private static final (?:String|int|long) ' + name + r' = .*?;$', source, re.M)
        assert len(found) == 1, name
        constants.append(found[0])
        segments['constant ' + name] = found[0]
    status_initializer = re.search(r'    private static final ExecutorService STATUS = new ThreadPoolExecutor\((.*?)\);', source, re.S)
    assert status_initializer is not None
    assert re.search(r'1,\s*1,\s*0L,\s*TimeUnit.MILLISECONDS,\s*new ArrayBlockingQueue<>\(MAX_ROWS\)', status_initializer.group(1))
    assert 'new ThreadPoolExecutor.AbortPolicy()' in status_initializer.group(1)
    segments['STATUS executor source contract'] = status_initializer.group(0)
    # These two one-line production delegators are replaced only by counting wrappers.
    for method, value in [('claimForPost', 'true'), ('rearmForVerified404', 'false')]:
        body = block(source, f'    private static StoredIntent {method}(')
        assert re.search(r'\{\s*return changePostingAuthority\(context, token, endpoint, expected, ' + value + r'\);\s*\}', body)
        segments[method + ' (counted delegator contract)'] = body
    manifest = {'source':str(source_path.relative_to(ROOT)) if source_path.is_relative_to(ROOT) else str(source_path), 'source_blob':git_blob(source_path.read_bytes()), 'validator_blob':git_blob(VALIDATOR.read_bytes()), 'extracted_blocks':{anchor:digest(segment.encode()) for anchor,segment in segments.items()}}
    (output / 'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print('SOURCE_BLOB ' + manifest['source_blob'],flush=True)
    print('VALIDATOR_BLOB ' + manifest['validator_blob'],flush=True)
    validator_classes = output / 'validator-classes'; validator_classes.mkdir(exist_ok=True)
    subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(validator_classes),str(VALIDATOR),*[str(p) for p in sorted((FIXTURES/'validator').rglob('*.java'))]],check=True,timeout=30)
    subprocess.run(['java','-cp',str(validator_classes),'com.omppulse.app.NativeReceiptValidatorTest'],check=True,timeout=30)
    fixture = (FIXTURES/'integration/NativeReceiptIntegration.java.template').read_text().replace('// EXACT_SOURCE_METHODS','\n'.join(block(source,anchor) for anchor in ANCHORS)).replace('// EXACT_SOURCE_CONSTANTS','\n'.join(constants))
    fixture = fixture.replace('// EXACT_BRIDGE_EXECUTE', bridge_execute)
    fixture_path = output / 'NativeReceiptIntegration.java'; fixture_path.write_text(fixture)
    classes = output / 'integration-classes'; classes.mkdir(exist_ok=True)
    compile_args=['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(classes),str(VALIDATOR),str(fixture_path),*[str(p) for p in sorted((FIXTURES/'integration/org').rglob('*.java'))]]
    subprocess.run(compile_args,check=True,timeout=30)
    subprocess.run(['java','-cp',str(classes),'com.omppulse.app.NativeOutbox'],check=True,timeout=30)
    sql_checks=migration_proof(source,output)
    print(f'SUMMARY {sql_checks} genuine Python sqlite3 migration/reopen checks passed',flush=True)
    if mutations:
        mutant_tests = [
            ('missing-status-coalescing','STATUS_KEYS.contains(key) || STATUS_KEYS.size() >= MAX_ROWS','STATUS_KEYS.size() >= MAX_ROWS'),
            ('unscoped-receipt-url','+ "?session=" + scopedPath','+ ""'),
            ('target-wakes-delivery','if (applied != null) reportTerminalNotification(context, expected.namespace,','wake(); if (applied != null) reportTerminalNotification(context, expected.namespace,'),
            ('receipt-revision-not-advanced','values.put("receipt_revision", current.revision + 1);','values.put("receipt_revision", current.revision);'),
            ('status-count-cap-removed','STATUS_KEYS.size() >= MAX_ROWS','false'),
            ('http-cache-enabled','connection.setUseCaches(false);','connection.setUseCaches(true);'),
            ('saved-evidence-routing-guard-removed','&& intent.receipt == null && intent.binding == null',''),
        ]
        for name,good,bad in mutant_tests:
            assert good in fixture, name
            mutant=output / ('mutation-'+name); mutant.mkdir(exist_ok=True)
            mutant_file=mutant/'NativeReceiptIntegration.java'; mutant_file.write_text(fixture.replace(good,bad))
            subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(mutant),str(VALIDATOR),str(mutant_file),*[str(p) for p in sorted((FIXTURES/'integration/org').rglob('*.java'))]],check=True,timeout=30,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            result=subprocess.run(['java','-cp',str(mutant),'com.omppulse.app.NativeOutbox'],timeout=30,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
            (mutant/'result.txt').write_text(result.stdout)
            assert result.returncode != 0 and 'AssertionError' in result.stdout, name + ' was not detected'
            print('PASS MUTATION rejected '+name,flush=True)
    print('UNRUN Android build/runtime, Android SQLite lifecycle, real org.json parsing, real executor scheduling, real HTTP/cache/deadlines, attachment fsync, daemon/archive/restart integration, device/ADB/model and aggregate repository gates',flush=True)


if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,help='Retain generated source, classes, manifests and SQLite files here')
    parser.add_argument('--source',type=Path,default=SOURCE,help='Optional source candidate for source-bound regression testing')
    parser.add_argument('--mutations',action='store_true',help='Also prove intentionally bad generated-source mutations fail')
    args=parser.parse_args()
    if args.output:
        run(args.output.resolve(),args.source.resolve(),args.mutations)
    else:
        with tempfile.TemporaryDirectory(prefix='native-receipts-') as temporary:
            run(Path(temporary),args.source.resolve(),args.mutations)
