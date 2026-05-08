VAKKA_ROOT := $(shell cd .. && pwd)
DIST := $(VAKKA_ROOT)/dist
FRIDA := $(VAKKA_ROOT)/vendor/frida-gum

CFLAGS := -O2 -Wall -Wextra -Wno-unused-parameter -fPIC
LDFLAGS := -dynamiclib

.PHONY: all probe audit clean

all: probe audit

probe: $(DIST)/libvakka-probe.dylib

audit: $(DIST)/libvakka-audit.dylib

$(DIST)/libvakka-probe.dylib: probe.c | $(DIST)
	cc $(CFLAGS) $(LDFLAGS) -o $@ $<

$(DIST)/libvakka-audit.dylib: audit.c | $(DIST)
	cc $(CFLAGS) $(LDFLAGS) -o $@ $<

$(DIST):
	mkdir -p $(DIST)

clean:
	rm -f $(DIST)/libvakka-probe.dylib $(DIST)/libvakka-audit.dylib
