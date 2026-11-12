package com.omppulse.app;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.Build;
import android.os.SystemClock;
import android.system.Os;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

public final class RecoveryTest {
    static final String P="/fixture/files", ROOT=P+"/native-outbox", MARK=P+"/native-outbox-recovery.quarantine";
    static final Context context=new Context();
    static int checks;
    static String name(int i){return String.format("%08x-1111-1111-1111-111111111111.b64",i);}
    static class Directory implements NativeAttachmentRecovery.Directory {
        final List<NativeAttachmentRecovery.Entry> entries=new ArrayList<>();
        final List<String> deleted=new ArrayList<>();int index,failAt=-1;boolean stable=true,replace,deleteFail;
        Directory add(int i){entries.add(new NativeAttachmentRecovery.Entry(name(i),true,i));return this;}
        @Override public String absolutePath(){return ROOT;}
        @Override public NativeAttachmentRecovery.Entry next()throws IOException {if(index==failAt)throw new IOException("enumeration failed");return index<entries.size()?entries.get(index++):null;}
        @Override public boolean unchanged(){return stable;}
        @Override public boolean deleteIfSame(NativeAttachmentRecovery.Entry e)throws IOException {if(deleteFail)throw new IOException("unlink failed");if(replace)return false;deleted.add(e.name);return true;}
        @Override public void close(){}
    }
    static void check(boolean value,String label){checks++;if(!value)throw new AssertionError(label);}
    static void reset()throws Exception {
        Os.nodes.clear();Os.nodes.put(P,100);Os.events.clear();Os.handles.clear();Os.fail="";Os.openedMode=100;Os.openedDev=1;Os.openedIno=2;
        SystemClock.now=0;SystemClock.step=0;Build.VERSION.SDK_INT=26;Thread.queued.clear();Thread.reject=false;
        NativeAttachmentRecovery.OWNERSHIP.held=false;NativeAttachmentRecovery.OWNERSHIP.busy=false;
        java.lang.reflect.Field f=NativeAttachmentRecovery.class.getDeclaredField("ATTEMPTED");f.setAccessible(true);((AtomicBoolean)f.get(null)).set(false);
    }
    static void recover(SQLiteDatabase db,Directory d)throws Exception {NativeAttachmentRecovery.recover(context,db,d);}
    static void expectFailure(SQLiteDatabase db,Directory d)throws Exception {
        boolean failed=false;try{recover(db,d);}catch(Exception expected){failed=true;}check(failed&&d.deleted.isEmpty(),"fault before mutation");
    }
    static final class Attributes implements java.nio.file.attribute.BasicFileAttributes {
        final Object key;final boolean dir,link;
        Attributes(Object key,boolean dir,boolean link){this.key=key;this.dir=dir;this.link=link;}
        @Override public java.nio.file.attribute.FileTime lastModifiedTime(){return java.nio.file.attribute.FileTime.fromMillis(0);}
        @Override public java.nio.file.attribute.FileTime lastAccessTime(){return lastModifiedTime();}
        @Override public java.nio.file.attribute.FileTime creationTime(){return lastModifiedTime();}
        @Override public boolean isRegularFile(){return !dir&&!link;}
        @Override public boolean isDirectory(){return dir;}
        @Override public boolean isSymbolicLink(){return link;}
        @Override public boolean isOther(){return false;}
        @Override public long size(){return 1;}
        @Override public Object fileKey(){return key;}
    }
    static final class Secure implements java.nio.file.SecureDirectoryStream<java.nio.file.Path> {
        Secure child;Object rootKey="root",fileKey="file";boolean parent,closed,iteratorFail,symlink;int unlinks;
        @Override public java.util.Iterator<java.nio.file.Path> iterator(){if(iteratorFail)throw new IllegalStateException("iterator");return List.of(java.nio.file.Paths.get(name(1))).iterator();}
        @Override public void close(){closed=true;}
        @Override public java.nio.file.SecureDirectoryStream<java.nio.file.Path> newDirectoryStream(java.nio.file.Path p,java.nio.file.LinkOption... options){check(java.util.Arrays.asList(options).contains(java.nio.file.LinkOption.NOFOLLOW_LINKS),"root open nofollow");return child;}
        @Override public java.nio.channels.SeekableByteChannel newByteChannel(java.nio.file.Path p,java.util.Set<? extends java.nio.file.OpenOption> o,java.nio.file.attribute.FileAttribute<?>... attrs){throw new UnsupportedOperationException();}
        @Override public void deleteFile(java.nio.file.Path p){check(p.getNameCount()==1&&!p.isAbsolute(),"anchored filename-only unlink");unlinks++;}
        @Override public void deleteDirectory(java.nio.file.Path p){throw new AssertionError("recursive deletion");}
        @Override public void move(java.nio.file.Path p,java.nio.file.SecureDirectoryStream<java.nio.file.Path> other,java.nio.file.Path target){throw new UnsupportedOperationException();}
        private <V extends java.nio.file.attribute.FileAttributeView> V view(Class<V> type,boolean directory){
            java.nio.file.attribute.BasicFileAttributeView v=new java.nio.file.attribute.BasicFileAttributeView(){
                @Override public String name(){return "basic";}
                @Override public java.nio.file.attribute.BasicFileAttributes readAttributes(){return new Attributes(directory?rootKey:fileKey,directory,symlink);}
                @Override public void setTimes(java.nio.file.attribute.FileTime a,java.nio.file.attribute.FileTime b,java.nio.file.attribute.FileTime c){throw new UnsupportedOperationException();}
            };return type.cast(v);
        }
        @Override public <V extends java.nio.file.attribute.FileAttributeView> V getFileAttributeView(Class<V> type){return view(type,true);}
        @Override public <V extends java.nio.file.attribute.FileAttributeView> V getFileAttributeView(java.nio.file.Path p,Class<V> type,java.nio.file.LinkOption... options){check(java.util.Arrays.asList(options).contains(java.nio.file.LinkOption.NOFOLLOW_LINKS),"attributes nofollow");return view(type,parent);}
    }
    static NativeAttachmentRecovery.Directory adapter(Secure parent)throws Exception {
        Class<?> c=Class.forName("com.omppulse.app.NativeAttachmentRecovery$Api26$SecureDirectory");
        java.lang.reflect.Constructor<?> constructor=c.getDeclaredConstructors()[0];constructor.setAccessible(true);
        return (NativeAttachmentRecovery.Directory)constructor.newInstance(parent,java.nio.file.Paths.get("native-outbox"),ROOT,"root");
    }
    static Secure secure(){Secure p=new Secure();p.parent=true;p.child=new Secure();return p;}
    static void adapterTests()throws Exception {
        Secure p=secure();try(NativeAttachmentRecovery.Directory d=adapter(p)){
            NativeAttachmentRecovery.Entry e=d.next();check(e.regular&&d.unchanged(),"secure adapter healthy identity");check(d.deleteIfSame(e)&&p.child.unlinks==1,"secure adapter deletes owned leaf");
        }check(p.child.closed,"child handle closes");
        p=secure();p.child.rootKey="replacement";boolean failed=false;try{adapter(p);}catch(java.lang.reflect.InvocationTargetException expected){failed=expected.getCause() instanceof IOException;}
        check(failed&&p.child.closed,"root replacement during open rejected and child closed");
        p=secure();p.child.iteratorFail=true;failed=false;try{adapter(p);}catch(java.lang.reflect.InvocationTargetException expected){failed=true;}
        check(failed&&p.child.closed,"iterator acquisition failure closes opened child");
        p=secure();try(NativeAttachmentRecovery.Directory d=adapter(p)){p.child.rootKey="replacement";check(!d.unchanged(),"opened root identity change detected");}
        p=secure();try(NativeAttachmentRecovery.Directory d=adapter(p)){p.rootKey="replacement";check(!d.unchanged(),"parent root identity change detected");}
        p=secure();try(NativeAttachmentRecovery.Directory d=adapter(p)){NativeAttachmentRecovery.Entry e=d.next();p.child.fileKey="replacement";check(!d.deleteIfSame(e)&&p.child.unlinks==0,"replacement leaf preserved");}
        p=secure();try(NativeAttachmentRecovery.Directory d=adapter(p)){NativeAttachmentRecovery.Entry e=d.next();p.child.symlink=true;check(!d.deleteIfSame(e)&&p.child.unlinks==0,"symlink replacement preserved");}
    }
    public static void main(String[] args)throws Exception {
        reset();SQLiteDatabase db=new SQLiteDatabase();Directory d=new Directory().add(1).add(2);
        db.refs.add(ROOT+"/"+name(1));recover(db,d);check(d.deleted.equals(List.of(name(2))),"only true orphan deleted");
        reset();db=new SQLiteDatabase();d=new Directory();
        for(int i=0;i<8;i++){d.add(i);db.refs.add(ROOT+"/"+name(i));}recover(db,d);
        check(d.deleted.isEmpty()&&db.queries==1,"global attachments snapshot protects every row without command JOIN");
        for(String bad:new String[]{null,"",ROOT+"/../"+name(1),"/other/"+name(1),ROOT+"/foreign.txt"}){
            reset();db=new SQLiteDatabase();db.refs.add(bad);d=new Directory().add(2);recover(db,d);check(d.deleted.isEmpty(),"malformed/aliased ref invalidates all deletion");
        }
        reset();db=new SQLiteDatabase();db.failQuery=true;d=new Directory().add(1);expectFailure(db,d);
        reset();db=new SQLiteDatabase();db.refs.add(ROOT+"/"+name(1));db.failAfter=1;d=new Directory().add(2);expectFailure(db,d);
        reset();db=new SQLiteDatabase();d=new Directory().add(1).add(2);d.failAt=1;expectFailure(db,d);
        reset();db=new SQLiteDatabase();d=new Directory().add(1);d.stable=false;recover(db,d);check(d.deleted.isEmpty(),"root change preserves all files");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);d.replace=true;recover(db,d);check(d.deleted.isEmpty(),"changed child identity preserved");
        reset();db=new SQLiteDatabase();d=new Directory();
        d.entries.add(new NativeAttachmentRecovery.Entry(name(1),false,1));
        d.entries.add(new NativeAttachmentRecovery.Entry("foreign.txt",true,2));
        d.entries.add(new NativeAttachmentRecovery.Entry("subdirectory",false,3));recover(db,d);
        check(d.deleted.isEmpty(),"symlinks/directories/unrelated names preserved");
        reset();db=new SQLiteDatabase();d=new Directory();d.entries.add(new NativeAttachmentRecovery.Entry(name(1),true,null));recover(db,d);check(d.deleted.isEmpty(),"unknown identity fails closed");
        reset();db=new SQLiteDatabase();for(int i=0;i<4097;i++)db.refs.add(ROOT+"/"+name(1));d=new Directory().add(2);recover(db,d);check(d.deleted.isEmpty(),"reference cap skips entire sweep");
        reset();db=new SQLiteDatabase();d=new Directory();for(int i=0;i<4097;i++)d.add(i);recover(db,d);check(d.deleted.isEmpty(),"directory cap skips entire sweep");
        reset();db=new SQLiteDatabase();d=new Directory();for(int i=0;i<300;i++)d.add(i);recover(db,d);check(d.deleted.size()==256,"deletion cap retains remainder");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);SystemClock.step=251;recover(db,d);check(d.deleted.isEmpty(),"elapsed prevalidation cap skips all");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);Os.nodes.put(MARK,300);recover(db,d);check(d.deleted.isEmpty(),"marker symlink quarantines without reading/following");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);Os.nodes.put(P,300);recover(db,d);check(d.deleted.isEmpty(),"non-directory private root fails closed");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);db.open=false;recover(db,d);check(d.deleted.isEmpty(),"closed database invalidates authority");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);db.transaction=true;recover(db,d);check(d.deleted.isEmpty(),"active transaction invalidates authority");
        reset();db=new SQLiteDatabase();d=new Directory().add(1);d.deleteFail=true;expectFailure(db,d);
        reset();db=new SQLiteDatabase();SchemaFixture.create(context,db);check(db.sql==4&&!Os.nodes.containsKey(MARK),"fresh install creates original schema without quarantine");
        reset();Build.VERSION.SDK_INT=22;Os.nodes.put(ROOT,100);db=new SQLiteDatabase();SchemaFixture.create(context,db);
        check(db.sql==4&&Os.nodes.containsKey(MARK),"API22 recreation records quarantine");
        int markSync=Os.events.indexOf("sync:"+MARK),dirSync=Os.events.indexOf("sync:"+P),sql=Os.events.indexOf("schema");
        check(markSync>=0&&markSync<dirSync&&dirSync<sql,"marker and directory sync precede first CREATE");
        Build.VERSION.SDK_INT=26;d=new Directory().add(1);recover(new SQLiteDatabase(),d);check(d.deleted.isEmpty(),"later API26 process preserves quarantine");
        d=new Directory().add(1);recover(new SQLiteDatabase(),d);check(d.deleted.isEmpty(),"second later restart still quarantined");
        for(String mismatch:new String[]{"type","device","inode","fstat"}) {
            reset();Os.nodes.put(ROOT,100);db=new SQLiteDatabase();
            if(mismatch.equals("type"))Os.openedMode=200;
            if(mismatch.equals("device"))Os.openedDev=99;
            if(mismatch.equals("inode"))Os.openedIno=99;
            if(mismatch.equals("fstat"))Os.fail="fstat";
            boolean failed=false;
            try{SchemaFixture.create(context,db);}catch(android.database.sqlite.SQLiteException expected){failed=true;}
            check(failed&&db.sql==0&&Os.handles.isEmpty()&&!Os.events.contains("sync:"+P),"opened parent validation fails before fsync/CREATE and closes handle: "+mismatch);
        }
        reset();Os.nodes.put(ROOT,100);db=new SQLiteDatabase();SchemaFixture.create(context,db);
        check(Os.events.indexOf("fstat:"+P)<Os.events.indexOf("sync:"+P)&&Os.events.indexOf("sync:"+P)<Os.events.indexOf("schema"),"opened directory identity checked before durable publication and CREATE");
        for(String fault:new String[]{"stat","open","sync","dirsync"}){
            reset();Os.nodes.put(ROOT,100);Os.fail=fault;db=new SQLiteDatabase();boolean failed=false;
            try{SchemaFixture.create(context,db);}catch(android.database.sqlite.SQLiteException expected){failed=true;}
            check(failed&&db.sql==0&&Os.handles.isEmpty(),"publication failure blocks CREATE and closes handles: "+fault);
            Os.fail="";SchemaFixture.create(context,db);check(db.sql==4&&Os.nodes.containsKey(MARK),"retry safely publishes or retains quarantine");
        }
        reset();Os.nodes.put(ROOT,100);Os.nodes.put(MARK,300);db=new SQLiteDatabase();SchemaFixture.create(context,db);
        check(db.sql==4&&!Os.events.contains("open:"+MARK),"existing marker any type is never followed/opened");
        reset();Build.VERSION.SDK_INT=22;SQLiteOpenHelper h=new SQLiteOpenHelper();NativeAttachmentRecovery.schedule(context,h);check(Thread.queued.isEmpty(),"API22 skips NIO worker");
        reset();Os.nodes.put(MARK,200);h=new SQLiteOpenHelper();NativeAttachmentRecovery.schedule(context,h);NativeAttachmentRecovery.schedule(context,h);
        check(Thread.queued.size()==1,"only one queued attempt");Thread.queued.remove(0).run();
        check(Os.events.indexOf("open-db")<Os.events.indexOf("try-lock")&&!NativeAttachmentRecovery.OWNERSHIP.held,"database opens before ownership and unlocks on quarantine");
        NativeAttachmentRecovery.schedule(context,h);check(Thread.queued.isEmpty(),"skipped attempt never loops");
        reset();Thread.reject=true;h=new SQLiteOpenHelper();NativeAttachmentRecovery.schedule(context,h);Thread.reject=false;NativeAttachmentRecovery.schedule(context,h);check(Thread.queued.isEmpty(),"worker rejection is one bounded attempt");
        reset();h=new SQLiteOpenHelper();h.fail=true;NativeAttachmentRecovery.schedule(context,h);Thread.queued.remove(0).run();check(!Os.events.contains("try-lock"),"open failure never takes ownership");
        reset();h=new SQLiteOpenHelper();h.db.transaction=true;NativeAttachmentRecovery.schedule(context,h);Thread.queued.remove(0).run();check(!Os.events.contains("try-lock"),"transaction entry never takes ownership");
        reset();h=new SQLiteOpenHelper();NativeAttachmentRecovery.OWNERSHIP.busy=true;NativeAttachmentRecovery.schedule(context,h);Thread.queued.remove(0).run();
        check(!NativeAttachmentRecovery.OWNERSHIP.held&&h.db.queries==0,"active staging owner prevents recovery read/deletion");
        check(Os.handles.isEmpty(),"all synthetic OS handles closed");
        adapterTests();
        System.out.println("PASS: "+checks+" exact-source recovery/quarantine/scheduling/secure-adapter assertions; platform boundaries synthetic");
    }
}
