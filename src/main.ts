/**
 * K-Prompt's page: the Spectrum in the monitor, the tape deck and the
 * keyboard under it, and the panels for the machine, display, sound and
 * controls.
 */
import './style.css';
import { unzipSync } from 'fflate';
import rom48Url from './roms/48k.rom?url';
import romTk90xUrl from './roms/tk90x.rom?url';
import romTk95Url from './roms/tk95.rom?url';
import rom128Url from './roms/128k.rom?url';
import romPlus2Url from './roms/plus2.rom?url';
import romTs2068Url from './roms/ts2068.rom?url';
import romIf1v2Url from './roms/if1-v2.rom?url';
import romIf1v1Url from './roms/if1-v1.rom?url';
import { Cartridge } from './zx/microdrive';
import termTapUrl from './programs/TERM.tap?url';
import ulaTapUrl from './programs/ULA.tap?url';
import { inPhoneBook } from './phonebook';
import type { Dialer, Link, LinkHandlers } from './zx/modem';
import { withCallSound } from './ui/call-sound';
import { startCallSound } from './ui/modem-audio';
import { CS, KeyInput, KEYS, SS, Key } from './zx/keyboard';
import { layoutFor } from './zx/legend';
import { Model, MODELS, Spectrum, TK_VIDEO, TkVideo } from './zx/machine';
import { isSnapshot, loadSnapshot, machineKind, saveSna, saveZ80, snapshotKind } from './zx/snapshot';
import { programTape, tokenize } from './zx/basic';
import { blankTape, parseTape, Tape } from './zx/tape';
import { HEIGHT, WIDTH } from './zx/ula';
import { audioContext } from './ui/audio';
import { askConfirm } from './ui/confirm';
import { waitForPower, warmUp } from './ui/power';
import { SoundOut } from './ui/sound-out';
import { loadDeck, loadDrive, loadQuick, loadShelf, saveDeck, saveDrive, saveQuick, shelve, StoredFile, unshelve } from './ui/store';
import { Rewind } from './zx/rewind';

const SAMPLE_RATE = 44100;
const MAX_FILE = 2 * 1024 * 1024;
const SETTINGS_KEY = 'k-prompt.settings';
const MODEM_PROFILE = 'k-prompt.modem';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

// ---- settings ---------------------------------------------------------------

type Joystick = 'kempston' | 'sinclair' | 'cursor' | 'none';

interface Settings {
  model: Model;
  tkVideo: TkVideo;
  speed: number;
  fastLoad: boolean;
  turboTape: boolean;
  smooth: boolean;
  scanlines: boolean;
  curve: boolean;
  flicker: boolean;
  humbar: boolean;
  volume: number;
  autoPower: boolean;
  joystick: Joystick;
  keyboard: boolean;
  /** An AY interface on a 48K or TK, at the 128K's ports. */
  ay48: boolean;
  /** Sinclair's Interface 1, and which ROM it has. */
  if1: 'off' | 'v2' | 'v1';
}

const DEFAULTS: Settings = {
  model: '48k', tkVideo: '60', speed: 1, fastLoad: true, turboTape: true, smooth: false, scanlines: true, curve: true,
  flicker: false, humbar: false, volume: 70, autoPower: false, joystick: 'kempston', keyboard: false, ay48: false, if1: 'off',
};

function loadSettings(): Settings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
    if (!(s.model in MODELS)) s.model = '48k';
    if (!(s.tkVideo in TK_VIDEO)) s.tkVideo = '60';
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

const settings = loadSettings();
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked: settings last for this visit */
  }
};

// ---- start ------------------------------------------------------------------

async function bytes(url: string): Promise<Uint8Array> {
  return new Uint8Array(await (await fetch(url)).arrayBuffer());
}

const ROM_URLS: Record<Model, string> = {
  '48k': rom48Url, tk90x: romTk90xUrl, tk95: romTk95Url, '128k': rom128Url, plus2: romPlus2Url, ts2068: romTs2068Url,
};

/** The name on the case, for the badge. */
const BADGES: Record<Model, string> = {
  '48k': 'ZX Spectrum', tk90x: 'TK 90X', tk95: 'TK 95', '128k': 'ZX Spectrum 128', plus2: 'ZX Spectrum +2',
  ts2068: 'Timex Sinclair 2068',
};

