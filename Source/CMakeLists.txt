cmake_minimum_required(VERSION 3.13)

set(PICO_SDK_FETCH_FROM_GIT on)
set(PICO_EXTRAS_FETCH_FROM_GIT on)

include(pico_sdk_import.cmake)
include(pico_extras_import.cmake)

project(SKpico C CXX ASM)
set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)

project(SKpico)

set(PICO_COPY_TO_RAM 1)

pico_sdk_init()

add_compile_definitions(PICO_NO_FPGA_CHECK=1)
add_compile_definitions(PICO_BARE_METAL=1)
add_compile_definitions(PICO_CXX_ENABLE_EXCEPTIONS=0)
add_compile_definitions(PICO_STDIO_UART=0)

add_executable(SKpico
    SKpico.c
    exodecr.c
    fmopl.c
    reSID16/envelope.cc
    reSID16/extfilt.cc
    reSID16/pot.cc
    reSID16/filter.cc
    reSID16/sid.cc
    reSID16/voice.cc
    reSID16/wave.cc
    reSIDWrapper.cc
    prgslots.cc
)

target_compile_definitions(SKpico PUBLIC  PICO PICO_STACK_SIZE=0x100)
target_compile_definitions(SKpico PRIVATE PICO_MALLOC_PANIC=0)
target_compile_definitions(SKpico PRIVATE PICO_USE_MALLOC_MUTEX=0)
target_compile_definitions(SKpico PRIVATE PICO_DEBUG_MALLOC=0)
target_compile_options(SKpico PRIVATE -save-temps -fverbose-asm)

# Select the SKpico board variant via -DSKPICO_VARIANT=SKPICO_2350CR | SKPICO_2350 (leave empty for RP2040)
set(SKPICO_VARIANT "" CACHE STRING "SKpico board define: SKPICO_2350CR or SKPICO_2350")
if(SKPICO_VARIANT)
    target_compile_definitions(SKpico PRIVATE ${SKPICO_VARIANT})
endif()

if(PICO_PLATFORM STREQUAL "rp2350-arm-s" OR PICO_PLATFORM STREQUAL "rp2350-riscv" OR PICO_PLATFORM STREQUAL "rp2350")
    set(SKpico_LINKER_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/memmap_copy_to_ram_2350.ld)
else()
    set(SKpico_LINKER_SCRIPT ${CMAKE_CURRENT_LIST_DIR}/memmap_copy_to_ram_skpico.ld)
endif()
set_target_properties(SKpico PROPERTIES PICO_TARGET_LINKER_SCRIPT ${SKpico_LINKER_SCRIPT})

target_link_libraries(SKpico pico_stdlib pico_multicore hardware_dma hardware_interp hardware_pwm pico_audio_i2s hardware_flash hardware_adc)

pico_set_program_name(SKpico "SKpico")
pico_set_program_version(SKpico "0.1")

# create map/bin/hex/uf2 file in addition to ELF.
pico_add_extra_outputs(SKpico)

