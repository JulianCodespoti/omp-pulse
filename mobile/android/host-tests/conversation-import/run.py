#!/usr/bin/env python3
"""Compile the real Java importer and exercise disposable JDK-signed JAR transfers."""
import hashlib
import pathlib
import subprocess
import tempfile
import warnings
import zipfile

ROOT = pathlib.Path(__file__).resolve().parents[4]
HERE = pathlib.Path(__file__).resolve().parent
SOURCE = ROOT / 'mobile/android/app/src/main/java/com/omppulse/app/runtime'
PACKAGE = 'com.omppulse.app.next'
# Public, disposable fixture credentials; never reads Gradle or app signing state.
PASSWORD = 'disposable-host-test-only'
DATA = {
    'sessions/project/chat.jsonl': b'{"type":"session","cwd":"/root/projects/fixture"}\n'
                                    b'{"type":"message","text":"fixture \\u2603"}\n',
    'sessions/project/chat/subagents/worker/tool.bin': bytes(range(256)) + b'\x00\xff\r\n',
    'blobs/fixture.png': b'\x89PNG\r\n\x1a\n\x00host-fixture\xff',
}


def invoke(args):
    subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)


def metadata(data, **changes):
    properties = {
        'format': 'omp-conversations-v1',
        'targetPackage': PACKAGE,
        'requestId': '11111111-2222-4333-8444-555555555555',
        'callbackUrl': 'http://127.0.0.1:19765/result',
        'callbackToken': '0123456789abcdef' * 4,
        'fileCount': str(len(data)),
        'conversationCount': str(sum(name.startswith('sessions/') and name.endswith('.jsonl')
                                     and len(name.split('/')) == 3 for name in data)),
        'snapshotTime': '2026-10-28T12:34:56Z',
        'cwdCount': '1',
        'cwd.0': '/root/projects/fixture',
    }
    properties.update(changes)
    return ''.join(f'{key}={value}\n' for key, value in properties.items()).encode('utf-8')


def archive(path, data, properties, manifest=b'Manifest-Version: 1.0\r\n\r\n'):
    with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        jar.writestr('META-INF/MANIFEST.MF', manifest)
        jar.writestr('transfer.properties', properties)
        for name, content in data.items():
            jar.writestr(name, content)


def sign(path, keystore):
    invoke(['jarsigner', '-keystore', str(keystore), '-storepass', PASSWORD,
            '-keypass', PASSWORD, '-sigalg', 'SHA256withRSA', '-digestalg', 'SHA-256',
            str(path), 'fixture'])


def rewrite(source, target, name, replacement):
    with zipfile.ZipFile(source) as old, zipfile.ZipFile(target, 'w') as new:
        for entry in old.infolist():
            new.writestr(entry, replacement if entry.filename == name else old.read(entry))