async function start(): Promise<void> {
  const roms = {} as Record<Model, Uint8Array>;
  await Promise.all((Object.keys(ROM_URLS) as Model[]).map(async (m) => { roms[m] = await bytes(ROM_URLS[m]); }));
  const zx = new Spectrum(roms[settings.model], settings.model, SAMPLE_RATE, settings.tkVideo);
  const keys = new KeyInput((held) => { zx.hostKeys = held; });
  keys.onSequence = (chords) => zx.pressKeys(...chords);
  setUpModem(zx);
  const if1Roms: Record<'v2' | 'v1', Uint8Array> = { v2: await bytes(romIf1v2Url), v1: await bytes(romIf1v1Url) };
  /** Plugs the Interface 1 in or out as the setting says (resets the machine). */
  const applyIf1 = () => zx.setInterface1(settings.if1 === 'off' ? null : if1Roms[settings.if1]);
  applyIf1();
  // A snapshot every second, the last 30, to step back through.
  const rewind = new Rewind();
  zx.onFrame = () => rewind.tick(zx);
  const sound = new SoundOut(SAMPLE_RATE);
  const wrap = $('screen-wrap');
  const canvas = $<HTMLCanvasElement>('screen');
  const g = canvas.getContext('2d')!;
  // The TS2068 draws at double width (its 512-pixel mode); the canvas follows.
  let image = g.createImageData(WIDTH, HEIGHT);
  let pixels = new Uint32Array(image.data.buffer);
  const fitCanvas = () => {
    if (canvas.width === zx.ula.width) return;
    canvas.width = zx.ula.width;
    image = g.createImageData(zx.ula.width, HEIGHT);
    pixels = new Uint32Array(image.data.buffer);
  };
  fitCanvas();
  let running = false;

  const draw = () => {
    pixels.set(zx.ula.frame);
    g.putImageData(image, 0, 0);
  };
  const blank = () => {
    g.fillStyle = '#000';
    g.fillRect(0, 0, canvas.width, HEIGHT);
  };
  blank();

  // ---- machine panel -------------------------------------------------------

  const badge = $('badge');
  const tkVideoField = $('tk-video-field');
  const isPal = () => zx.timing.frameT > 60_000;
  const applyModel = () => {
    badge.textContent = BADGES[settings.model];
    document.body.classList.toggle('tk', MODELS[settings.model].tk);
    tkVideoField.hidden = !MODELS[settings.model].tk;
    $('ay48-field').hidden = Boolean(MODELS[settings.model].paged || MODELS[settings.model].timex); // these have their own
    $('if1-field').hidden = Boolean(MODELS[settings.model].timex);
    showDrives();
    document.body.classList.toggle('pal', isPal());
  };
  applyModel();
  const tkVideo = $<HTMLSelectElement>('tk-video');
  tkVideo.value = settings.tkVideo;
  tkVideo.addEventListener('change', () => {
    settings.tkVideo = tkVideo.value as TkVideo;
    save();
    zx.setTkVideo(settings.tkVideo);
    applyModel();
  });
  const model = $<HTMLSelectElement>('model');
  model.value = settings.model;
  model.addEventListener('change', async () => {
    const next = model.value as Model;
    if (running && !(await askConfirm({
      title: `Switch to the ${MODELS[next].label}?`,
      message: 'The machine restarts with the other ROM; whatever is in memory is lost.',
      ok: 'Switch',
    }))) {
      model.value = settings.model;
      return;
    }
    switchModel(next);
  });
  /** Puts another machine on the desk (its ROM, a reset). */
  function switchModel(next: Model): void {
    settings.model = next;
    model.value = next;
    save();
    zx.setRom(roms[next], next);
    applyIf1();
    rewind.clear();
    fitCanvas();
    applyModel();
    drawKeyboard();
  }

  const flags: (keyof Settings)[] = ['smooth', 'scanlines', 'curve', 'flicker', 'humbar'];
  const applyLook = () => {
    for (const f of flags) document.body.classList.toggle(f, Boolean(settings[f]));
    sound.volume = settings.volume / 100;
    zx.fastLoad = settings.fastLoad;
    zx.ay48 = settings.ay48;
  };
  const bindCheck = (id: string, key: keyof Settings) => {
    const box = $<HTMLInputElement>(id);
    box.checked = Boolean(settings[key]);
    box.addEventListener('change', () => {
      (settings[key] as boolean) = box.checked;
      save();
      applyLook();
    });
  };
  for (const f of flags) bindCheck(f, f);
  bindCheck('fast-load', 'fastLoad');
  bindCheck('turbo-tape', 'turboTape');
  bindCheck('auto-power', 'autoPower');
  bindCheck('ay48', 'ay48');
  const volume = $<HTMLInputElement>('volume');
  volume.value = String(settings.volume);
  volume.addEventListener('input', () => { settings.volume = Number(volume.value); save(); applyLook(); });
  const speed = $<HTMLSelectElement>('speed');
  speed.value = String(settings.speed);
  speed.addEventListener('change', () => { settings.speed = Number(speed.value); save(); });
  applyLook();

  $('fullscreen').addEventListener('click', () => {
    const m = document.querySelector('.monitor') as HTMLElement;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void m.requestFullscreen?.();
  });

  // ---- power ---------------------------------------------------------------

  const powerBtn = $('power');
  const lamp = $('power-lamp');
  const showPower = () => {
    powerBtn.setAttribute('aria-pressed', String(running));
    lamp.classList.toggle('on', running);
  };
  const powerOn = async () => {
    audioContext();
    zx.reset();
    rewind.clear();
    await warmUp(wrap, isPal());
    running = true;
    showPower();
  };
  powerBtn.addEventListener('click', async () => {
    if (running) {
      running = false;
      blank();
      showPower();
    } else await powerOn();
  });
  $('reset').addEventListener('click', () => {
    zx.reset();
    rewind.clear();
    if (!running) void powerOn();
  });

  // ---- keyboard ------------------------------------------------------------

  /** Joystick directions from the arrow keys: right, left, down, up, fire. */
  const stick = { right: false, left: false, down: false, up: false, fire: false };
  let padBits = 0;
  const STICK_KEYS: Record<string, keyof typeof stick> = {
    ArrowRight: 'right', ArrowLeft: 'left', ArrowDown: 'down', ArrowUp: 'up', AltRight: 'fire', ControlRight: 'fire',
  };
  const applyStick = () => {
    const bits = (stick.right ? 1 : 0) | (stick.left ? 2 : 0) | (stick.down ? 4 : 0) | (stick.up ? 8 : 0) | (stick.fire ? 16 : 0) | padBits;
    zx.kempston = settings.joystick === 'kempston' ? bits : 0;
    // Without the interface, port 1Fh is the floating bus (games use it to detect one).
    zx.kempstonAttached = settings.joystick === 'kempston';
    const extra: Key[] = [];
    const map = settings.joystick === 'sinclair' ? ['7', '6', '8', '9', '0']
      : settings.joystick === 'cursor' ? ['8', '5', '6', '7', '0'] : null;
    if (map) map.forEach((k, i) => { if (bits & (1 << i)) extra.push(KEYS[k]); });
    keys.extra = extra;
    keys.update();
  };

  const typing = (e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null;
    return Boolean(t?.closest('input, select, textarea, dialog'));
  };
  window.addEventListener('keydown', (e) => {
    if (typing(e) || e.metaKey) return;
    if (HOTKEYS[e.code]) { e.preventDefault(); if (!e.repeat) HOTKEYS[e.code](); return; }
    if (!running) return;
    if (settings.joystick !== 'none' && STICK_KEYS[e.code]) {
      stick[STICK_KEYS[e.code]] = true;
      applyStick();
      e.preventDefault();
      return;
    }
    if (keys.keyDown(e.code, e.key)) e.preventDefault();
  });
  window.addEventListener('keyup', (e) => {
    if (STICK_KEYS[e.code] && settings.joystick !== 'none') {
      stick[STICK_KEYS[e.code]] = false;
      applyStick();
      return;
    }
    keys.keyUp(e.code);
  });
  window.addEventListener('blur', () => {
    keys.releaseAll();
    for (const k of Object.keys(stick) as (keyof typeof stick)[]) stick[k] = false;
    applyStick();
  });
  const joystick = $<HTMLSelectElement>('joystick');
  joystick.value = settings.joystick;
  joystick.addEventListener('change', () => { settings.joystick = joystick.value as Joystick; save(); applyStick(); });
  applyStick();

  // The on-screen keyboard: a tap types the key; CAPS and SYMBOL SHIFT stay
  // down until the next key, so one finger can type shifted keys.
  const latched = new Set<Key>();
  const kbd = $('kbd');
  const drawKeyboard = () => kbd.replaceChildren(...layoutFor(settings.model !== '48k').map((row) => {
    const r = document.createElement('div');
    r.className = 'kbd-row';
    for (const k of row) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'kbd-key';
      b.dataset.key = k.key;
      const main = k.symbol ? `<b>${k.label}</b><span class="sym">${escape(k.symbol)}</span>` : `<b>${k.label}</b>`;
      b.innerHTML = k.label.length > 1
        ? `<span class="above"></span><span class="main"><span class="kw">${k.label}</span></span><span class="below"></span>`
        : `<span class="above">${escape(k.above ?? '')}</span><span class="main">${main}</span><span class="kw">${escape(k.keyword ?? '')}</span><span class="below">${escape(k.below ?? '')}</span>`;
      b.setAttribute('aria-label', k.keyword ? `${k.label} (${k.keyword})` : k.label);
      r.append(b);
    }
    return r;
  }));
  drawKeyboard();
  const showLatched = () => {
    for (const b of kbd.querySelectorAll<HTMLElement>('.kbd-key')) {
      b.classList.toggle('latched', latched.has(KEYS[b.dataset.key!]));
    }
  };
  kbd.addEventListener('pointerdown', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.kbd-key');
    if (!b || !running) return;
    e.preventDefault();
    const k = KEYS[b.dataset.key!];
    if (k === CS || k === SS) {
      if (latched.has(k)) latched.delete(k); else latched.add(k);
      showLatched();
      return;
    }
    zx.pressKeys([...latched, k]);
    latched.clear();
    showLatched();
  });
  const kbdToggle = $('kbd-toggle');
  const showKbd = () => {
    kbd.hidden = !settings.keyboard;
    kbdToggle.setAttribute('aria-expanded', String(settings.keyboard));
  };
  kbdToggle.addEventListener('click', () => { settings.keyboard = !settings.keyboard; save(); showKbd(); });
  showKbd();

  // ---- gamepad -------------------------------------------------------------

  const padNote = $('gamepad');
  const pollPad = () => {
    const pad = navigator.getGamepads?.().find((p) => p);
    if (!pad) {
      if (padBits) { padBits = 0; applyStick(); }
      return;
    }
    padNote.textContent = `Gamepad: ${pad.id.replace(/\(.*\)/, '').trim() || 'connected'}`;
    const b = (i: number) => Boolean(pad.buttons[i]?.pressed);
    const [x = 0, y = 0] = pad.axes;
    const bits = (x > 0.5 || b(15) ? 1 : 0) | (x < -0.5 || b(14) ? 2 : 0) | (y > 0.5 || b(13) ? 4 : 0)
      | (y < -0.5 || b(12) ? 8 : 0) | (b(0) || b(1) || b(2) || b(3) ? 16 : 0);
    if (bits !== padBits) { padBits = bits; applyStick(); }
  };

  // ---- the tape deck and the shelf -----------------------------------------

  const tapeBox = $('tape');
  const tapeLabel = $('tape-label');
  const tapePos = $('tape-pos');
  const tapeNote = $('tape-note');
  /** The bytes the tape in the deck came from (to keep TZX blocks intact). */
  let tapeSource: StoredFile | null = null;
  /** A message under the deck stays 4 s before the tape's own label returns. */
  let noticeUntil = 0;
  const notice = (text: string) => {
    tapeNote.textContent = text;
    noticeUntil = performance.now() + 4000;
  };

  const showTape = () => {
    const t = zx.tape;
    tapeBox.classList.toggle('full', Boolean(t));
    tapeBox.classList.toggle('playing', Boolean(t?.playing));
    tapeLabel.textContent = t ? t.name : 'No tape: click or drop a .tap, .tzx, .z80';
    tapePos.textContent = t ? `${Math.min(t.block + (t.atEnd ? 0 : 1), t.blocks.length)}/${t.blocks.length}` : '';
    const label = t?.blocks[t.block]?.label ?? t?.blocks[t.block - 1]?.label;
    if (performance.now() < noticeUntil) return;
    tapeNote.textContent = t ? (t.modified ? 'Recorded on this tape: download it with ⤓. ' : '') + (label ?? '') : '';
  };

  const storeDeck = () => {
    const t = zx.tape;
    if (!t) return void saveDeck(null);
    const allStandard = t.blocks.every((b) => b.data);
    if (t.modified && allStandard) void saveDeck({ name: t.name.replace(/\.tzx$/i, '.tap'), data: t.toTap() });
    else if (tapeSource) void saveDeck(tapeSource);
  };

  const insertTape = (file: StoredFile, store = true): Tape => {
    const t = parseTape(file.name, file.data);
    zx.tape = t;
    tapeSource = file;
    if (store) storeDeck();
    showTape();
    return t;
  };

  zx.onTapeWritten = () => {
    storeDeck();
    showTape();
  };

  /** Resets and starts the tape: LOAD "" on a 48K, the Tape Loader on a 128K. */
  const typeLoad = () => {
    zx.reset();
    rewind.clear();
    zx.tape?.rewind();
    zx.typeLoad();
    if (!running) void powerOn();
  };

  // ---- the Microdrives (Interface 1) ----------------------------------------

  const mdrFile = $<HTMLInputElement>('mdr-file');
  /** The drive the file picker fills (-1: the first empty one). */
  let mdrTarget = -1;
  const storeDrive = (n: number) => {
    const c = zx.if1?.drives[n].cartridge;
    if (c) c.dirty = false;
    void saveDrive(n, c ? { name: c.fileName, data: c.toMdr() } : null);
  };
  /** Plugs the Interface 1 in (v2) if it is not, so a cartridge has somewhere to go. */
  const ensureIf1 = () => {
    if (zx.if1 || zx.timex) return;
    settings.if1 = 'v2';
    save();
    $<HTMLSelectElement>('if1').value = 'v2';
    applyIf1();
    notice('Interface 1 plugged in for the Microdrive.');
  };
  function insertCartridge(file: StoredFile, drive = mdrTarget): void {
    if (zx.timex) throw new Error('the TS2068 takes no Interface 1');
    const c = Cartridge.fromMdr(file.data);
    c.fileName = file.name;
    ensureIf1();
    const drives = zx.if1!.drives;
    const n = drive >= 0 ? drive : Math.max(0, drives.findIndex((d) => !d.cartridge));
    drives[n].cartridge = c;
    mdrTarget = -1;
    storeDrive(n);
    notice(`${file.name} is in Microdrive ${n + 1}.`);
    showDrives();
  }
  function showDrives(): void {
    // Looked up here: applyModel() calls this before the card's code has run.
    const mdrives = $('mdrives');
    const mdrList = $('mdr-list');
    const drives = zx.if1?.drives;
    mdrives.hidden = !drives;
    if (!drives) return;
    mdrList.replaceChildren(...drives.map((d, n) => {
      const li = document.createElement('li');
      const c = d.cartridge;
      li.className = c ? (d.motor ? 'running' : '') : 'empty';
      const no = document.createElement('span');
      no.className = 'drive-no';
      no.textContent = `M${n + 1}`;
      const btn = (text: string, title: string, cls: string, act: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', act);
        return b;
      };
      if (!c) {
        li.append(no,
          btn('empty', 'Put a cartridge file (.mdr) in this drive', 'shelf-cart', () => { mdrTarget = n; mdrFile.click(); }),
          btn('＋ Blank', 'A new, unformatted cartridge: FORMAT "m";' + (n + 1) + ';"name"', 'shelf-slot', () => {
            d.cartridge = Cartridge.blank();
            d.cartridge.fileName = `blank-m${n + 1}.mdr`;
            storeDrive(n);
            showDrives();
          }));
        return li;
      }
      const name = c.label || '(not formatted)';
      const wp = btn('WP', 'Write protect', 'shelf-slot', () => { c.writeProtect = !c.writeProtect; storeDrive(n); showDrives(); });
      wp.setAttribute('aria-pressed', String(c.writeProtect));
      li.append(no,
        btn(name + (c.modified ? ' *' : ''), c.fileName, 'shelf-cart', () => {}),
        wp,
        btn('⤓', 'Download as .mdr', 'shelf-slot', () => download((c.label || `m${n + 1}`) + '.mdr', c.toMdr())),
        btn('⏏', 'Eject', 'shelf-del', () => { d.cartridge = null; storeDrive(n); showDrives(); }));
      return li;
    }));
  }
  mdrFile.addEventListener('change', async () => {
    const f = mdrFile.files?.[0];
    mdrFile.value = '';
    if (f) await open({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  });
  $<HTMLSelectElement>('if1').value = settings.if1;
  $('if1').addEventListener('change', async () => {
    const sel = $<HTMLSelectElement>('if1');
    const next = sel.value as Settings['if1'];
    if (running && !(await askConfirm({
      title: next === 'off' ? 'Unplug the Interface 1?' : 'Plug in the Interface 1?',
      message: 'The machine restarts; whatever is in memory is lost. Cartridges stay in their drives.',
      ok: next === 'off' ? 'Unplug' : 'Plug in',
    }))) {
      sel.value = settings.if1;
      return;
    }
    settings.if1 = next;
    save();
    applyIf1();
    rewind.clear();
    showDrives();
  });
  // Cartridges kept from last time.
  for (let n = 0; n < 8; n++) {
    const f = await loadDrive(n);
    if (!f || !zx.if1) continue;
    try {
      const c = Cartridge.fromMdr(f.data);
      c.fileName = f.name;
      zx.if1.drives[n].cartridge = c;
    } catch { void saveDrive(n, null); }
  }
  showDrives();

  const shelfList = $('shelf-list');
  const showShelf = async () => {
    const all = await loadShelf();
    shelfList.replaceChildren(...all.map((f) => {
      const li = document.createElement('li');
      if (zx.tape?.name === f.name) li.className = 'inserted';
      const pick = document.createElement('button');
      pick.className = 'shelf-cart';
      pick.type = 'button';
      pick.textContent = f.name;
      pick.title = isSnapshot(f.name) ? 'Load this snapshot' : /\.mdr$/i.test(f.name) ? 'Put this cartridge in a Microdrive' : 'Insert this tape and LOAD it';
      pick.addEventListener('click', () => void open(f, false));
      const del = document.createElement('button');
      del.className = 'shelf-del';
      del.type = 'button';
      del.textContent = '✕';
      del.title = 'Take it off the shelf';
      del.addEventListener('click', async () => {
        if (await askConfirm({ title: `Remove ${f.name}?`, message: 'It is taken off the shelf in this browser.', ok: 'Remove' })) {
          await unshelve(f.name);
          void showShelf();
        }
      });
      li.append(pick, del);
      return li;
    }));
  };

  /** A tape or a snapshot, from a file, a drop, or the shelf. */
  const open = async (file: StoredFile, fromOutside = true) => {
    try {
      if (/\.zip$/i.test(file.name)) {
        const files = unzipSync(file.data);
        const inner = Object.keys(files).find((n) => /\.(tap|tzx|z80|sna|mdr)$/i.test(n));
        if (!inner) throw new Error('no .tap, .tzx, .z80, .sna or .mdr inside this .zip');
        file = { name: inner.split('/').pop()!, data: files[inner] };
      }
      if (file.data.length > MAX_FILE) throw new Error('that file is too big to be a Spectrum tape or snapshot');
      if (/\.mdr$/i.test(file.name)) {
        insertCartridge(file);
      } else if (isSnapshot(file.name)) {
        // A 128K snapshot needs a 128K (and a 48K one a 48K-like machine): switch if it must.
        const kind = snapshotKind(file.name, file.data);
        if (kind && kind !== machineKind(zx)) {
          switchModel(kind === '128k' ? (settings.model === 'plus2' ? 'plus2' : '128k') : kind === 'ts2068' ? 'ts2068' : '48k');
        }
        loadSnapshot(zx, file.name, file.data);
        rewind.clear();
        if (!running) { await warmUp(wrap, isPal()); running = true; showPower(); }
      } else {
        insertTape(file);
        typeLoad();
      }
      if (fromOutside) await shelve(file);
      void showShelf();
    } catch (err) {
      notice(`Could not load ${file.name}: ${(err as Error).message}`);
    }
  };

  const fileInput = $<HTMLInputElement>('tape-file');
  const readFile = async (f: File) => open({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) });
  $('tape-load').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) void readFile(f);
    fileInput.value = '';
  });
  $('tape-run').addEventListener('click', typeLoad);
  $('tape-play').addEventListener('click', () => {
    const t = zx.tape;
    if (!t) return;
    if (t.playing) t.stop(); else zx.playTapeNow();
    showTape();
  });
  $('tape-rewind').addEventListener('click', () => { zx.tape?.rewind(); showTape(); });
  $('tape-eject').addEventListener('click', () => {
    zx.tape = null;
    tapeSource = null;
    void saveDeck(null);
    showTape();
    void showShelf();
  });
  $('tape-blank').addEventListener('click', () => {
    zx.tape = blankTape();
    tapeSource = null;
    showTape();
    notice('A blank tape: SAVE "name" records onto it.');
  });
  $('tape-save').addEventListener('click', () => {
    const t = zx.tape;
    if (!t) return;
    download(t.name.replace(/\.tzx$/i, '.tap'), t.toTap());
  });
  const stamp = () => `k-prompt-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
  $('snap-save').addEventListener('click', () => {
    if (running) download(`${stamp()}.z80`, saveZ80(zx));
  });
  $('snap-sna').addEventListener('click', () => {
    if (!running) return;
    try {
      download(`${stamp()}.sna`, saveSna(zx));
    } catch (err) {
      notice((err as Error).message);
    }
  });

  // Quick save (F2) and load (F3): one slot, in this browser, with the model it was made on.
  const quickSave = async () => {
    if (!running) return;
    await saveQuick({ name: settings.model, data: saveZ80(zx) });
    notice('Quick saved. Quick load (F3) comes back here.');
  };
  const quickLoad = async () => {
    const q = await loadQuick();
    if (!q) { notice('Nothing quick saved yet (F2 saves).'); return; }
    const m = q.name as Model;
    if (m in MODELS && m !== settings.model) switchModel(m);
    try {
      loadSnapshot(zx, 'quick.z80', q.data);
      rewind.clear();
      if (!running) { await warmUp(wrap, isPal()); running = true; showPower(); }
      notice('Back at the quick save.');
    } catch (err) {
      notice(`Could not quick load: ${(err as Error).message}`);
    }
  };
  const rewindBack = () => {
    if (!running) return;
    notice(rewind.back(zx) ? `Rewound; ${rewind.length - 1} more seconds to go back.` : 'Nothing to rewind yet.');
  };
  $('quick-save').addEventListener('click', () => void quickSave());
  $('quick-load').addEventListener('click', () => void quickLoad());
  $('rewind').addEventListener('click', rewindBack);
  const HOTKEYS: Record<string, () => void> = { F2: () => void quickSave(), F3: () => void quickLoad(), F4: rewindBack };

  // Paste a listing: tokenized onto a tape, loaded and run.
  const pasteDialog = $<HTMLDialogElement>('paste-dialog');
  const pasteText = $<HTMLTextAreaElement>('paste-text');
  const pasteError = $('paste-error');
  $('paste-open').addEventListener('click', () => {
    pasteError.textContent = '';
    pasteDialog.showModal();
    pasteText.focus();
  });
  $('paste-run').addEventListener('click', (e) => {
    try {
      const program = tokenize(pasteText.value, zx.paged);
      // Autostart at the first line, as a tape saved with SAVE "name" LINE n.
      const tap = programTape('listing', program, (program[0] << 8) | program[1]);
      insertTape({ name: 'listing.tap', data: tap });
      typeLoad();
    } catch (err) {
      e.preventDefault();
      pasteError.textContent = (err as Error).message;
    }
  });

  // Drag and drop anywhere on the page.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (dragDepth++ === 0) document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth === 0) document.body.classList.remove('dragging'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('dragging');
    const f = e.dataTransfer?.files?.[0];
    if (f) void readFile(f);
  });

  // The built-in programs wait on the shelf from the first visit (and come
  // back if removed), always in their latest version.
  for (const [name, url] of [['TERM.tap', termTapUrl], ['ULA.tap', ulaTapUrl]]) {
    try { await shelve({ name, data: await bytes(url) }); } catch { /* offline */ }
  }

  const deck = await loadDeck();
  if (deck) {
    try { insertTape(deck, false); } catch { void saveDeck(null); }
  }
  showTape();
  void showShelf();

  // ---- the frame loop ------------------------------------------------------

  let last = performance.now();
  let owed = 0;
  let statFrames = 0;
  let statTime = last;
  const fps = $('fps');
  const mhz = $('mhz');
  const carrier = $('carrier');
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    const FRAME_MS = (1000 * zx.timing.frameT) / zx.timing.clock;
    owed += Math.min(now - last, 250);
    last = now;
    if (!running) { owed = 0; return; }
    pollPad();
    let ran = 0;
    // While a tape plays in real time, run as fast as the host allows (no sound).
    const turbo = settings.turboTape && zx.tapePlaying;
    if (turbo) {
      const until = now + 12;
      while (performance.now() < until) { zx.runFrame(); ran++; }
      zx.takeAudio();
      owed = 0;
    } else {
      const most = 4 * settings.speed;
      while (owed >= FRAME_MS / settings.speed && ran < most) {
        owed -= FRAME_MS / settings.speed;
        zx.runFrame();
        const samples = zx.takeAudio();
        if (settings.speed === 1) sound.play(samples);
        ran++;
      }
      if (ran === most) owed = 0; // the host fell behind: do not try to catch up
    }
    if (ran) draw();
    statFrames += ran;
    if (now - statTime >= 1000) {
      const f = (statFrames * 1000) / (now - statTime);
      fps.textContent = `${f.toFixed(0)} / s`;
      mhz.textContent = `${((f * zx.timing.frameT) / 1e6).toFixed(2)} MHz`;
      statFrames = 0;
      statTime = now;
      showTape();
      if (zx.if1) {
        zx.if1.drives.forEach((d, n) => { if (d.cartridge?.dirty) storeDrive(n); });
        showDrives();
      }
    }
    carrier.classList.toggle('on', zx.modem.online);
  };
  requestAnimationFrame(loop);

  // ---- first power-on ------------------------------------------------------

  showPower();
  if (settings.autoPower || sessionStorage.getItem('k-prompt.warm') === '1') {
    await powerOn();
  } else {
    await waitForPower(wrap);
    await powerOn();
  }
}

// ---- the modem ----------------------------------------------------------------

/** A WebSocket call: straight to a board's gateway, or the relay's (which says CONNECT first). */
function wsCall(url: string, protocols: string[], isRelay: boolean, handlers: LinkHandlers): Link {
  let ws: WebSocket;
  try {
    ws = new WebSocket(url, protocols);
  } catch {
    queueMicrotask(() => handlers.onClose());
    return { send: () => {}, close: () => {} };
  }
  ws.binaryType = 'arraybuffer';
  if (!isRelay) ws.onopen = () => handlers.onOpen('DIRECT');
  ws.onmessage = (e: MessageEvent) => {
    if (typeof e.data !== 'string') handlers.onData(new Uint8Array(e.data as ArrayBuffer));
    else if (isRelay && e.data === 'CONNECT') handlers.onOpen();
    else handlers.onData(Uint8Array.from(e.data, (c) => c.charCodeAt(0) & 0xff));
  };
  ws.onclose = () => handlers.onClose();
  return {
    send: (b) => { if (ws.readyState === WebSocket.OPEN) ws.send(b); },
    close: () => ws.close(),
  };
}

/** Through the Worker relay (worker/index.ts) on the same origin. */
function relayCall(host: string, port: number, handlers: LinkHandlers): Link {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return wsCall(`${scheme}://${location.host}/relay?host=${encodeURIComponent(host)}&port=${port}`, [], true, handlers);
}

