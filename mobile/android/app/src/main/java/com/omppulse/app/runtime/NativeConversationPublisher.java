package com.omppulse.app.runtime;

import android.content.Context;
import java.io.Closeable;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import org.json.JSONException;
import org.json.JSONObject;

/** One trusted APK helper per import, performing renameat2(RENAME_NOREPLACE) outside proot. */
final class NativeConversationPublisher implements ConversationArchive.Publisher, Closeable {
    private static final int MAX_REQUEST_BYTES = 65_536;
    private static final int MAX_ERRNO = 4095;
    private static final long REQUEST_TIMEOUT_SECONDS = 30;
    private final Process process;
    private final InputStream replies;
    private final OutputStream requests;
    private final ExecutorService io;
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile int errno;

    NativeConversationPublisher(Context context) throws IOException {
        Process child = null;
        try {
            child = new ProcessBuilder(new File(context.getApplicationInfo().nativeLibraryDir,
                    "libomppulse.so").getPath(), "native-publish").start();
            // Never retain or expose diagnostics, and never let an unread stderr pipe fill.
            child.getErrorStream().close();
            replies = child.getInputStream();
            requests = child.getOutputStream();
            io = Executors.newSingleThreadExecutor(task -> {
                Thread thread = new Thread(task, "omp-conversation-publication");
                thread.setDaemon(true);
                return thread;
            });
            process = child;
        } catch (IOException | RuntimeException e) {
            if (child != null) closeProcess(child);
            throw failure();
        }
    }

    /** Last validated Linux errno, or zero when no native failure was received. */
    int errno() {
        return errno;
    }

    @Override public synchronized void publish(File staged, File destination) throws IOException {
        errno = 0;
        try {
            if (closed.get() || Thread.currentThread().isInterrupted()) throw failure();
            String json = new JSONObject().put("source", staged.getAbsolutePath())
                    .put("destination", destination.getAbsolutePath()).toString();
            if (json.length() >= MAX_REQUEST_BYTES) throw failure();
            byte[] request = (json + "\n").getBytes(StandardCharsets.UTF_8);
            if (request.length > MAX_REQUEST_BYTES) throw failure();
            // Both a blocked write and a blocked read are covered by the same deadline.
            Future<Integer> reply = io.submit(() -> exchange(request));
            int result = reply.get(REQUEST_TIMEOUT_SECONDS, TimeUnit.SECONDS);
            if (closed.get() || Thread.currentThread().isInterrupted()) throw failure();
            errno = result;
            if (result != 0) throw failure();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            close();
            throw failure();
        } catch (IOException | JSONException | ExecutionException | TimeoutException | RuntimeException e) {
            close();
            // No private paths, request, process messages, or chained causes leave this wrapper.
            throw failure();
        }
    }

    private int exchange(byte[] request) throws IOException {
        requests.write(request);
        requests.flush();
        int value = 0;
        int digits = 0;
        while (true) {
            int next = replies.read();
            if (next == '\n') {
                if (digits == 0) throw failure();
                return value;
            }
            if (next < '0' || next > '9' || ++digits > 4) throw failure();
            value = value * 10 + next - '0';
            if (value > MAX_ERRNO) throw failure();
        }
    }

    // Do not take publish's monitor: service destruction must unblock its pending pipe operation.
    @Override public void close() {
        if (!closed.compareAndSet(false, true)) return;
        process.destroy();
        io.shutdownNow();
        closeQuietly(requests);
        closeQuietly(replies);
        closeQuietly(process.getErrorStream());
    }

    private static void closeProcess(Process child) {
        child.destroy();
        closeQuietly(child.getOutputStream());
        closeQuietly(child.getInputStream());
        closeQuietly(child.getErrorStream());
    }

    private static void closeQuietly(Closeable stream) {
        try { stream.close(); } catch (IOException ignored) { }
    }

    private static IOException failure() {
        return new IOException("Conversation publication failed");
    }
}
