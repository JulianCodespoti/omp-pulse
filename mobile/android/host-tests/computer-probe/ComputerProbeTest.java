package com.omppulse.app.bridge;

import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;

/** Real loopback HTTP proof of the transport, and deterministic proofs of the sweep policy. */
public final class ComputerProbeTest {
    private static int assertions;

    private static void check(boolean condition, String message) {
        assertions++;
        if (!condition) throw new AssertionError(message);
    }

    private static void await(String what, BooleanSupplier condition) throws Exception {
        long deadline = System.nanoTime() + 10_000_000_000L;
        while (!condition.getAsBoolean()) {
            if (System.nanoTime() > deadline) throw new AssertionError("timed out waiting for " + what);
            Thread.sleep(2);
        }
    }

    private static int workerCount() {
        int count = 0;
        for (Thread thread : Thread.getAllStackTraces().keySet()) {
            if (thread.isAlive() && "computer-probe".equals(thread.getName())) count++;
        }
        return count;
    }

    private static boolean workersAlive() {
        return workerCount() > 0;
    }

    // --- transport over a real loopback server ---------------------------------------------

    private static final List<String> requests = Collections.synchronizedList(new ArrayList<>());
    private static final List<String> sensitiveHeaders = Collections.synchronizedList(new ArrayList<>());

    private static void reply(HttpExchange exchange, int code) throws IOException {
        Headers headers = exchange.getRequestHeaders();
        requests.add(exchange.getRequestMethod() + " " + exchange.getRequestURI().getPath());
        for (String name : new String[] {"Authorization", "Cookie", "Proxy-Authorization"}) {
            if (headers.containsKey(name)) sensitiveHeaders.add(name);
        }
        exchange.sendResponseHeaders(code, -1);
        exchange.close();
    }

    private static void transport() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(Executors.newCachedThreadPool(runnable -> {
            Thread thread = new Thread(runnable, "fixture-server");
            thread.setDaemon(true);
            return thread;
        }));
        server.createContext("/online/app/", exchange -> reply(exchange, 200));
        server.createContext("/proxy/app/", exchange -> reply(exchange, 502));
        server.createContext("/missing/app/", exchange -> reply(exchange, 404));
        server.createContext("/moved/app/", exchange -> {
            exchange.getResponseHeaders().add("Location", "/online/app/");
            reply(exchange, 302);
        });
        server.createContext("/slow/app/", exchange -> {
            try {
                Thread.sleep(ComputerProbe.READ_TIMEOUT_MS + 2000L);
                reply(exchange, 200);
            } catch (InterruptedException | IOException ignored) {
                // The client gave up first, which is the point.
            }
        });
        server.start();
        try {
            String base = "http://127.0.0.1:" + server.getAddress().getPort();
            check(ComputerProbe.fetchOnline(base + "/online/app/"), "a 200 answer is online");
            check(requests.equals(List.of("GET /online/app/")), "one plain GET of the saved address");

            check(!ComputerProbe.fetchOnline(base + "/proxy/app/"), "a reverse proxy's 502 is offline, not online");
            check(!ComputerProbe.fetchOnline(base + "/missing/app/"), "a 404 is offline");

            requests.clear();
            check(!ComputerProbe.fetchOnline(base + "/moved/app/"), "a redirect is offline");
            check(requests.equals(List.of("GET /moved/app/")), "a redirect is never followed off the saved address");

            check(sensitiveHeaders.isEmpty(), "no Authorization or Cookie header ever leaves with a check: " + sensitiveHeaders);

            int closed;
            try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
                closed = socket.getLocalPort();
            }
            check(!ComputerProbe.fetchOnline("http://127.0.0.1:" + closed + "/app/"), "a refused connection is offline");

