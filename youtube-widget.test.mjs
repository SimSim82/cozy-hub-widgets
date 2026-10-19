import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const pagePath = new URL('../dist/youtube.html', import.meta.url);

function createWidget({ storage = new Map() } = {}) {
  let html;
  try {
    html = readFileSync(pagePath, 'utf8');
  } catch {
    assert.fail('The YouTube widget page has not been implemented yet.');
  }

  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(inlineScripts.length, 'The widget should initialize the YouTube IFrame API.');

  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        value: id === 'volume' ? '70' : '',
        disabled: false,
        listeners: {},
        attributes: {},
        textContent: '',
        clientWidth: 320,
        clientHeight: 180,
        addEventListener(type, listener) { this.listeners[type] = listener; },
        setAttribute(name, value) { this.attributes[name] = value; },
        click() { this.listeners.click?.({ currentTarget: this, preventDefault() {} }); },
        input() { this.listeners.input?.({ currentTarget: this }); },
      });
    }
    return elements.get(id);
  };

  const calls = [];
  let playerConfig;
  const player = { state: 5 };
  player.getPlaylist = () => Array.from({ length: 200 }, (_, i) => 'v' + i);
  for (const method of ['cuePlaylist', 'playVideo', 'pauseVideo', 'previousVideo', 'nextVideo', 'setShuffle', 'setLoop', 'setVolume', 'setSize', 'getPlayerState']) {
    player[method] = (...args) => {
      calls.push([method, ...args]);
      if (method === 'getPlayerState') return player.state;
    };
  }
  const YT = {
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    Player: function (_id, config) { playerConfig = config; return player; },
  };
  const timers = [];
  const localStorage = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => { storage.set(key, String(value)); },
  };
  const window = {};
  const document = { getElementById: getElement, querySelector: () => getElement('frame'), querySelectorAll: () => [] };
  vm.runInNewContext(inlineScripts.at(-1), {
    window, document, YT, console, localStorage,
    ResizeObserver: class { observe() {} },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
  });
  assert.equal(typeof window.onYouTubeIframeAPIReady, 'function', 'The API ready callback should be registered.');
  window.onYouTubeIframeAPIReady();
  assert.ok(playerConfig, 'A YouTube iframe player should be created.');
  playerConfig.events.onReady({ target: player });
  // YouTube signale CUED à chaque playlist prête : une fois au chargement, une fois après le titre aléatoire.
  playerConfig.events.onStateChange({ data: 5, target: player });
  playerConfig.events.onStateChange({ data: 5, target: player });
  const runTimers = () => timers.splice(0).forEach((fn) => fn && fn());
  return { html, calls, elements, player, playerConfig, storage, runTimers };
}

test('loads the requested YouTube playlist', () => {
  const { html, calls } = createWidget();
  assert.match(html, /PLSKDu2RrwS_k/);
  assert.ok(calls.some(([method, options]) => method === 'cuePlaylist' && options.list === 'PLSKDu2RrwS_k'));
});

test('keeps the widget flush to the available iframe width at both column breakpoints', () => {
  const { html } = createWidget();
  const stylesheet = html.match(/<style>([\s\S]*?)<\/style>/i)?.[1] ?? '';
  assert.match(stylesheet, /body\s*\{[^}]*padding:\s*8px\s+0\s*;/);
  assert.match(stylesheet, /@media\s*\(max-width:\s*260px\)\s*\{\s*body\s*\{[^}]*padding:\s*2px\s+0\s*;/);
});

test('shuffle is on by default and applied once the playlist is cued, after every reload', () => {
  for (let load = 0; load < 2; load += 1) {
    const { calls, elements } = createWidget();
    assert.ok(calls.some(([method, enabled]) => method === 'setShuffle' && enabled === true));
    const cues = calls.filter(([method]) => method === 'cuePlaylist');
    assert.equal(cues.length, 2, 'cues the playlist again on a random track');
    assert.ok(Number.isInteger(cues[1][1].index) && cues[1][1].index >= 0 && cues[1][1].index < 200);
    assert.ok(!calls.some(([method]) => ['playVideo', 'nextVideo'].includes(method)), 'never starts playback on load');
    assert.equal(elements.get('shuffle').attributes['aria-pressed'], 'true');
  }
});

test('turning shuffle off is remembered after a reload', () => {
  const storage = new Map();
  const first = createWidget({ storage });
  first.elements.get('shuffle').click();
  assert.ok(first.calls.some(([method, enabled]) => method === 'setShuffle' && enabled === false));

  const reloaded = createWidget({ storage });
  assert.ok(!reloaded.calls.some(([method, enabled]) => method === 'setShuffle' && enabled === true));
  assert.equal(reloaded.elements.get('shuffle').attributes['aria-pressed'], 'false');
});

test('toggles playlist looping through the YouTube IFrame API', () => {
  const { calls, elements } = createWidget();
  elements.get('loop').click();
  assert.ok(calls.some(([method, enabled]) => method === 'setLoop' && enabled === true));
});

test('exposes previous, next, play/pause, and volume controls', () => {
  const { calls, elements, player } = createWidget();
  elements.get('previous').click();
  elements.get('next').click();
  elements.get('play-pause').click();
  elements.get('volume').input();
  player.state = 1;
  elements.get('play-pause').click();
  for (const method of ['previousVideo', 'nextVideo', 'playVideo', 'pauseVideo', 'setVolume']) {
    assert.ok(calls.some(([called]) => called === method), `${method} should be called by its control.`);
  }
});

test('asks for one click on the video when the embed blocks the first start', () => {
  const { elements, player, playerConfig, runTimers } = createWidget();
  player.state = -1;
  elements.get('play-pause').click();
  runTimers();
  assert.equal(elements.get('status').textContent, 'Clique une fois sur la vidéo pour démarrer');

  playerConfig.events.onStateChange({ data: 1, target: player });
  assert.equal(elements.get('status').textContent, 'Lecture en cours');
  assert.equal(elements.get('play-pause').textContent, '⏸');
});

test('no hint when playback starts normally', () => {
  const { elements, player, playerConfig, runTimers } = createWidget();
  elements.get('play-pause').click();
  player.state = 1;
  playerConfig.events.onStateChange({ data: 1, target: player });
  runTimers();
  assert.notEqual(elements.get('status').textContent, 'Clique une fois sur la vidéo pour démarrer');
});
