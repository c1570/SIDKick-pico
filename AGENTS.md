# AGENTS.md

## Project

SIDKick pico ("SKpico") is a bare-metal RP2040/RP2350 firmware that acts as a drop-in
replacement for the SID 6581/8580 sound chip in the Commodore 64/128 (and Ultimate 64).
It emulates dual-SID and/or SID+FM via an extended version of reSID 0.16 (in `Source/reSID16/`)
plus fmopl. Firmware is built with the Raspberry Pi Pico SDK and flashed as a `.uf2`.

## Build

CMake project using the Raspberry Pi Pico SDK; the SDK and pico-extras are fetched
automatically (requires `PICO_EXTRAS_FETCH_FROM_GIT=ON`). The toolchain is
`arm-none-eabi-gcc`. Output is an ELF plus `.uf2` (produced by `pico_add_extra_outputs`),
configured to copy code to RAM (`PICO_COPY_TO_RAM=1`).

The firmware builds for two MCU families, and the RP2350 has two board variants. The
correct linker script (`memmap_copy_to_ram_skpico.ld` for RP2040,
`memmap_copy_to_ram_2350.ld` for RP2350) and board-specific C define are selected via the
options below.

There is no dedicated lint or typecheck command. The target is `SKpico`.

### Configure options

| Option | Values | Purpose |
|---|---|---|
| `PICO_PLATFORM` | `rp2040` (default), `rp2350-arm-s` | MCU family. |
| `PICO_BOARD` | `pico`, `pico2` | Board headers used by the SDK. |
| `SKPICO_VARIANT` | (empty), `SKPICO_2350CR`, `SKPICO_2350` | Board define baked into the firmware. Required for RP2350: `SKPICO_2350CR` for the SKpico2350CR board, `SKPICO_2350` for the SKpico2350DAC/2350PWM boards (these also init the DCDC PSM pin). |
| `PICO_EXTRAS_FETCH_FROM_GIT` | `ON` | Required — pico-extras is not vendored (provides `pico_audio_i2s`). |

### RP2040 (interface board / tiny RP2040)

```sh
cd Source
cmake -B build -DPICO_EXTRAS_FETCH_FROM_GIT=ON
cmake --build build -j$(nproc)
```

### RP2350 (SKpico2350CR)

```sh
cd Source
cmake -B build-2350 -DPICO_PLATFORM=rp2350-arm-s -DPICO_BOARD=pico2 \
  -DPICO_EXTRAS_FETCH_FROM_GIT=ON -DSKPICO_VARIANT=SKPICO_2350CR
cmake --build build-2350 -j$(nproc)
```

### RP2350 (SKpico2350DAC / SKpico2350PWM)

```sh
cd Source
cmake -B build-2350 -DPICO_PLATFORM=rp2350-arm-s -DPICO_BOARD=pico2 \
  -DPICO_EXTRAS_FETCH_FROM_GIT=ON -DSKPICO_VARIANT=SKPICO_2350
cmake --build build-2350 -j$(nproc)
```

Artifacts land in the build directory as `SKpico.elf`, `SKpico.bin`, and `SKpico.uf2`.
Flash the `.uf2` by copying it to the Pico USB mass-storage device while in BOOTSEL mode.

## Languages and standards

- C11 (`.c`), C++17 (`.cc`), and inline ASM/PIO (`.pio`).
- Hard real-time audio path: core 1 runs the emulation loop; `SKpico.c` is compiled with
  aggressive GCC pragmas (`Ofast`, etc.) at the top of the file — preserve these when editing.

## Code layout

- `Source/SKpico.c` — main entry point: bus interfacing, audio/PWM/DAC output, config menu,
  paddle/mouse handling, PRG launcher, digi-detect heuristics.
- `Source/reSIDWrapper.cc` / `.h` — bridge between the C firmware and the reSID16 engine.
- `Source/reSID16/` — extended reSID 0.16 (third-party; see its own `AUTHORS`/`COPYING`).
  Prefer minimal, surgical changes here.
- `Source/fmopl.c` / `.h` — FM (OPL) emulation.
- `Source/exodecr.c` / `.h` — Exomizer decompressor (for embedded PRGs).
- `Source/prgslots.cc` / `.h`, `prgconfig.h`, `prg.h` — embedded PRG launcher/configuration.
- `Source/filterLUTs.h`, `reSID_LUT.h` — precomputed SID filter/wave lookup tables.
- `Source/ws2812.pio` — PIO program driving the WS2812 RGB LED.
- `Source/launch.h` — startup/launch helpers.

## Conventions

- Preserve the per-file GPL header comments and the GCC optimization pragmas.
- Embedded/bare-metal: no `malloc` panics, no exceptions, no stdio UART
  (see compile definitions in `Source/CMakeLists.txt`). Avoid heavy stack use
  (`PICO_STACK_SIZE=0x100`).
- `Source/reSID16/` and `fmopl` are derived from upstream projects; keep changes minimal and
  note that the firmware may be ported between RP2040 and RP2350 targets.

## License

Source code is GPLv3 (the PCBs are CC BY-NC-ND 4.0; see `README.md`).
