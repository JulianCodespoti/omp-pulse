/**
 * The source that runs in the plugin's worker BEFORE the plugin's own script:
 * it defines the one global, `pulse`, and answers the host's requests.
 *
 * It is a string, not a module, because `plugin-sandbox.ts` concatenates it
 * with the plugin script into one blob: Worker source (the CSP leaves no other
 * way to load code). The worker has no DOM, no network and no storage; its only
 * channel is `postMessage`. Messages TO the host are JSON strings (the frame's
 * bootstrap drops anything else and anything over 131072 characters, so the page
 * only ever parses bounded text); messages FROM the host are structured clones.
 *
 * Must not use `eval` or `new Function`: the frame's CSP forbids them.
 * Keep the text free of backticks and `${`: it lives in a template literal.
 */
export const PLUGIN_WORKER_PRELUDE = String.raw`(function (g) {
  "use strict";
  var MAX_MESSAGE = 131072;
  var MAX_ERROR = 500;
  var MAX_TOAST = 200;
  var postToHost = g.postMessage.bind(g);
  var renderers = new Map();
  var actionHandlers = [];
  var optionHandlers = [];
  var currentOptions = Object.freeze({});
  var pendingCalls = new Map();
  var nextCall = 1;
  var pendingSources = new Map();
  var nextSourceRequest = 1;

  function send(message) {
    var text = JSON.stringify(message);
    if (typeof text !== "string") throw new TypeError("message is not JSON");
    if (text.length > MAX_MESSAGE) throw new RangeError("message is larger than " + MAX_MESSAGE + " characters");
    postToHost(text);
  }

  function describe(error) {
    var text;
    try {
      text = error && typeof error.message === "string" ? error.message : String(error);
    } catch (ignored) {
      text = "unprintable error";
    }
    return text.slice(0, MAX_ERROR);
  }

  // Never throws: it is the last line of defence for a handler that failed.
  function reportError(error, requestId) {
    var message = { t: "error", message: describe(error) };
    if (typeof requestId === "number") message.id = requestId;
    try { send(message); } catch (ignored) { /* nothing left to tell the host */ }
  }

  function node(k, p, c) {
    return { k: k, p: p, c: Array.isArray(c) ? c : [] };
  }
  function withProps(props, extra) {
    var out = {};
    if (props && typeof props === "object") {
      for (var key in props) if (Object.prototype.hasOwnProperty.call(props, key)) out[key] = props[key];
    }
    for (var extraKey in extra) if (extra[extraKey] !== undefined) out[extraKey] = extra[extraKey];
    return out;
  }

  var ui = {
    text: function (text, props) { return node("text", withProps(props, { text: text }), []); },
    chip: function (text, props) { return node("chip", withProps(props, { text: text }), []); },
    row: function (children, props) { return node("row", withProps(props, {}), children); },
    col: function (children, props) { return node("col", withProps(props, {}), children); },
    card: function (title, children, props) { return node("card", withProps(props, { title: title }), children); },
    kv: function (items) { return node("kv", { items: items }, []); },
    list: function (items, props) { return node("list", withProps(props, { items: items }), []); },
    progress: function (value, label, props) {
      return node("progress", withProps(props, { value: value, label: label }), []);
    },
    button: function (text, action, props) {
      return node("button", withProps(props, { text: text, actions: { click: action } }), []);
    },
    empty: function (title, description) {
      return node("empty", withProps(null, { title: title, description: description }), []);
    }
  };

  function slot(slotId, render) {
    if (typeof slotId !== "string") throw new TypeError("pulse.slot: the slot id must be a string");
    if (typeof render !== "function") throw new TypeError("pulse.slot: render must be a function");
    renderers.set(slotId, render);
  }

  function source(sourceId) {
    return new Promise(function (resolve) {
      var id = nextSourceRequest++;
      pendingSources.set(id, resolve);
      send({ t: "source", id: id, sourceId: String(sourceId) });
    });
  }

  function on(type, handler) {
    if (type !== "action" && type !== "options") throw new TypeError('pulse.on: the events are "action" and "options"');
    if (typeof handler !== "function") throw new TypeError("pulse.on: the handler must be a function");
    (type === "action" ? actionHandlers : optionHandlers).push(handler);
  }

  // Every action method answers with a result, never a rejection: a refusal or a failure is
  // { ok: false, error }, so a plugin that forgets to catch cannot wedge itself.
  function call(op, fields) {
    return new Promise(function (resolve) {
      var id = nextCall++;
      var message = { t: "call", id: id, op: op };
      for (var name in fields) if (Object.prototype.hasOwnProperty.call(fields, name)) message[name] = fields[name];
      pendingCalls.set(id, resolve);
      try {
        send(message);
      } catch (error) {
        pendingCalls.delete(id);
        resolve({ ok: false, error: describe(error) });
      }
    });
  }

  function refresh(slotId) {
    var message = { t: "refresh" };
    if (slotId !== undefined) message.slot = String(slotId);
    send(message);
  }

  function openPage() {
    send({ t: "openPage" });
  }

  function toast(message) {
    send({ t: "toast", text: String(message).slice(0, MAX_TOAST) });
  }

  function answerRender(message) {
    var requestId = message.id;
    var slotId = message.slot;
    // A keyed slot's answer names its key, so the host can tell the renders of one plugin apart.
    var echo = { t: "view", id: requestId, slot: slotId };
    if (message.key !== undefined) echo.key = message.key;
    var render = renderers.get(slotId);
    if (!render) {
      echo.view = null;
      send(echo);
      return;
    }
    var result;
    try {
      result = render(message.ctx === undefined ? { session: null } : message.ctx);
    } catch (error) {
      reportError(error, requestId);
      return;
    }
    Promise.resolve(result).then(function (view) {
      echo.view = view === undefined ? null : view;
      send(echo);
    }).catch(function (error) {
      // Also lands here when the view cannot be serialised or is too large.
      reportError(error, requestId);
    });
  }

  function runAction(message) {
    var action = String(message.action);
    var cut = action.indexOf("=");
    var event = { slot: message.slot, act: cut < 0 ? action : action.slice(0, cut) };
    if (cut >= 0) event.value = action.slice(cut + 1);
    if (message.item !== undefined) event.item = message.item;
    if (message.key !== undefined) event.key = message.key;
    event.session = message.session === undefined ? null : message.session;
    actionHandlers.slice().forEach(function (handler) {
      try {
        var result = handler(event);
        if (result && typeof result.then === "function") result.then(null, function (error) { reportError(error); });
      } catch (error) {
        reportError(error);
      }
    });
  }

  function applyOptions(values) {
    var next = {};
    if (values && typeof values === "object") {
      for (var name in values) if (Object.prototype.hasOwnProperty.call(values, name)) next[name] = values[name];
    }
    currentOptions = Object.freeze(next);
    optionHandlers.slice().forEach(function (handler) {
      try {
        var result = handler(currentOptions);
        if (result && typeof result.then === "function") result.then(null, function (error) { reportError(error); });
      } catch (error) {
        reportError(error);
      }
    });
  }

  g.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.t === "render") {
      if (typeof message.id === "number" && typeof message.slot === "string") answerRender(message);
    } else if (message.t === "action") {
      if (typeof message.action === "string") runAction(message);
    } else if (message.t === "options") {
      applyOptions(message.values);
    } else if (message.t === "callResult") {
      var settle = pendingCalls.get(message.id);
      if (settle) {
        pendingCalls.delete(message.id);
        var result = message.result;
        settle(result && typeof result === "object" ? result : { ok: false, error: "The host sent no answer" });
      }
    } else if (message.t === "source") {
      var resolve = pendingSources.get(message.id);
      if (resolve) {
        pendingSources.delete(message.id);
        resolve(message.reading);
      }
    }
  });
  g.addEventListener("unhandledrejection", function (event) { reportError(event.reason); });

  var composer = Object.freeze({
    insert: function (text) { return call("compose", { text: String(text) }); }
  });
  var session = Object.freeze({
    prompt: function (text) { return call("prompt", { text: String(text) }); },
    bash: function (command, options) {
      return call("bash", { command: String(command), excludeFromContext: !!(options && options.excludeFromContext) });
    },
    rpc: function (command, params) {
      return call("rpc", { command: String(command), params: params === undefined ? {} : params });
    }
  });
  var host = Object.freeze({
    run: function (actionId, arg) {
      var fields = { action: String(actionId) };
      if (arg !== undefined) fields.arg = String(arg);
      return call("hostRun", fields);
    }
  });

  Object.defineProperty(g, "pulse", {
    value: Object.freeze({
      slot: slot,
      source: source,
      on: on,
      get options() { return currentOptions; },
      refresh: refresh,
      openPage: openPage,
      toast: toast,
      composer: composer,
      session: session,
      host: host,
      ui: Object.freeze(ui)
    })
  });

  // The plugin script runs right after this text; a timer fires once it has
  // finished its top-level code, which is when the host may start asking for views.
  g.setTimeout(function () {
    try { send({ t: "ready" }); } catch (error) { reportError(error); }
  }, 0);
})(self);
`;