            long started = System.nanoTime();
            check(!ComputerProbe.fetchOnline(base + "/slow/app/"), "a silent server is offline");
            long elapsedMs = (System.nanoTime() - started) / 1_000_000;
            check(elapsedMs >= ComputerProbe.READ_TIMEOUT_MS - 200 && elapsedMs < ComputerProbe.READ_TIMEOUT_MS + 1500,
                    "the check gives up at the read deadline, took " + elapsedMs + " ms");
        } finally {
            server.stop(0);
        }
    }

    // --- sweep policy ------------------------------------------------------------------------

    /** A transport whose answers and timing the test controls. */
    private static final class Fake implements ComputerProbe.Transport {
        final Map<String, Boolean> answers = new ConcurrentHashMap<>();
        final List<String> calls = Collections.synchronizedList(new ArrayList<>());
        final AtomicInteger inFlight = new AtomicInteger();
        final AtomicInteger maxInFlight = new AtomicInteger();
        volatile CountDownLatch gate = new CountDownLatch(0);
        volatile boolean failing;

        @Override
        public boolean online(String url) {
            calls.add(url);
            int now = inFlight.incrementAndGet();
            maxInFlight.accumulateAndGet(now, Math::max);
            try {
                gate.await();
            } catch (InterruptedException e) {
                throw new AssertionError(e);
            } finally {
                inFlight.decrementAndGet();
            }
            if (failing) throw new IllegalStateException("synthetic transport failure");
            return answers.getOrDefault(url, true);
        }

        void hold() { gate = new CountDownLatch(1); }

        void release() { gate.countDown(); }
    }

    private static final String A = "https://a.example.ts.net/app/";
    private static final String B = "https://b.example.ts.net/app/";
    private static final String UNSAFE = "http://203.0.113.9/app/";

    private static ComputerProbe probe(Fake fake, AtomicLong clock) {
        return new ComputerProbe(fake, url -> url.startsWith("https://"), clock::get, ComputerProbe.SWEEP_GAP_MS);
    }

    private static void untrustedAddressesAreNeverContacted() throws Exception {
        Fake fake = new Fake();
        fake.hold();
        ComputerProbe probe = probe(fake, new AtomicLong());
        Map<String, String> first = probe.refresh(List.of(A, UNSAFE));
        check(first.get(A).equals("checking") && first.get(UNSAFE).equals("offline"),
                "a trusted address is checking, an unsafe one offline at once");
        fake.release();
        await("answer", () -> probe.refresh(List.of(A, UNSAFE)).get(A).equals("online"));
        check(!fake.calls.contains(UNSAFE) && fake.calls.contains(A), "only the trusted address reached the transport");
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    private static void sweepsAreSingleFlightPacedAndKeepAnswersUntilReplaced() throws Exception {
        Fake fake = new Fake();
        AtomicLong clock = new AtomicLong(1_000);
        ComputerProbe probe = probe(fake, clock);
        fake.hold();
        List<String> urls = List.of(A, B);
        check(probe.refresh(urls).values().stream().allMatch("checking"::equals), "nothing is known yet");
        for (int i = 0; i < 20; i++) probe.refresh(urls);
        await("both in flight", () -> fake.inFlight.get() == 2);
        check(fake.calls.size() == 2, "repeated asks during a sweep start nothing new");
        fake.release();
        await("first answers", () -> probe.refresh(urls).values().stream().allMatch("online"::equals));
        await("sweep to end", () -> !workersAlive());
        int sweepCalls = fake.calls.size();
        check(sweepCalls == 2, "one call per computer in the first sweep");

        clock.addAndGet(ComputerProbe.SWEEP_GAP_MS - 1);
        probe.refresh(urls);
        check(!workersAlive() && fake.calls.size() == sweepCalls, "no new sweep inside the gap");

        // B goes away: its old answer stays until the new sweep's reply replaces it.
        fake.answers.put(B, false);
        fake.hold();
        clock.addAndGet(1);
        Map<String, String> during = probe.refresh(urls);
        check(during.get(B).equals("online"), "the previous answer holds while the new check is in flight");
        await("second sweep in flight", () -> fake.inFlight.get() == 2);
        fake.release();
        await("B offline", () -> probe.refresh(urls).get(B).equals("offline"));
        check(probe.refresh(urls).get(A).equals("online"), "A is unaffected");

        // And it comes back.
        await("sweep to end", () -> !workersAlive());
        fake.answers.put(B, true);
        clock.addAndGet(ComputerProbe.SWEEP_GAP_MS);
        probe.refresh(urls);
        await("B online again", () -> probe.refresh(urls).get(B).equals("online"));
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    private static void cancelFencesLateRepliesAndForgetsAnswers() throws Exception {
        Fake fake = new Fake();
        ComputerProbe probe = probe(fake, new AtomicLong());
        fake.hold();
        List<String> urls = List.of(A);
        probe.refresh(urls);
        await("in flight", () -> fake.inFlight.get() == 1);
        probe.cancel();
        fake.release();
        await("old worker to finish", () -> !workersAlive());
        check(probe.refresh(urls).get(A).equals("checking"), "a reply that lands after cancel is dropped, not shown");
        await("fresh answer", () -> probe.refresh(urls).get(A).equals("online"));
        probe.cancel();
        await("workers", () -> !workersAlive());
        check(probe.refresh(urls).get(A).equals("checking"), "a new visit never shows the previous visit's answer");
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    private static void reactivatingNeverStacksWorkersOnTopOfAStaleOne() throws Exception {
        Fake fake = new Fake();
        ComputerProbe probe = probe(fake, new AtomicLong());
        fake.hold();
        List<String> urls = List.of(A);
        probe.refresh(urls);
        await("in flight", () -> fake.inFlight.get() == 1);
        probe.cancel();
        for (int i = 0; i < 10; i++) {
            check(probe.refresh(urls).get(A).equals("checking"), "still checking while the stale reply is pending");
            probe.cancel();
        }
        probe.refresh(urls);
        check(fake.calls.size() == 1 && workerCount() == 1, "hide and show cannot pile a new sweep on a blocked one");
        fake.release();
        await("old worker to finish", () -> !workersAlive());
        await("a fresh sweep starts once the old one is gone", () -> probe.refresh(urls).get(A).equals("online"));
        check(fake.calls.size() == 2, "exactly one fresh call");
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    private static void concurrencyIsBoundedAndEveryComputerIsChecked() throws Exception {
        Fake fake = new Fake();
        ComputerProbe probe = probe(fake, new AtomicLong());
        List<String> urls = new ArrayList<>();
        for (int i = 0; i < 10; i++) urls.add("https://pc" + i + ".example.ts.net/app/");
        fake.hold();
        probe.refresh(urls);
        await("workers saturated", () -> fake.inFlight.get() == ComputerProbe.MAX_WORKERS);
        check(workerCount() == ComputerProbe.MAX_WORKERS, "no more threads than the cap");
        fake.release();
        await("all answered", () -> probe.refresh(urls).values().stream().allMatch("online"::equals));
        check(fake.maxInFlight.get() == ComputerProbe.MAX_WORKERS, "never more than the cap in flight");
        check(fake.calls.size() == 10 && new java.util.HashSet<>(fake.calls).size() == 10, "each computer exactly once");
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    private static void workerFailureIsOfflineAndDoesNotStallTheSweep() throws Exception {
        Fake fake = new Fake();
        fake.failing = true;
        ComputerProbe probe = probe(fake, new AtomicLong());
        List<String> urls = List.of(A, B);
        probe.refresh(urls);
        await("both offline", () -> probe.refresh(urls).values().stream().allMatch("offline"::equals));
        check(fake.calls.size() == 2, "a throwing transport still gets every computer");
        probe.cancel();
        await("workers", () -> !workersAlive());
    }

    public static void main(String[] args) throws Exception {
        transport();
        untrustedAddressesAreNeverContacted();
        sweepsAreSingleFlightPacedAndKeepAnswersUntilReplaced();
        cancelFencesLateRepliesAndForgetsAnswers();
        reactivatingNeverStacksWorkersOnTopOfAStaleOne();
        concurrencyIsBoundedAndEveryComputerIsChecked();
        workerFailureIsOfflineAndDoesNotStallTheSweep();
        System.out.println("PASS " + assertions + " computer-probe assertions");
    }
}
