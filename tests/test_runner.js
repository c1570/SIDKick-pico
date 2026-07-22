#!/usr/bin/env node

const MAX_CYCLES = -1;
const DEBUG = 0;
const RP_MHZ = 300;

import { RP2350, USBCDC, GPIOPinState } from 'rp2350js';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// Polyfill __dirname for ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FIRMWARE_PATH = process.env.FIRMWARE
  ? path.resolve(process.env.FIRMWARE)
  : `${__dirname}/../Source/build-2350/SKpico.uf2`;

console.log('Initializing RP2350...');
const mcu = new RP2350({ coreArch: 'arm', loadFirmware: FIRMWARE_PATH });

// Set up UART output
mcu.uart[0].onByte = (value) => {
  process.stdout.write(new Uint8Array([value]));
};
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.on('data', (chunk) => {
  // 24 is Ctrl+X, 3 is Ctrl-C
  if (chunk[0] === 24 || chunk[0] === 3) {
    process.exit(0);
  }
  for (const byte of chunk) {
    // console.log(`key in: ${byte}`);
    mcu.uart[0].feedByte(byte);
  }
});

const REPLAY_ARM_RP_CYCLE = 5000000;    // rp cycle at which firmware is "ready" and replay starts

function getOffsetForVariable(var_name) {
  // allows reading variables from RP2 RAM:
  // const variable_offset = getOffsetForVariable(".sbss.SOME_VARIABLE_NAME");
  // const variable_value = mcu.readUint32(variable_offset);
  const filename = FIRMWARE_PATH.replace(".uf2", ".elf.map");
  const content = fs.readFileSync(filename, 'utf-8');
  const search = var_name.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
  const re = new RegExp(search + ".*\n *(0x[0-9a-f]+) ");
  const res = re.exec(content);
  if(res == null) throw new Error(`Could not find offset of variable ${var_name} in map file ${filename}`);
  return parseInt(res[1]);
}

// D0..7 GPIO0..7
// A0..4 GPIO16..20
// A5 14
// A8 15
// OE 8
// RW 9
// PHI 12
// AUDIO 13
// SID_ENABLE 21
// RESET 22
// LED 25

for(let i = 0; i <= 25; i++) {
  mcu.gpio[i].setInputValue(true);
}

// --- read SID data from gyruss1.csv -------------------------------------
// format: c64cycle,sid_addr_4digit_hex,data_2digit_hex,ignore_rest_of_line
function loadSidCsv(filename) {
  const text = fs.readFileSync(filename, 'utf-8');
  const writes = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(',');
    const cycle = parseInt(cols[0], 10);
    const addr = parseInt(cols[1], 16);    // e.g. "d418" -> 0xd418
    const data = parseInt(cols[2], 16);    // e.g. "0f"   -> 0x0f
    if (!Number.isFinite(cycle) || !Number.isFinite(addr) || !Number.isFinite(data)) continue;
    writes.push({
      cycle,
      reg: addr & 0x1f,     // SID register index (A0..A4)
      value: data & 0xff,
    });
  }
  writes.sort((a, b) => a.cycle - b.cycle);
  return writes;
}

const SID_WRITES = loadSidCsv(`${__dirname}/gyruss1.csv`);
let sidWriteIdx = 0;       // next unconsumed entry in SID_WRITES
let pendingWrite = null;   // write scheduled for the current C64 cycle, if any
let prevC64Cycle = -1;
let replayStartCycle = null;   // absolute C64 cycle at which replay begins
let lastWriteProcessedCycle = null;  // C64 cycle at which the final CSV write was pulled
const FIRST_CSV_CYCLE = SID_WRITES.length ? SID_WRITES[0].cycle : 0;
const POST_CSV_TAIL_CYCLES = 500000; // keep emulating this long after the last CSV write
const RESET_RELEASE_CYCLE = 1000;
console.log(`Loaded ${SID_WRITES.length} SID writes from gyruss1.csv` +
  (SID_WRITES.length ? ` (first @cycle ${FIRST_CSV_CYCLE}, last @cycle ${SID_WRITES[SID_WRITES.length - 1].cycle})` : ''));

// --- open WAV output file -----------------------------------------------
// Mono 16-bit PCM @ 44100 Hz. We sample the firmware's `newSample` global
// (0..AUDIO_VALS, bias AUDIO_VALS/2) which the getOffsetForVariable trick
// exposes each emulator step, and resample to the WAV rate.
const SAMPLE_RATE_HZ = 44100;
const AUDIO_VALS = 2834;            // see Source/SKpico.c
const AUDIO_BIAS = AUDIO_VALS >> 1; // centre of the PWM range
const NEW_SAMPLE_ADDR = getOffsetForVariable('newSample');