/**
 * Dials a board's own WebSocket gateway when it has one, so the call comes
 * from the visitor's IP; if that fails before the call is up and the board
 * is in the phone book, it goes through the relay instead.
 */
const dialer: Dialer = (target, handlers) => {
  if (!target.ws) return relayCall(target.host, target.port, handlers);
  let opened = false;
  let closed = false;
  let current: Link = wsCall(target.ws, ['binary'], false, {
    onOpen: (info) => { opened = true; handlers.onOpen(info); },
    onData: (b) => handlers.onData(b),
    onClose: () => {
      if (!opened && !closed && inPhoneBook(target.host, target.port)) current = relayCall(target.host, target.port, handlers);
      else handlers.onClose();
    },
  });
  return {
    send: (b) => current.send(b),
    close: () => { closed = true; current.close(); },
  };
};

function setUpModem(zx: Spectrum): void {
  const modem = zx.modem;
  modem.dialer = withCallSound(dialer, (target) =>
    modem.speaker === 0 ? undefined : startCallSound(`${target.host}:${target.port}`, modem.volume));
  modem.terminalType = () => 'ANSI';
  modem.windowSize = () => [64, 24];
  try {
    const saved = localStorage.getItem(MODEM_PROFILE);
    if (saved) modem.loadProfile(JSON.parse(saved));
  } catch {
    /* no saved profile */
  }
  modem.onSaveProfile = (profile) => {
    try {
      localStorage.setItem(MODEM_PROFILE, JSON.stringify(profile));
    } catch {
      /* storage blocked */
    }
  };
}

function escape(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function download(name: string, data: Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

void start();
