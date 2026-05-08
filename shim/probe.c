#include <stdio.h>
#include <unistd.h>

__attribute__((constructor))
static void vakka_probe_init(void) {
  write(2, "VAKKA_SHIM_PROBE_LOADED\n", 24);
}
