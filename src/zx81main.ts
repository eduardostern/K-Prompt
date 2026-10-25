/**
 * The ZX80/ZX81 page: one machine (src/zx81/machine.ts) on a TV, a tape of
 * .p/.o programs, and the keyboard. The Spectrum page is main.ts.
 */
import './style.css';
import { unzipSync } from 'fflate';
import zx81RomUrl from './roms/zx81.rom?url';
import zx80RomUrl from './roms/zx80.rom?url';
import tk85RomUrl from './roms/tk85.rom?url';
import { FRAME_W, RomName, TapeFile, Zx81, Zx81Model, ZX81_MODELS } from './zx81/machine';
import { keyForCode, keysFor, SPECIAL, ZxKey } from './zx81/keys';
import { waitForPower, warmUp } from './ui/power';

const SETTINGS_KEY = 'k-prompt.zx81';
interface Settings { model: Zx81Model; ram: number }
const settings: Settings = (() => {
  try {
    return { model: 'zx81', ram: 16, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') };
  } catch {
    return { model: 'zx81', ram: 16 };
  }
})();
const save = () => {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* storage blocked */
  }
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Paper and ink on a black-and-white TV. */
const PAPER = 0xffdcdcdc; // ABGR
const INK = 0xff141414;
const NO_SIGNAL = 0xff4a4a4a;
const VIEW_W = 320;
const VIEW_H = 240;

async function start(): Promise<void> {
  const roms: Record<RomName, Uint8Array> = {
    zx81: new Uint8Array(await (await fetch(zx81RomUrl)).arrayBuffer()),
    zx80: new Uint8Array(await (await fetch(zx80RomUrl)).arrayBuffer()),
    tk85: new Uint8Array(await (await fetch(tk85RomUrl)).arrayBuffer()),
  };
  if (!ZX81_MODELS[settings.model]) settings.model = 'zx81';
  let zx = new Zx81(settings.model, roms[ZX81_MODELS[settings.model].rom], settings.ram);
  let running = false;
  const saved: TapeFile[] = [];

  const canvas = $<HTMLCanvasElement>('screen');
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(VIEW_W, VIEW_H);
  const pixels = new Uint32Array(image.data.buffer);
  const wrap = $('screen-wrap');

  /** The picture: 32 pixels of border round the 256×192, where this machine's ROM puts it. */
  const draw = () => {
    const x0 = 84;
    const y0 = zx.info.hz === 50 ? 33 : 9;
    const s = zx.screen;
    for (let y = 0; y < VIEW_H; y++) {
      const row = (y0 + y) * FRAME_W + x0;
      for (let x = 0; x < VIEW_W; x++) {
        const v = s[row + x];
        pixels[y * VIEW_W + x] = v === 1 ? INK : v === 2 ? NO_SIGNAL : PAPER;
      }
    }
    g.putImageData(image, 0, 0);
  };

  // ---- machine and settings -------------------------------------------------

  const modelSel = $<HTMLSelectElement>('model');
  const ramSel = $<HTMLSelectElement>('ram');
  const note = $('model-note');
  const NOTES: Record<Zx81Model, string> = {
    zx81: 'Sinclair, 1981: 1K, 8K ROM, SLOW and FAST. 50 Hz, as in Britain.',
    tk85: 'Microdigital, São Paulo, 1983: a ZX81 with 16K and 2K of extra ROM, 60 Hz (PAL-M).',
    tk82c: 'Microdigital, 1981: the first Brazilian ZX81, 2K, 60 Hz (PAL-M).',
    zx80: 'Sinclair, 1980: 4K ROM, integers only, and a picture only while it waits for a key.',
    tk80: 'Microdigital, 1981: the Brazilian ZX80, 60 Hz (PAL-M).',
  };
  const showModel = () => {
    modelSel.value = settings.model;
    ramSel.value = String(settings.ram);
    note.textContent = NOTES[settings.model];
    $('badge').textContent = ZX81_MODELS[settings.model].label.replace(/ \(.*$/, '').replace('Sinclair ', '');
  };
  const rebuild = () => {
    const tape = zx.tape;
    zx = new Zx81(settings.model, roms[ZX81_MODELS[settings.model].rom], settings.ram);
    zx.tape = tape;
    zx.onSave = onSave;
    save();
    showModel();
    showTape();
  };
  modelSel.addEventListener('change', () => {
    settings.model = modelSel.value as Zx81Model;
    settings.ram = ZX81_MODELS[settings.model].ram === 16 ? 16 : Math.max(settings.ram, ZX81_MODELS[settings.model].ram);
    rebuild();
  });
  ramSel.addEventListener('change', () => { settings.ram = Number(ramSel.value); rebuild(); });
  $('reset').addEventListener('click', () => zx.reset());
  const showPower = () => {
    $('power').setAttribute('aria-pressed', String(running));
    $('power-lamp').classList.toggle('on', running);
  };
  $('power').addEventListener('click', () => {
    running = !running;
    if (running) zx.powerCycle();
    showPower();
  });

  // ---- the tape ------------------------------------------------------------------

  const tapeNote = $('tape-note');
  const showTape = () => {
    const files = zx.tape;
    $('tape').classList.toggle('full', files.length > 0);
    $('tape-label').textContent = files.length
      ? files.map((f) => f.name).join(' · ')
      : 'No tape: click or drop a .p or .o';
    $('tape-pos').textContent = files.length ? `${Math.min(zx.tapePos + 1, files.length)}/${files.length}` : '';
  };
  const onSave = (file: TapeFile) => {
    saved.push(file);
    tapeNote.textContent = `SAVEd ${file.name} (${file.data.length} bytes). ⤓ downloads it.`;
    showTape();
  };
  zx.onSave = onSave;

  /** A program file: .p (ZX81), .p81 (name first, last letter with bit 7 set), .o (ZX80). */
  const readProgram = (name: string, data: Uint8Array): TapeFile => {
    if (/\.p81$|\.81$/i.test(name)) {
      let i = 0;
      while (i < data.length && !(data[i] & 0x80)) i++;
      return { name: name.replace(/\.[^.]*$/, ''), data: data.slice(i + 1) };
    }
    return { name: name.replace(/^.*\//, '').replace(/\.[^.]*$/, ''), data };
  };
  const loadFile = async (file: File) => {
    let data = new Uint8Array(await file.arrayBuffer());
    let name = file.name;
    if (/\.zip$/i.test(name)) {
      const pick = Object.entries(unzipSync(data)).find(([n]) => /\.(p|p81|o|80|81)$/i.test(n));
      if (!pick) { tapeNote.textContent = `No .p or .o in ${file.name}.`; return; }
      [name, data] = pick;
    }
    const prog = readProgram(name, data);
    const isZx80File = /\.(o|80)$/i.test(name);
    if (isZx80File !== zx.info.zx80) {
      tapeNote.textContent = isZx80File
        ? `${prog.name} is a ZX80 program: pick the ZX80 or TK80.`
        : `${prog.name} is a ZX81 program: pick the ZX81, TK85 or TK82C.`;
    } else {
      tapeNote.textContent = `${prog.name} is on the tape. ▶ LOAD types the command.`;
    }
    zx.tape.push(prog);
    showTape();
  };
  const tapeFile = $<HTMLInputElement>('tape-file');
  $('tape-load').addEventListener('click', () => tapeFile.click());
  tapeFile.addEventListener('change', () => {
    const f = tapeFile.files?.[0];
    tapeFile.value = '';
    if (f) void loadFile(f);
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if (f) void loadFile(f);
  });
  $('tape-eject').addEventListener('click', () => { zx.tape = []; zx.tapePos = 0; showTape(); });
  $('tape-run').addEventListener('click', () => {
    if (!running) return;
    // ZX81: LOAD is J, then "" (SHIFT+P twice). ZX80: LOAD is W.
    const seq: ZxKey[] = zx.info.zx80
      ? [keysFor('W')!, keysFor('\n')!]
      : [keysFor('J')!, keysFor('"')!, keysFor('"')!, keysFor('\n')!];
    zx.pressKeys(seq);
  });
  $('tape-save').addEventListener('click', () => {
    const last = saved[saved.length - 1];
    if (!last) { tapeNote.textContent = 'Nothing SAVEd yet: SAVE "NAME" (ZX81) or SAVE (ZX80).'; return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([last.data.slice()], { type: 'application/octet-stream' }));
    a.download = `${last.name}.${zx.info.zx80 ? 'o' : 'p'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---- keys --------------------------------------------------------------------

  const typing = (e: Event) => (e.target as Partial<Element> | null)?.closest?.('input, select, textarea, dialog');
  /** Keys held, by PC code, with the matrix keys they press. */
  const held = new Map<string, ZxKey>();
  window.addEventListener('keydown', (e) => {
    if (!running || typing(e) || e.metaKey || e.ctrlKey) return;
    if (e.repeat) { e.preventDefault(); return; }
    // A symbol the PC key types (shifted on the ZX81): SHIFT and its key.
    const sym = e.key.length === 1 && !/[a-z0-9 .]/i.test(e.key) ? keysFor(e.key, zx.info.zx80) : undefined;
    const k = SPECIAL[e.key] ?? sym ?? keyForCode(e.code);
    if (!k) return;
    e.preventDefault();
    if (k.shift) zx.key(0, 0, true);
    zx.key(k.row, k.bit, true);
    held.set(e.code, k);
  });
  window.addEventListener('keyup', (e) => {
    const k = held.get(e.code);
    if (!k) return;
    held.delete(e.code);
    zx.key(k.row, k.bit, false);
    if (k.shift) zx.key(0, 0, false);
    // SHIFT itself held on the PC stays down.
    if (held.has('ShiftLeft') || held.has('ShiftRight')) zx.key(0, 0, true);
  });
  window.addEventListener('blur', () => { held.clear(); zx.keys.fill(0x1f); });

  // ---- the frame loop ---------------------------------------------------------------

  const fps = $('fps');
  let last = performance.now();
  let owed = 0;
  let frames0 = 0;
  let statTime = last;
  const loop = (now: number) => {
    requestAnimationFrame(loop);
    if (!running) return;
    const frameMs = 1000 / zx.info.hz;
    owed = Math.min(owed + now - last, 250);
    last = now;
    let ran = 0;
    while (owed >= frameMs && ran < 4) {
      zx.runFrame();
      owed -= frameMs;
      ran++;
    }
    if (ran) {
      draw();
      showTape();
    }
    if (now - statTime >= 1000) {
      fps.textContent = `${Math.round(((zx.frames - frames0) * 1000) / (now - statTime))} / s`;
      frames0 = zx.frames;
      statTime = now;
    }
  };
  requestAnimationFrame((t) => { last = t; loop(t); });

  showModel();
  showTape();
  await waitForPower(wrap);
  zx.powerCycle();
  await warmUp(wrap, zx.info.hz === 50);
  running = true;
  showPower();
}

void start();
