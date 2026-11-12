// Progressive interactive controls for OMP Pulse static website & docs.
// Pure ES module, zero external runtime dependencies.

(function () {
  // Mobile menu toggle
  const header = document.querySelector(".site-header");
  const menuBtn = document.querySelector("[data-mobile-menu]");
  if (header && menuBtn) {
    menuBtn.addEventListener("click", () => {
      const open = header.getAttribute("data-menu-open") === "true";
      header.setAttribute("data-menu-open", String(!open));
      menuBtn.setAttribute("aria-expanded", String(!open));
    });
  }

  // Install command tabs
  const installTabs = Array.from(document.querySelectorAll("[data-install-tab]"));
  const installText = document.querySelector("[data-install-cmd]");
  const installPrompt = document.querySelector("[data-install-prompt]");
  if (installTabs.length && installText) {
    installTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        installTabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
        installText.textContent = tab.getAttribute("data-cmd") || "";
        if (installPrompt) {
          installPrompt.textContent = tab.getAttribute("data-prompt") || "$";
        }
      });
    });
  }

  // Copy buttons
  document.querySelectorAll("[data-copy-target], [data-copy-text]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const selector = btn.getAttribute("data-copy-target");
      const target = selector ? document.querySelector(selector) : null;
      const raw = btn.getAttribute("data-copy-text") ?? target?.textContent ?? "";
      const text = raw.trim();
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.setAttribute("data-copied", "true");
        btn.textContent = "Copied";
        window.setTimeout(() => {
          btn.removeAttribute("data-copied");
          btn.textContent = prev;
        }, 1600);
      } catch {
        // Clipboard denied in insecure context; leave text selectable
      }
    });
  });

  // Interactive product tour tabs
  const tourTabs = Array.from(document.querySelectorAll("[data-showcase-tab]"));
  const tourPanels = Array.from(document.querySelectorAll("[data-showcase-panel]"));
  if (tourTabs.length && tourPanels.length) {
    const activate = (id) => {
      tourTabs.forEach((tab) => {
        const match = tab.getAttribute("data-showcase-tab") === id;
        tab.setAttribute("aria-selected", String(match));
        tab.setAttribute("tabindex", match ? "0" : "-1");
      });
      tourPanels.forEach((panel) => {
        panel.hidden = panel.getAttribute("data-showcase-panel") !== id;
      });
    };
    tourTabs.forEach((tab, idx) => {
      tab.addEventListener("click", () => activate(tab.getAttribute("data-showcase-tab")));
      tab.addEventListener("keydown", (e) => {
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
        e.preventDefault();
        const next = tourTabs[(idx + (e.key === "ArrowDown" ? 1 : tourTabs.length - 1)) % tourTabs.length];
        next.focus();
        activate(next.getAttribute("data-showcase-tab"));
      });
    });
  }

  // The film: the markup ships native controls so it plays without script; with script the
  // poster gets one large play button instead, and the controls return on the first press.
  const film = document.querySelector("[data-film]");
  const filmPlay = document.querySelector("[data-film-play]");
  if (film instanceof HTMLVideoElement && filmPlay) {
    film.controls = false;
    filmPlay.hidden = false;
    filmPlay.addEventListener("click", () => {
      filmPlay.hidden = true;
      film.controls = true;
      // play() rejects when the browser refuses; the controls are there to try again.
      film.play().catch(() => {});
    });
  }

  // Hero demo video. Reduced motion means it does not autoplay: it rests on its
  // poster. The loop runs past five seconds, so a pause control is always offered
  // (WCAG 2.2.2); the button's pressed state is the video's paused state, read
  // from the video's own events so a browser that blocks or pauses autoplay
  // (data saver, low power mode) is reflected too.
  const heroVideo = document.querySelector("[data-hero-video]");
  const videoToggle = document.querySelector("[data-video-toggle]");
  if (heroVideo instanceof HTMLVideoElement) {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stopAtPoster = () => {
      heroVideo.autoplay = false;
      heroVideo.pause();
      heroVideo.currentTime = 0;
    };
    if (reduceMotion.matches) stopAtPoster();
    // A preference changed while the page is open stops motion; it never restarts it.
    reduceMotion.addEventListener("change", () => {
      if (reduceMotion.matches) stopAtPoster();
    });

    if (videoToggle) {
      const sync = () => videoToggle.setAttribute("aria-pressed", String(heroVideo.paused));
      heroVideo.addEventListener("play", sync);
      heroVideo.addEventListener("pause", sync);
      videoToggle.addEventListener("click", () => {
        if (heroVideo.paused) {
          // play() rejects when the browser refuses; the pause event keeps the button honest.
          heroVideo.play().catch(() => {});
        } else {
          heroVideo.pause();
        }
      });
      sync();
      videoToggle.hidden = false;
    }
  }

  // Mobile documentation page jump selector
  const docsSelect = document.querySelector("[data-docs-select]");
  if (docsSelect instanceof HTMLSelectElement) {
    docsSelect.addEventListener("change", () => {
      if (docsSelect.value) window.location.href = docsSelect.value;
    });
  }
})();