class WavWriter {
  constructor(filename, sampleRate) {
    this.fd = fs.openSync(filename, 'w');
    this.sampleRate = sampleRate;
    this.bytesWritten = 0;
    // Write a placeholder 44-byte header; patched on close().
    this.header = Buffer.alloc(44);
    this.header.write('RIFF', 0);
    this.header.writeUInt32LE(0, 4);          // file size - 8, patched later
    this.header.write('WAVE', 8);
    this.header.write('fmt ', 12);
    this.header.writeUInt32LE(16, 16);        // PCM fmt chunk size
    this.header.writeUInt16LE(1, 20);         // PCM
    this.header.writeUInt16LE(1, 22);         // mono
    this.header.writeUInt32LE(this.sampleRate, 24);
    this.header.writeUInt32LE(this.sampleRate * 2, 28); // byte rate
    this.header.writeUInt16LE(2, 32);         // block align
    this.header.writeUInt16LE(16, 34);        // bits per sample
    this.header.write('data', 36);
    this.header.writeUInt32LE(0, 40);         // data size, patched later
    fs.writeSync(this.fd, this.header, 0, 44, null);
    this.closed = false;
  }

  // value is an unsigned 0..AUDIO_VALS sample; converted to signed int16.
  writeSample(value) {
    if (this.closed) return;
    let s = Math.round(((value - AUDIO_BIAS) * 32767) / AUDIO_BIAS);
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    const buf = Buffer.allocUnsafe(2);
    buf.writeInt16LE(s, 0);
    fs.writeSync(this.fd, buf, 0, 2, null);
    this.bytesWritten += 2;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    // Patch the RIFF and data chunk sizes now that we know them.
    this.header.writeUInt32LE(36 + this.bytesWritten, 4);
    this.header.writeUInt32LE(this.bytesWritten, 40);
    fs.writeSync(this.fd, this.header, 0, 44, 0);
    fs.closeSync(this.fd);
  }
}

const WAV_PATH = process.env.WAV_OUT || `${__dirname}/output.wav`;
const wav = new WavWriter(WAV_PATH, SAMPLE_RATE_HZ);

