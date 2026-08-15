'use strict';

/* Wiring: config -> sources -> DOM. */

(() => {
  const chatEl = document.getElementById('chat');
  const statusEl = document.getElementById('status');
  const settingsEl = document.getElementById('settings');
  const sourcesEl = document.getElementById('sources');
  const hotkeyWarn = document.getElementById('hotkey-warn');

  let config = null;
  let sources = [];
  const states = new Map();     // source key -> {state, detail, channel, platform}
  const nodes = new Map();      // message id -> {el, timer}
  let autoScroll = true;

  const getConfig = () => config;

  /* ------------------------------------------------------------- appearance */

  // Constructable stylesheet: lets user CSS in without an inline <style>, which
  // the page's CSP (style-src 'self') would refuse.
  const customSheet = new CSSStyleSheet();
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, customSheet];

  function applyCustomCss() {
    try {
      customSheet.replaceSync(config.customCss || '');
      return '';
    } catch (err) {
      return err.message;
    }
  }

  function applyAppearance() {
    const root = document.documentElement.style;
    root.setProperty('--font-size', config.fontSize + 'px');
    root.setProperty('--font-weight', String(config.fontWeight));
    root.setProperty('--font-family', config.fontFamily);
    root.setProperty('--name-weight', config.boldNames ? '800' : 'var(--font-weight)');
    root.setProperty('--emote-size', Math.round(config.fontSize * config.emoteScale) + 'px');
    root.setProperty('--badge-size', Math.round(config.fontSize * 1.15) + 'px');
    root.setProperty('--bg', `rgba(10, 12, 18, ${config.bgOpacity})`);
    root.setProperty('--fade', config.fadeDuration + 's');
    document.body.classList.toggle('outline', !!config.outline);
    document.body.style.opacity = String(config.opacity);
    trimMessages();
  }

  function applyLocked(locked) {
    document.body.classList.toggle('locked', !!locked);
    if (locked) {
      showSettings(false);
      autoScroll = true;
      scrollToBottom();
    }
  }

  /* --------------------------------------------------------------- messages */

  function scrollToBottom() {
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  chatEl.addEventListener('scroll', () => {
    const slack = chatEl.scrollHeight - chatEl.clientHeight - chatEl.scrollTop;
    autoScroll = slack < 24;
  });

  function chip(text, kind) {
    const el = document.createElement('span');
    el.className = 'badge ' + (kind || 'generic');
    el.textContent = text;
    return el;
  }

  /** Real artwork when we have it, coloured text chip when we do not. */
  function badgeNode(b) {
    if (config.badgeStyle === 'icons' && b.url) {
      const img = document.createElement('img');
      img.className = 'badge-img';
      img.src = b.url;
      img.alt = b.title || b.label;
      img.title = b.title || b.label;
      img.addEventListener('error', () => img.replaceWith(chip(b.label, b.kind)), { once: true });
      return img;
    }
    return chip(b.label, b.kind);
  }

  function renderParts(container, parts) {
    for (const p of parts) {
      if (p.type === 'emote') {
        const img = document.createElement('img');
        img.className = 'emote';
        img.src = p.url;
        img.alt = p.name;
        img.title = p.name;
        img.loading = 'lazy';
        if (p.fallback) {
          img.addEventListener('error', function onErr() {
            img.removeEventListener('error', onErr);
            img.src = p.fallback;
          });
        }
        container.appendChild(img);
      } else if (p.type === 'url') {
        const a = document.createElement('span');
        a.className = 'url';
        a.textContent = p.value;
        container.appendChild(a);
      } else {
        container.appendChild(document.createTextNode(p.value));
      }
    }
  }

  function shouldDrop(msg) {
    // The "no channel enabled" hint carries no channel and must always show.
    if (msg.kind !== 'chat') return !config.showSystem && !!msg.channel;
    const plain = msg.parts.map((p) => (p.type === 'emote' ? '' : p.value)).join('').trim();
    if (config.hideCommands && plain.startsWith('!')) return true;
    if (config.ignoreList && config.ignoreList.length) {
      const login = String(msg.userLogin || '').toLowerCase();
      if (config.ignoreList.some((n) => n && n.toLowerCase() === login)) return true;
    }
    return false;
  }

  function addMessage(msg) {
    if (nodes.has(msg.id)) return;
    if (shouldDrop(msg)) return;

    const el = document.createElement('div');
    el.className = 'msg' + (msg.kind === 'system' ? ' system' : '') +
      (msg.kind === 'event' ? ' event' : '') + (msg.action ? ' action' : '');
    el.dataset.user = msg.userLogin || '';
    el.dataset.platform = msg.platform;
    el.dataset.channel = msg.channel || '';

    if (config.showTimestamps) {
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = U.timeString(msg.ts);
      el.appendChild(ts);
    }

    if (config.platformStyle !== 'off' && msg.channel) {
      const twitch = msg.platform === 'twitch';
      const title = msg.platform + ' / ' + msg.channel;
      if (config.platformStyle === 'icon') {
        const img = document.createElement('img');
        img.className = 'plat-img';
        img.src = twitch ? '../assets/twitch.svg' : '../assets/goodgame.png';
        img.alt = twitch ? 'twitch' : 'goodgame';
        img.title = title;
        el.appendChild(img);
      } else {
        const tag = document.createElement('span');
        tag.className = 'plat ' + (twitch ? 'tw' : 'gg');
        tag.textContent = twitch ? 'TW' : 'GG';
        tag.title = title;
        el.appendChild(tag);
      }
    }

    if (msg.kind === 'chat') {
      if (config.badgeStyle !== 'off') {
        for (const b of msg.badges) el.appendChild(badgeNode(b));
      }
      const name = document.createElement('span');
      name.className = 'name';
      name.style.color = msg.color;
      name.textContent = msg.user;
      el.appendChild(name);

      const colon = document.createElement('span');
      colon.className = 'colon';
      colon.textContent = msg.action ? ' ' : ':';
      el.appendChild(colon);
    }

    const text = document.createElement('span');
    text.className = 'text';
    if (msg.action) text.style.color = msg.color;
    renderParts(text, msg.parts);
    el.appendChild(text);

    chatEl.appendChild(el);

    const entry = { el, timer: null };
    if (config.messageLifetime > 0) {
      entry.timer = setTimeout(() => {
        el.classList.add('fading');
        setTimeout(() => removeMessage(msg.id), config.fadeDuration * 1000 + 60);
      }, config.messageLifetime * 1000);
    }
    nodes.set(msg.id, entry);

    trimMessages();
    if (autoScroll) scrollToBottom();
  }

  function removeMessage(id) {
    const entry = nodes.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.el.remove();
    nodes.delete(id);
  }

  function trimMessages() {
    const max = config.maxMessages;
    while (nodes.size > max) {
      const oldest = nodes.keys().next().value;
      removeMessage(oldest);
    }
  }

  function handleRemove(req) {
    if (req.ids) {
      req.ids.forEach(removeMessage);
      return;
    }
    for (const [id, entry] of Array.from(nodes.entries())) {
      const el = entry.el;
      if (req.all && el.dataset.platform === req.platform && el.dataset.channel === req.channel) {
        removeMessage(id);
      } else if (req.user && el.dataset.platform === req.platform && el.dataset.user === req.user) {
        removeMessage(id);
      }
    }
  }

  function clearAll() {
    for (const id of Array.from(nodes.keys())) removeMessage(id);
  }

  /* ---------------------------------------------------------------- status */

  function renderStatus() {
    const bits = [];
    for (const s of sources) {
      const st = states.get(s.key) || { state: 'connecting' };
      const mark = st.state === 'online' ? '●' : st.state === 'error' ? '▲' : '○';
      bits.push(`${mark} ${s.platform === 'twitch' ? 'tw' : 'gg'}/${s.channel}` +
        (st.detail && st.state !== 'online' ? ` (${st.detail})` : ''));
    }
    statusEl.textContent = bits.join('   ') || 'no channels configured';
    refreshSourceDots();
  }

  function onStatus(src, state, detail) {
    states.set(src.key, { state, detail });
    renderStatus();
  }

  /* --------------------------------------------------------------- sources */

  function rebuildSources() {
    sources.forEach((s) => s.destroy());
    sources = [];
    states.clear();

    for (const cfgSrc of config.sources) {
      if (!cfgSrc.enabled || !cfgSrc.channel) continue;
      const opts = {
        channel: cfgSrc.channel.trim(),
        onMessage: addMessage,
        onRemove: handleRemove,
        onStatus,
        getConfig,
      };
      const src = cfgSrc.platform === 'twitch'
        ? new Sources.TwitchSource(opts)
        : new Sources.GoodGameSource(opts);
      sources.push(src);
      states.set(src.key, { state: 'connecting', detail: '' });
      src.connect();
    }
    if (sources.length === 0) {
      const named = config.sources.some((s) => s.channel);
      addMessage({
        id: 'hint:' + Date.now(),
        platform: 'goodgame',
        channel: '',
        user: '',
        userLogin: '',
        color: '#b9c6dc',
        badges: [],
        parts: [{
          type: 'text',
          value: named
            ? 'No channel enabled — open Settings and tick one.'
            : 'No channels yet — open Settings and add one.',
        }],
        kind: 'system',
        ts: Date.now(),
      });
    }
    renderStatus();
  }

  const rebuildDebounced = U.debounce(rebuildSources, 700);

  /* -------------------------------------------------------------- settings */

  const RANGE_FIELDS = [
    ['fontSize', (v) => v + 'px', Number],
    ['fontWeight', (v) => String(v), Number],
    ['opacity', (v) => Math.round(v * 100) + '%', Number],
    ['bgOpacity', (v) => Math.round(v * 100) + '%', Number],
    ['emoteScale', (v) => v + '×', Number],
    ['maxMessages', (v) => String(v), Number],
    ['messageLifetime', (v) => (Number(v) === 0 ? 'never' : v + 's'), Number],
  ];

  const CHECK_FIELDS = [
    'outline', 'showTimestamps', 'boldNames', 'exactColors',
    'showSystem', 'emotes', 'thirdPartyEmotes', 'hideCommands', 'autoCheckUpdates',
  ];

  function bindSettings() {
    for (const [key, fmt, cast] of RANGE_FIELDS) {
      const input = document.getElementById(key);
      const out = document.getElementById('out-' + key);
      input.value = config[key];
      out.textContent = fmt(config[key]);
      input.addEventListener('input', () => {
        config[key] = cast(input.value);
        out.textContent = fmt(config[key]);
        applyAppearance();
        persist({ [key]: config[key] });
      });
    }

    for (const key of CHECK_FIELDS) {
      const input = document.getElementById(key);
      input.checked = !!config[key];
      input.addEventListener('change', () => {
        config[key] = input.checked;
        applyAppearance();
        persist({ [key]: config[key] });
        if (key === 'emotes' || key === 'thirdPartyEmotes' || key === 'exactColors') {
          rebuildDebounced();
        }
      });
    }

    for (const key of ['badgeStyle', 'platformStyle']) {
      const sel = document.getElementById(key);
      sel.value = config[key];
      sel.addEventListener('change', () => {
        config[key] = sel.value;
        persist({ [key]: config[key] });
      });
    }

    // Font: preset dropdown writes into the free-text field, which is the truth.
    const fontFamily = document.getElementById('fontFamily');
    const fontPreset = document.getElementById('fontPreset');
    const syncPreset = () => {
      const match = Array.from(fontPreset.options).find((o) => o.value === config.fontFamily);
      fontPreset.value = match ? match.value : '__custom';
    };
    fontFamily.value = config.fontFamily;
    syncPreset();
    fontPreset.addEventListener('change', () => {
      if (fontPreset.value === '__custom') return;
      config.fontFamily = fontPreset.value;
      fontFamily.value = fontPreset.value;
      applyAppearance();
      persist({ fontFamily: config.fontFamily });
    });
    fontFamily.addEventListener('input', () => {
      config.fontFamily = fontFamily.value.trim() || "'Segoe UI', system-ui, sans-serif";
      applyAppearance();
      syncPreset();
      persist({ fontFamily: config.fontFamily });
    });

    const cssBox = document.getElementById('customCss');
    const cssError = document.getElementById('css-error');
    cssBox.value = config.customCss || '';
    cssBox.addEventListener('input', () => {
      config.customCss = cssBox.value;
      const err = applyCustomCss();
      cssError.hidden = !err;
      cssError.textContent = err ? 'CSS rejected: ' + err : '';
      persist({ customCss: config.customCss });
    });

    const ignore = document.getElementById('ignoreList');
    ignore.value = (config.ignoreList || []).join(', ');
    ignore.addEventListener('input', () => {
      config.ignoreList = ignore.value.split(',').map((s) => s.trim()).filter(Boolean);
      persist({ ignoreList: config.ignoreList });
    });

    for (const key of ['hotkeyLock', 'hotkeyHide']) {
      const input = document.getElementById(key);
      input.value = config[key] || '';
      input.addEventListener('change', () => {
        config[key] = input.value.trim();
        persist({ [key]: config[key] });
      });
    }
  }

  function persist(patch) {
    window.overlay.setConfig(patch).catch((err) => console.warn('save failed', err));
  }

  /**
   * Full rebuild of the channel rows. Only called when the list itself changes
   * (boot, add, remove) — never from the status tick, which would wipe the field
   * the user is typing in.
   */
  function renderSourceRows() {
    sourcesEl.textContent = '';
    if (config.sources.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'hint empty';
      empty.textContent = 'No channels yet. Add one below, then tick it to connect.';
      sourcesEl.appendChild(empty);
      return;
    }
    config.sources.forEach((src, index) => sourcesEl.appendChild(buildSourceRow(src, index)));
    refreshSourceDots();
  }

  /** Cheap per-tick update: connection dot only, DOM structure untouched. */
  function refreshSourceDots() {
    Array.from(sourcesEl.children).forEach((row, index) => {
      const src = config.sources[index];
      const dot = row.querySelector('.dot');
      if (!src || !dot) return;
      if (src.enabled === false) {
        dot.className = 'dot';
        dot.title = 'disabled';
        return;
      }
      const key = src.platform + ':' + String(src.channel || '').toLowerCase();
      const st = states.get(key);
      dot.className = 'dot' + (st && st.state === 'online' ? ' on' : st && st.state === 'error' ? ' err' : '');
      dot.title = st ? st.state + (st.detail ? ' — ' + st.detail : '') : 'not connected';
    });
  }

  function buildSourceRow(src, index) {
    const row = document.createElement('div');
    row.className = 'src-row';

    const dot = document.createElement('span');
    dot.className = 'dot';
    row.appendChild(dot);

    const enable = document.createElement('input');
    enable.type = 'checkbox';
    enable.checked = src.enabled !== false;
    enable.title = 'Connect to this channel';
    enable.addEventListener('change', () => {
      config.sources[index].enabled = enable.checked;
      persist({ sources: config.sources });
      rebuildSources();
    });
    row.appendChild(enable);

    const select = document.createElement('select');
    for (const [value, label] of [['goodgame', 'GoodGame'], ['twitch', 'Twitch']]) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      select.appendChild(opt);
    }
    select.value = src.platform;
    select.addEventListener('change', () => {
      config.sources[index].platform = select.value;
      persist({ sources: config.sources });
      rebuildDebounced();
    });
    row.appendChild(select);

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.placeholder = 'channel name';
    input.value = src.channel;
    input.addEventListener('input', () => {
      config.sources[index].channel = input.value.trim();
      persist({ sources: config.sources });
      rebuildDebounced();
    });
    row.appendChild(input);

    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Remove channel';
    del.addEventListener('click', () => {
      config.sources.splice(index, 1);
      persist({ sources: config.sources });
      renderSourceRows();
      rebuildSources();
    });
    row.appendChild(del);

    return row;
  }

  /* ------------------------------------------------------------ chrome/UI */

  const settingsBtn = document.getElementById('btn-settings');

  function showSettings(show) {
    settingsEl.hidden = !show;
    settingsBtn.textContent = show ? 'Back to chat' : 'Settings';
    if (!show && autoScroll) scrollToBottom();
  }

  settingsBtn.addEventListener('click', () => showSettings(settingsEl.hidden));
  document.getElementById('btn-settings-close').addEventListener('click', () => showSettings(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !settingsEl.hidden) showSettings(false);
  });
  document.getElementById('btn-add-source').addEventListener('click', () => {
    config.sources.push({ platform: 'twitch', channel: '', enabled: true });
    persist({ sources: config.sources });
    renderSourceRows();
  });
  document.getElementById('btn-lock').addEventListener('click', () => {
    window.overlay.setLocked(true);
  });
  document.getElementById('btn-reconnect').addEventListener('click', () => {
    clearAll();
    rebuildSources();
  });
  document.getElementById('btn-quit').addEventListener('click', () => window.overlay.quit());

  // Custom resize grip: a frameless transparent window has no OS resize border.
  (() => {
    const grip = document.getElementById('resize');
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    grip.addEventListener('mousedown', (e) => {
      dragging = true;
      lastX = e.screenX;
      lastY = e.screenY;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.screenX - lastX;
      const dy = e.screenY - lastY;
      if (dx || dy) {
        lastX = e.screenX;
        lastY = e.screenY;
        window.overlay.resizeBy(dx, dy);
      }
    });
    window.addEventListener('mouseup', () => { dragging = false; });
  })();

  /* ------------------------------------------------------------------ boot */

  /* --------------------------------------------------------------- updates */

  const updateBtn = document.getElementById('btn-update');
  const updateStatus = document.getElementById('update-status');
  const applyBtn = document.getElementById('btn-apply-update');
  const checkBtn = document.getElementById('btn-check-update');
  let available = null;
  let busy = false;

  function setUpdateStatus(text) {
    if (updateStatus) updateStatus.textContent = text;
  }

  async function refreshVersion(suffix) {
    const v = await window.overlay.updateVersion();
    setUpdateStatus('Version ' + v.version + (suffix ? ' — ' + suffix : ''));
  }

  function offerUpdate(info) {
    available = info;
    updateBtn.hidden = false;
    updateBtn.textContent = 'Update to ' + info.version;
    applyBtn.hidden = false;
    setUpdateStatus('Version ' + info.current + ' — v' + info.version + ' available');
    // Locked users never see the bar, so say it in the feed too.
    systemLine('Version ' + info.version + ' is available — unlock and click Update.');
  }

  function systemLine(text) {
    addMessage({
      id: 'sys:' + Date.now() + ':' + Math.random().toString(36).slice(2, 7),
      platform: 'goodgame',
      channel: '',
      user: '',
      userLogin: '',
      color: '#b9c6dc',
      badges: [],
      parts: [{ type: 'text', value: text }],
      kind: 'system',
      ts: Date.now(),
    });
  }

  async function applyUpdate() {
    if (busy || !available) return;
    busy = true;
    const label = applyBtn.textContent;
    applyBtn.textContent = 'Downloading…';
    updateBtn.textContent = 'Downloading…';
    try {
      const res = await window.overlay.updateApply();
      if (res.manual) {
        setUpdateStatus('This release needs the full download — opened in your browser.');
        applyBtn.textContent = label;
        busy = false;
        return;
      }
      setUpdateStatus('v' + res.version + ' ready — restarting…');
      setTimeout(() => window.overlay.updateRestart(), 600);
    } catch (err) {
      setUpdateStatus('Update failed: ' + err.message);
      systemLine('Update failed: ' + err.message);
      applyBtn.textContent = label;
      updateBtn.textContent = 'Update to ' + available.version;
      busy = false;
    }
  }

  updateBtn.addEventListener('click', () => {
    showSettings(true);
    applyUpdate();
  });
  applyBtn.addEventListener('click', applyUpdate);
  checkBtn.addEventListener('click', async () => {
    setUpdateStatus('Checking…');
    const res = await window.overlay.updateCheck();
    if (res && res.error) setUpdateStatus('Check failed: ' + res.error);
    else if (res && !res.newer) setUpdateStatus('Version ' + res.current + ' — up to date');
  });

  window.overlay.onUpdateAvailable(offerUpdate);
  window.overlay.onUpdateNone((info) => setUpdateStatus('Version ' + info.current + ' — up to date'));
  window.overlay.onUpdateError((msg) => setUpdateStatus('Check failed: ' + msg));

  window.overlay.onLocked(applyLocked);
  window.overlay.onReconnect(() => { clearAll(); rebuildSources(); });
  window.overlay.onHotkeys((ok) => {
    const failed = [];
    if (!ok.lock) failed.push(config.hotkeyLock);
    if (!ok.hide) failed.push(config.hotkeyHide);
    hotkeyWarn.hidden = failed.length === 0;
    hotkeyWarn.textContent = failed.length
      ? 'Could not register: ' + failed.join(', ') + ' — another app already owns it. Pick a different combo.'
      : '';
  });

  window.overlay.getConfig().then((cfg) => {
    config = cfg;
    applyCustomCss();
    applyAppearance();
    applyLocked(config.locked);
    bindSettings();
    renderSourceRows();
    rebuildSources();
    refreshVersion();
    // Nothing configured yet: put the user straight where channels are added.
    if (config.sources.length === 0 && !config.locked) showSettings(true);
  });
})();
