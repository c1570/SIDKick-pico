#ifndef __riscv
#define emulator_trace(par) \
  __asm__ __volatile__ ( \
    ".syntax unified\n\t" \
    "b 1f\n\t" \
    ".word 0xffffabcd\n\t" \
    ".asciz "#par"\n\t" \
    ".balign 4\n\t" \
    "1:\n\t" \
  );
#else
#define emulator_trace(par) \
  __asm__ __volatile__ ( \
    "j 1f\n\t" \
    ".word 0xffffabcd\n\t" \
    ".asciz "#par"\n\t" \
    ".balign 4\n\t" \
    "1:\n\t" \
  );
#endif
