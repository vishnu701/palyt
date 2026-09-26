// The AudioWorklet cannot run in happy-dom, but its resampler is plain JS: define the worklet
// globals, import the file, feed 48 kHz float audio and check the wire format (640 × int16 =
// 1280 bytes per 40 ms frame, padded tail on stop, stop acknowledged).
import { test, expect } from "bun:test";

let Registered: any = null;
(globalThis as any).sampleRate = 48000;
(globalThis as any).AudioWorkletProcessor = class { port = { onmessage: null as any, posted: [] as any[], postMessage(m: any) { this.posted.push(m); } }; };
(globalThis as any).registerProcessor = (_name: string, cls: any) => { Registered = cls; };
await import("../../public/audio-worklet.js");

test("48 kHz float → 16 kHz s16le 1280-byte frames, tail padded, stop acked", () => {
  expect(Registered).not.toBeNull();
  const w = new Registered();
  const posted = w.port.posted as any[];
  // 128-sample render quanta of a 440 Hz sine at 48 kHz, 100 quanta = 12800 samples = 266.7 ms
  const quantum = (offset: number) => { const a = new Float32Array(128); for (let i = 0; i < 128; i++) a[i] = 0.5 * Math.sin(2 * Math.PI * 440 * (offset + i) / 48000); return [[a]]; };
  for (let q = 0; q < 10; q++) w.process(quantum(q * 128));
  expect(posted.length).toBe(0); // inactive until start
  w.port.onmessage({ data: { cmd: "start" } });
  for (let q = 0; q < 100; q++) w.process(quantum(q * 128));
  // 12800 / 3 = 4266 samples at 16 kHz → 6 full frames of 640
  const frames = posted.filter((m) => m.pcm);
  expect(frames.length).toBe(6);
  for (const f of frames) {
    expect(f.pcm.byteLength).toBe(1280);
    expect(f.level).toBeGreaterThan(0.2);
    expect(f.level).toBeLessThan(0.5);
  }
  const s = new Int16Array(frames[1].pcm);
  expect(Math.max(...Array.from(s))).toBeGreaterThan(12000); // ~0.5 amplitude survived
  expect(Math.min(...Array.from(s))).toBeLessThan(-12000);
  w.port.onmessage({ data: { cmd: "stop" } });
  const after = posted.slice(frames.length);
  expect(after.length).toBe(2);
  expect(after[0].pcm.byteLength).toBe(1280); // padded tail (4266 − 3840 = 426 samples + zeros)
  expect(new Int16Array(after[0].pcm).slice(600).every((v) => v === 0)).toBe(true);
  expect(after[1]).toEqual({ stopped: true });
  w.process(quantum(0));
  expect(posted.length).toBe(frames.length + 2); // nothing after stop
});

test("44.1 kHz input also yields exact 640-sample frames", () => {
  (globalThis as any).sampleRate = 44100;
  const w = new Registered();
  w.port.onmessage({ data: { cmd: "start" } });
  const a = new Float32Array(128).fill(0.1);
  for (let q = 0; q < 200; q++) w.process([[a]]); // 25600 samples → 9288 at 16 kHz → 14 frames
  const frames = w.port.posted.filter((m: any) => m.pcm);
  expect(frames.length).toBe(14);
  expect(frames.every((f: any) => f.pcm.byteLength === 1280)).toBe(true);
  expect(new Int16Array(frames[3].pcm)[100]).toBeCloseTo(0.1 * 0x7fff, -2);
});