function shutdown(reason) {
  console.log(`\n${reason}: finalizing WAV "${WAV_PATH}" (${wav.bytesWritten} data bytes)`);
  wav.close();
  console.log(`Emulation stopped after ${mcu.cycles} rp cycles and ${c64CycleCount} 6510 cycles`);
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('exit', () => wav.close());

console.log(`Writing audio to ${WAV_PATH} (sampling firmware "newSample" @ 0x${NEW_SAMPLE_ADDR.toString(16)})`);

// --- audio resampling state --------------------------------------------
// newSample is a "fire-and-forget" value: the firmware sets it then clears it
// to 0xffff once consumed. We poll it every emulator step, hold the last
// valid value, and emit the held value at the WAV sample rate.
let lastAudioSample = AUDIO_BIAS;
const RP_CYCLES_PER_SAMPLE = (RP_MHZ * 1e6) / SAMPLE_RATE_HZ;
let nextWavCycle = 0;
let samplesWritten = 0;

// Main emulation loop
console.log('Starting emulation...');
console.log('Press Ctrl+C/Ctrl+X to stop');

let nextTimeUpdate = 0;
let prevClockState = false;
let c64CycleCount = 0;

function runEmulation() {
  let j = 0;
  const base6510CycleCount = c64CycleCount;
  while (j < 500*304) {
    // Step the RP2
    let rpStartCycles = mcu.cycles;
    mcu.step();
    let rpCyclesElapsed = mcu.cycles - rpStartCycles;
    j += rpCyclesElapsed;

    let c64CycleNs = ((j % 304) / 304) * 1000; // just use 1MHz here (instead of 985kHz)
    c64CycleCount = base6510CycleCount + 1 + Math.floor(j / 304);

    // Reflect the firmware's own output pins back as inputs (so the chip
    // observes what it drives). Only true outputs: OE/AUDIO/LED.
    mcu.gpio[8].setInputValue(mcu.gpio[8].value != 0);
    mcu.gpio[13].setInputValue(mcu.gpio[13].value != 0);
    mcu.gpio[25].setInputValue(mcu.gpio[25].value != 0);

    const phiHigh = c64CycleNs < 500;
    mcu.gpio[12].setInputValue(phiHigh);              // Phi2 (high=CPU halfcycle)
    mcu.gpio[22].setInputValue(c64CycleCount > RESET_RELEASE_CYCLE);

    if (c64CycleCount !== prevC64Cycle) {
      prevC64Cycle = c64CycleCount;
      pendingWrite = null;
      // Arm the replay once the firmware has booted and settled.
      if (replayStartCycle === null && mcu.cycles >= REPLAY_ARM_RP_CYCLE) {
        replayStartCycle = c64CycleCount;
        console.log(`>>> CSV replay armed at C64 cycle ${replayStartCycle} (rp cycle ${mcu.cycles})`);
      }
      if (replayStartCycle !== null) {
        const localCycle = c64CycleCount - replayStartCycle;
        while (sidWriteIdx < SID_WRITES.length &&
               (SID_WRITES[sidWriteIdx].cycle - FIRST_CSV_CYCLE) <= localCycle) {
          pendingWrite = SID_WRITES[sidWriteIdx++];
        }
        // Record the C64 cycle at which the final CSV write was pulled, so
        // we can keep emulating POST_CSV_TAIL_CYCLES afterwards (lets
        // envelopes/release tails and the AA filter ring out).
        if (lastWriteProcessedCycle === null && sidWriteIdx === SID_WRITES.length) {
          lastWriteProcessedCycle = c64CycleCount;
          console.log(`>>> Last CSV write processed at C64 cycle ${lastWriteProcessedCycle}; stopping in ${POST_CSV_TAIL_CYCLES} cycles`);
        }
      }
    }

    // Stop emulation once we've run POST_CSV_TAIL_CYCLES past the last write.
    if (lastWriteProcessedCycle !== null &&
        c64CycleCount >= lastWriteProcessedCycle + POST_CSV_TAIL_CYCLES) {
      shutdown(`Tail of ${POST_CSV_TAIL_CYCLES} C64 cycles after last CSV write`);
    }

    // C64 bus phase timing within this cycle (see TODOs):
    //  ~40ns : set address + RW (write) + SID_ENABLE (active low)
    //  ~80ns : set data (if write)
    //  ~500ns: deactivate SID_ENABLE + RW (Phi2 falls -> VIC halfcycle)
    if (pendingWrite && phiHigh && c64CycleNs >= 40) {
      const reg = pendingWrite.reg;
      for (let bit = 0; bit < 5; bit++) {
        mcu.gpio[16 + bit].setInputValue(((reg >> bit) & 1) !== 0); // A0..A4
      }
      mcu.gpio[14].setInputValue(true);  // A5 high (no 2nd SID)
      mcu.gpio[15].setInputValue(true);  // A8 high (no 2nd SID)
      mcu.gpio[9].setInputValue(false);  // RW low = write
      mcu.gpio[21].setInputValue(false); // SID_ENABLE low = addressing SID

      if (c64CycleNs >= 80) {
        const val = pendingWrite.value;
        for (let bit = 0; bit < 8; bit++) {
          mcu.gpio[bit].setInputValue(((val >> bit) & 1) !== 0);    // D0..D7
        }
      }
    } else {
      // idle / VIC halfcycle: release the bus
      mcu.gpio[9].setInputValue(true);   // RW high = read
      mcu.gpio[21].setInputValue(true);  // SID_ENABLE high = inactive
    }

    // --- capture audio: poll newSample, resample to WAV rate -------------
    const raw = mcu.readUint32(NEW_SAMPLE_ADDR) >>> 0;
    if (raw < 0xfffe) {                  // 0xfffe/0xffff are "no sample" sentinels
      lastAudioSample = raw;
    }
    while (mcu.cycles >= nextWavCycle) {
      wav.writeSample(lastAudioSample);
      samplesWritten++;
      nextWavCycle += RP_CYCLES_PER_SAMPLE;
    }

    if (mcu.cycles > nextTimeUpdate) {
      const time = mcu.cycles / (RP_MHZ * 1000000);
      const wavSec = samplesWritten / SAMPLE_RATE_HZ;
      const csvLeft = SID_WRITES.length - sidWriteIdx;
      const phase = lastWriteProcessedCycle !== null
        ? `tail (${Math.max(0, lastWriteProcessedCycle + POST_CSV_TAIL_CYCLES - c64CycleCount)} C64 cycles left)`
        : replayStartCycle !== null
          ? `replaying (cycle ${c64CycleCount - replayStartCycle} of CSV)`
          : `arming (rp ${mcu.cycles}/${REPLAY_ARM_RP_CYCLE})`;
      console.log(`\nTime: ${time.toFixed(1)}s, rpCycleCount: ${mcu.cycles}, 6510 Cycles: ${c64CycleCount}` +
        `, WAV: ${wavSec.toFixed(2)}s (${samplesWritten} samples), ${phase}, SID writes left: ${csvLeft}\n`);
      nextTimeUpdate += 40000000;
    }
  }
  if (MAX_CYCLES < 0 || mcu.cycles < MAX_CYCLES) {
    setTimeout(runEmulation);
  } else {
    shutdown('MAX_CYCLES reached');
  }
}

// have to use setTimeout as otherwise the keyboard callback never gets called
setTimeout(runEmulation);