def fixtures(directory):
    keystore = directory / 'disposable-test.p12'
    invoke(['keytool', '-genkeypair', '-keystore', str(keystore), '-storetype', 'PKCS12',
            '-storepass', PASSWORD, '-keypass', PASSWORD, '-alias', 'fixture', '-keyalg', 'RSA',
            '-keysize', '2048', '-validity', '2', '-dname', 'CN=Disposable Import Host Test', '-noprompt'])
    invoke(['keytool', '-exportcert', '-keystore', str(keystore), '-storepass', PASSWORD,
            '-alias', 'fixture', '-file', str(directory / 'fixture.der')])
    (directory / 'trusted.sha256').write_text(hashlib.sha256((directory / 'fixture.der').read_bytes()).hexdigest())
    expected = directory / 'expected'
    for name, content in DATA.items():
        destination = expected / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)

    def signed(name, data=DATA, properties=None, manifest=b'Manifest-Version: 1.0\r\n\r\n'):
        path = directory / (name + '.jar')
        archive(path, data, metadata(data) if properties is None else properties, manifest)
        sign(path, keystore)
        return path

    valid = signed('valid')
    archive(directory / 'unsigned.jar', DATA, metadata(DATA))
    rewrite(valid, directory / 'tampered.jar', 'blobs/fixture.png', b'not signed content')
    rewrite(valid, directory / 'metadata-tampered.jar', 'transfer.properties',
            metadata(DATA, callbackToken='f' * 64))
    signed('wrong-target', properties=metadata(DATA, targetPackage='com.example.other'))
    signed('wrong-format', properties=metadata(DATA, format='unsupported'))
    signed('count-mismatch', properties=metadata(DATA, fileCount='4'))
    signed('conversation-mismatch', properties=metadata(DATA, conversationCount='0'))
    signed('duplicate-property', properties=metadata(DATA) + b'fileCount=3\n')
    signed('invalid-utf8', properties=metadata(DATA) + b'unknown=\xff\n')
    signed('unknown-property', properties=metadata(DATA, unexpected='no'))
    signed('oversized-metadata', properties=metadata(DATA) + b'#' + b'x' * 65536)
    def sections(count, attributes=1):
        return b'Manifest-Version: 1.0\r\n\r\n' + b''.join(
            f'Name: unused/{number}\r\n'.encode()
            + b''.join(f'X-{attribute}: fixture\r\n'.encode() for attribute in range(attributes))
            + b'\r\n' for number in range(count))

    signed('many-manifest-sections', manifest=sections(10001))
    signed('many-sf-sections', manifest=sections(6000))
    signed('many-manifest-attributes', manifest=sections(1400, 30))
    signed('many-section-attributes', manifest=b'Manifest-Version: 1.0\r\n'
           + b''.join(f'X-{number}: fixture\r\n'.encode() for number in range(33)) + b'\r\n')
    signed('long-folded-field', manifest=b'Manifest-Version: 1.0\r\nX-Long: value\r\n'
           + b' ' + b'\r\n '.join([b'x' * 70] * 120) + b'\r\n\r\n')
    signed('bad-cwd', properties=metadata(DATA, **{'cwd.0': '/root/../outside'}))
    signed('bad-callback', properties=metadata(DATA, callbackUrl='http://example.invalid/result'))
    signed('bad-token', properties=metadata(DATA, callbackToken='short'))
    signed('bad-date', properties=metadata(DATA, snapshotTime='2026-02-30T12:34:56Z'))
    signed('bad-count', properties=metadata(DATA, fileCount='-1'))
    signed('too-many-count', properties=metadata(DATA, fileCount='100001'))
    for name, path in {
        'traversal': 'sessions/../../escape',
        'absolute': '/sessions/project/chat.jsonl',
        'empty-component': 'sessions//chat.jsonl',
        'backslash': 'sessions/project\\escape',
        'owner': 'sessions/project/.owner',
        'owner-suffix': 'sessions/project/chat.jsonl.owner',
        'owner-uppercase': 'sessions/project/chat.OWNER',
        'bare-lock': 'sessions/project/lock',
        'lock': 'sessions/project/chat.lock',
        'outside': 'credentials/secret',
    }.items():
        signed(name, {path: b'fixture'})
    signed('prefix-collision', {'sessions/project': b'fixture', 'sessions/project/chat.jsonl': b'fixture'})
    # A correctly signed archive with data before transfer.properties still fails ordering.
    late = directory / 'metadata-late.jar'
    with zipfile.ZipFile(late, 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        jar.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\r\n\r\n')
        for name, content in DATA.items():
            jar.writestr(name, content)
        jar.writestr('transfer.properties', metadata(DATA))
    sign(late, keystore)
    for name, entry, content in (
            ('unsigned-extra', 'blobs/unsigned.bin', b'unsigned fixture'),
            ('duplicate-entry', 'blobs/fixture.png', DATA['blobs/fixture.png'])):
        target = directory / (name + '.jar')
        target.write_bytes(valid.read_bytes())
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(target, 'a') as jar:
                jar.writestr(entry, content)
    # Constructor manifest limits are exercised without asking jarsigner to parse a bomb.
    with zipfile.ZipFile(directory / 'oversized-manifest.jar', 'w', compression=zipfile.ZIP_DEFLATED) as jar:
        jar.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\r\nX: ' + b'x' * (4 * 1024 * 1024))
    for extension in ('sF', 'RSA', 'DSA', 'EC'):
        with zipfile.ZipFile(directory / f'oversized-{extension.lower()}.jar', 'w',
                             compression=zipfile.ZIP_DEFLATED) as jar:
            jar.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\r\n\r\n')
            limit = 4 * 1024 * 1024 if extension.lower() == 'sf' else 256 * 1024
            jar.writestr(f'META-INF/FIXTURE.{extension}', b'x' * (limit + 1))
            jar.writestr('transfer.properties', metadata(DATA))
    with zipfile.ZipFile(directory / 'oversized-signature-total.jar', 'w',
                         compression=zipfile.ZIP_DEFLATED) as jar:
        jar.writestr('META-INF/MANIFEST.MF', b'Manifest-Version: 1.0\r\n\r\n')
        for number in range(5):
            jar.writestr(f'META-INF/FIXTURE{number}.RSA', b'x' * (256 * 1024))
        jar.writestr('transfer.properties', metadata(DATA))


def main():
    with tempfile.TemporaryDirectory(prefix='conversation-import-') as temporary:
        directory = pathlib.Path(temporary)
        fixtures(directory)
        classes = directory / 'classes'
        classes.mkdir()
        subprocess.run(['java', 'com.sun.tools.javac.Main', '-Xlint:all', '-Werror', '-d', str(classes),
                        str(SOURCE / 'ConversationArchive.java'), str(HERE / 'ConversationArchiveTest.java')],
                       check=True, timeout=60)
        subprocess.run(['java', '-cp', str(classes), 'com.omppulse.app.runtime.ConversationArchiveTest',
                        str(directory)], check=True, timeout=120)


if __name__ == '__main__':
    main()
