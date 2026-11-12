#!/usr/bin/env python3
"""Compile exact recovery source against deterministic Android/filesystem/scheduling fakes."""
import argparse,pathlib,subprocess,json,hashlib,tempfile,sys
ROOT=pathlib.Path(__file__).resolve().parents[4]
FIXTURES=pathlib.Path(__file__).resolve().parent
SRC=ROOT/'mobile/android/app/src/main/java/com/omppulse/app'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output',type=pathlib.Path)
parser.add_argument('--mutations',action='store_true')
args=parser.parse_args()
temporary=tempfile.TemporaryDirectory(prefix='native-attachment-tests-') if args.output is None else None
REPORT=args.output if args.output is not None else pathlib.Path(temporary.name)
REPORT.mkdir(parents=True,exist_ok=True)
BUILD=REPORT/'generated';BUILD.mkdir(exist_ok=True)
def write(path,text):
 p=BUILD/path;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(text)
stubs={
'android/content/Context.java':'''package android.content; public class Context { public Context getApplicationContext(){return this;} public java.io.File getFilesDir(){return new java.io.File("/fixture/files");} }''',
'android/os/Build.java':'''package android.os; public final class Build { public static final class VERSION { public static int SDK_INT=26; } }''',
'android/os/SystemClock.java':'''package android.os; public final class SystemClock { public static long now,step; public static long elapsedRealtime(){long n=now;now+=step;return n;} }''',
'android/util/Log.java':'''package android.util; public final class Log { public static int w(String t,String m,Throwable e){return 0;} }''',
'android/system/ErrnoException.java':'''package android.system; public class ErrnoException extends Exception {private static final long serialVersionUID=1;public final int errno;public ErrnoException(String op,int e){super(op);errno=e;} }''',
'android/system/StructStat.java':'''package android.system; public final class StructStat { public final int st_mode; public final long st_dev,st_ino; public StructStat(int mode){this(mode,1,2);} public StructStat(int mode,long dev,long ino){st_mode=mode;st_dev=dev;st_ino=ino;} }''',
'android/system/OsConstants.java':'''package android.system; public final class OsConstants {public static final int ENOENT=2,O_WRONLY=1,O_CREAT=2,O_EXCL=4,O_NOFOLLOW=8,O_RDONLY=16,O_NONBLOCK=32;public static boolean S_ISDIR(int m){return m==100;} }''',
'android/system/Os.java':'''package android.system;
import java.io.FileDescriptor;import java.util.*;
public final class Os {
 public static final Map<String,Integer> nodes=new HashMap<>(); public static final List<String> events=new ArrayList<>();
 public static final Map<FileDescriptor,String> handles=new HashMap<>();public static String fail="";public static int openedMode=100;public static long openedDev=1,openedIno=2;
 public static StructStat lstat(String p)throws ErrnoException {events.add("stat:"+p);if(fail.equals("stat"))throw new ErrnoException("stat",5);Integer n=nodes.get(p);if(n==null)throw new ErrnoException("stat",2);return new StructStat(n);}
 public static FileDescriptor open(String p,int flags,int mode)throws ErrnoException {events.add("open:"+p);if(fail.equals("open"))throw new ErrnoException("open",5);if((flags&OsConstants.O_NOFOLLOW)==0)throw new AssertionError("follow open");if(p.equals("/fixture/files")&&(flags&OsConstants.O_NONBLOCK)==0)throw new AssertionError("parent open must not block on replacement FIFO");if((flags&OsConstants.O_CREAT)!=0){if((flags&OsConstants.O_EXCL)==0)throw new AssertionError("not exclusive");if(nodes.containsKey(p))throw new ErrnoException("exists",17);nodes.put(p,200);} FileDescriptor fd=new FileDescriptor();handles.put(fd,p);return fd;}
 public static StructStat fstat(FileDescriptor fd)throws ErrnoException {events.add("fstat:"+handles.get(fd));if(fail.equals("fstat"))throw new ErrnoException("fstat",5);return new StructStat(openedMode,openedDev,openedIno);}
 public static void fsync(FileDescriptor fd)throws ErrnoException {String p=handles.get(fd);events.add("sync:"+p);if(fail.equals("sync")||fail.equals("dirsync")&&p.equals("/fixture/files"))throw new ErrnoException("sync",5);}
 public static void close(FileDescriptor fd)throws ErrnoException {events.add("close:"+handles.remove(fd));}
}''',
'android/database/Cursor.java':'''package android.database; public interface Cursor extends AutoCloseable {boolean moveToNext();int getColumnIndexOrThrow(String column);String getString(int c);@Override void close();}''',
'android/database/sqlite/SQLiteException.java':'''package android.database.sqlite;public class SQLiteException extends RuntimeException {private static final long serialVersionUID=1; public SQLiteException(String m,Throwable c){super(m,c);} }''',
'android/database/sqlite/SQLiteDatabase.java':'''package android.database.sqlite;
import android.database.Cursor;import java.util.*;
public class SQLiteDatabase {public final List<String> refs=new ArrayList<>();public boolean open=true,transaction,failQuery;public int failAfter=-1,queries,sql;public boolean isOpen(){return open;}public boolean inTransaction(){return transaction;}public void execSQL(String s){sql++;android.system.Os.events.add("schema");}
public Cursor query(String table,String[] cols,String where,String[] args,String group,String having,String order){queries++;if(!table.equals("attachments")||!Arrays.equals(cols,new String[]{"file_path"})||where!=null||args!=null)throw new AssertionError("not global direct refs");if(failQuery)throw new IllegalStateException("query failure");return new Cursor(){int i=-1;public boolean moveToNext(){if(failAfter==i+1)throw new IllegalStateException("cursor failure");return ++i<refs.size();}public int getColumnIndexOrThrow(String c){if(!c.equals("file_path"))throw new IllegalArgumentException(c);return 0;}public String getString(int c){return refs.get(i);}public void close(){}};}
// Only Helper.onUpgrade issues raw SQL (PRAGMA table_info); this suite runs onCreate, the receipt suite runs onUpgrade.
public Cursor rawQuery(String s,String[] args){throw new AssertionError("raw SQL outside the recovery fixture: "+s);}}
''',
'android/database/sqlite/SQLiteOpenHelper.java':'''package android.database.sqlite;import android.content.Context;public class SQLiteOpenHelper {public SQLiteDatabase db=new SQLiteDatabase();public boolean fail;public SQLiteOpenHelper(){}public SQLiteOpenHelper(Context c,String name,Object factory,int version){}public SQLiteDatabase getWritableDatabase(){android.system.Os.events.add("open-db");if(fail)throw new IllegalStateException("db open");return db;}public void onCreate(SQLiteDatabase db){}public void onUpgrade(SQLiteDatabase db,int oldVersion,int newVersion){} }''',
'fixture/ReentrantLock.java':'''package fixture; public final class ReentrantLock {public boolean held,busy; public boolean tryLock(){android.system.Os.events.add("try-lock");if(busy||held)return false;held=true;return true;}public void lock(){if(held)throw new AssertionError("recursive fixture lock");held=true;}public void unlock(){if(!held)throw new AssertionError("unlock without lease");held=false;} }''',
'com/omppulse/app/Thread.java':'''package com.omppulse.app;final class Thread {static final java.util.List<Runnable> queued=new java.util.ArrayList<>();static boolean reject;final Runnable runnable;Thread(Runnable r,String name){runnable=r;}void setDaemon(boolean d){}void start(){if(reject)throw new IllegalStateException("rejected");queued.add(runnable);} }'''
}
for p,s in stubs.items():write(p,s)
source=(SRC/'NativeAttachmentRecovery.java').read_text()
# Only replace the imported lock platform boundary, never a production method body.
compiled=source.replace('import java.util.concurrent.locks.ReentrantLock;', 'import fixture.ReentrantLock;')
write('com/omppulse/app/NativeAttachmentRecovery.java',compiled)
outbox=(SRC/'NativeOutbox.java').read_text()
start=outbox.index('    private static final class Helper extends');end=outbox.rindex('\n}')
helper=outbox[start:end]
write('com/omppulse/app/SchemaFixture.java','package com.omppulse.app; import android.content.Context;import android.database.Cursor;import android.database.sqlite.*;import java.util.HashSet;import java.util.Set;final class SchemaFixture {static final String DATABASE="fixture";static final int DATABASE_VERSION=2;'+helper+' static void create(Context c,SQLiteDatabase db){new Helper(c).onCreate(db);} }')
write('com/omppulse/app/RecoveryTest.java',(FIXTURES/'RecoveryTest.java').read_text())
files=[str(p) for p in BUILD.rglob('*.java')]
subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(BUILD),*files],check=True,timeout=30)
result=subprocess.run(['java','-cp',str(BUILD),'com.omppulse.app.RecoveryTest'],capture_output=True,text=True,check=True,timeout=15)
(REPORT/'results.txt').write_text(result.stdout);print(result.stdout,end='')
# Source-bound integration ordering checks supplement fake scheduling/ownership tests.
insert=outbox[outbox.index('    private static InsertResult insert('):outbox.index('    private static JSONObject findExisting(')]
assert insert.index('OWNERSHIP.lock()')<insert.index('persistAttachments(')<insert.index('db.beginTransaction()')<insert.index('db.endTransaction()')<insert.index('deleteFiles(stagedFiles)')<insert.index('OWNERSHIP.unlock()')
factory=outbox[outbox.index('    private static Helper database('):outbox.index('    private static final class RejectedDeliveryException')]
assert factory.index('result = helper;\n            }\n        }')<factory.index('NativeAttachmentRecovery.schedule')
assert source.index('helper.getWritableDatabase()')<source.index('OWNERSHIP.tryLock()')
manifest={'source_sha256':hashlib.sha256(source.encode()).hexdigest(),'outbox_sha256':hashlib.sha256(outbox.encode()).hexdigest(),'exact_helper_sha256':hashlib.sha256(helper.encode()).hexdigest(),'boundaries':'Android context/SQL/Os/time/thread and imported lock are deterministic fakes. Core recovery and Helper.onCreate execute unchanged; Helper.onUpgrade is compiled here and executed by the receipt suite. SecureDirectory adapter methods execute against synthetic SecureDirectoryStream handles; Api26.recover provider-opening entry is compiled, not executed. Factory order is source-asserted. Exact complete insertion executes in the separate receipt suite and staging-ownership mutant.'}
(REPORT/'source-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print('PASS: source-bound staging lock, helper publication, database-first ordering assertions')
if args.mutations:
 mutations={
  'remove-global-reference-protection':('&& !referenced.contains(prefix + entry.name)',''),
  'remove-ownership-admission':('if (db.inTransaction() || !OWNERSHIP.tryLock()) return;','if (db.inTransaction()) return;'),
  'ignore-quarantine':('&& lstat(new File(parent, QUARANTINE)) == null',''),
  'scope-reference-query':('null, null, null, null, null)) {','"namespace=?", new String[]{"current"}, null, null, null)) {'),
  'omit-directory-sync':('                Os.fsync(directory);',''),
  'omit-directory-type-check':('!OsConstants.S_ISDIR(opened.st_mode) || ',''),
  'omit-directory-device-check':('opened.st_dev != parentStat.st_dev\n                        || ',''),
  'omit-directory-inode-check':('\n                        || opened.st_ino != parentStat.st_ino',''),
  'omit-nonblocking-open':(' | OsConstants.O_NONBLOCK',''),
  'ignore-opened-root-identity':('if (!opened.isDirectory() || opened.isSymbolicLink() || !identity.equals(opened.fileKey()))','if (!opened.isDirectory() || opened.isSymbolicLink())'),
 }
 results={}
 for name,(old,new) in mutations.items():
  assert compiled.count(old)==1,(name,compiled.count(old))
  write('com/omppulse/app/NativeAttachmentRecovery.java',compiled.replace(old,new))
  subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(BUILD),*files],check=True,capture_output=True,timeout=30)
  result=subprocess.run(['java','-cp',str(BUILD),'com.omppulse.app.RecoveryTest'],capture_output=True,text=True,timeout=15)
  assert result.returncode!=0 and 'AssertionError' in result.stderr,(name,result.stdout,result.stderr)
  results[name]={'killed':True,'failure':result.stderr.splitlines()[0]}
 # Separate API-surface negative control: unsupported constants must fail compilation.
 write('com/omppulse/app/NativeAttachmentRecovery.java',compiled.replace('OsConstants.O_NONBLOCK','OsConstants.O_DIRECTORY'))
 rejected=subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(BUILD),*files],capture_output=True,text=True,timeout=30)
 assert rejected.returncode!=0 and 'O_DIRECTORY' in rejected.stderr and 'cannot find symbol' in rejected.stderr,rejected.stderr
 results['unsupported-directory-constant']={'kind':'negative API-surface compile control','rejected':True}
 write('com/omppulse/app/NativeAttachmentRecovery.java',compiled)
 subprocess.run(['java','com.sun.tools.javac.Main','-Xlint:all','-Werror','-d',str(BUILD),*files],check=True,timeout=30)
 subprocess.run(['java','-cp',str(BUILD),'com.omppulse.app.RecoveryTest'],check=True,capture_output=True,timeout=15)
 # Exercise the exact full insertion through the existing receipt harness, not a lock-state model.
 staging=REPORT/'NativeOutbox-no-staging-lock.java'
 staging.write_text(outbox.replace('NativeAttachmentRecovery.OWNERSHIP.lock();','').replace('NativeAttachmentRecovery.OWNERSHIP.unlock();',''))
 result=subprocess.run([sys.executable,str(ROOT/'mobile/android/host-tests/native-receipts/run.py'),'--source',str(staging),'--output',str(REPORT/'staging-lock-mutation')],capture_output=True,text=True,timeout=30)
 assert result.returncode!=0 and 'unprotected in-progress attachment staging' in result.stdout+result.stderr,(result.stdout,result.stderr)
 results['remove-staging-ownership']={'killed':True,'failure':'exact insert reached attachment staging without exclusive ownership'}
 (REPORT/'mutations.json').write_text(json.dumps(results,indent=2)+'\n')
 print('PASS: eleven behavioral mutations rejected and unsupported API compile control rejected; original source restored and rechecked')
